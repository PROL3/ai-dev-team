import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import { executeTask } from "../../src/agents/implementation/execute-task.js";
import {
  WorkspaceManager,
  type TaskWorkspace,
} from "../../src/infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../../src/infrastructure/git/integration-manager.js";
import {
  WorkflowStore,
  CheckpointError,
  defaultCheckpointPath,
} from "../../src/infrastructure/persistence/workflow-store.js";
import { checkpointGit } from "../../src/infrastructure/git/checkpoint-git.js";
import { recoverWorktree } from "../../src/infrastructure/git/recover-worktree.js";
import { parseWorkflowArguments } from "../../src/cli/arguments.js";
import type { ProjectPlan } from "../../src/domain/plan.js";
import type {
  AgentResult,
  AgentExecutionContext,
} from "../../src/agents/implementation/execute-task.js";
import type { ScheduledTask } from "../../src/domain/scheduler.js";

const plan: ProjectPlan = {
  goal: "Resume a feature",
  tasks: [
    {
      id: "feature",
      title: "Feature",
      description: "Write feature.txt",
      owner: "backend",
      dependencies: [],
      files: ["feature.txt"],
    },
  ],
};
const pass = {
  passed: true,
  summary: "Validated",
  testsRun: ["fixture check"],
  failures: [],
  warnings: [],
  changedFiles: ["feature.txt"],
  suggestedFixes: [],
};
const stopped = () => new CheckpointError("Simulated interruption");

test("resumed implementation failures retain a structured task log before retry", async (t) => {
  const { root, checkpointPath } = await fixture(t);
  await assert.rejects(
    new Orchestrator(plan, {
      projectRoot: root,
      checkpointPath,
      enableTester: false,
      executeAgent: async () => {
        throw stopped();
      },
    }).runUntilComplete(),
    /Simulated interruption/,
  );
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async (task) => ({
      taskId: task.id,
      owner: task.owner,
      success: false,
      output: "Validation failed",
      error: "Validation failed",
      failureType: "validation",
      changedFiles: [],
    }),
  });
  await assert.rejects(resumed.runUntilComplete(), /permanently failed/);
  const taskLogs = logs
    .filter((line) => line.startsWith("[task-log] "))
    .map((line) => JSON.parse(line.slice("[task-log] ".length)));
  assert.equal(taskLogs[0].taskId, "feature");
  assert.equal(taskLogs[0].attempt, 1);
  assert.equal(taskLogs[0].error, "Validation failed");
  assert.equal(taskLogs[0].finalStatus, "pending");
  assert.equal(taskLogs.at(-1).finalStatus, "failed");
});

test("explicit failed retry recovers an orphaned workspace and preserves progress and counters", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    executeAgent: async (task, context) => ({
      ...(await implementation(task, context)),
      success: false,
      error: "Fix the feature",
      failureType: "validation",
    }),
  });
  await assert.rejects(first.runUntilComplete(), /permanently failed/);
  const saved = await store.load();
  const record = saved.tasks[0]!;
  const original = record.task.workspacePath!;
  // Simulate lost Git registration while retaining the original working files.
  const gitFile = await fs.readFile(path.join(original, ".git"), "utf8");
  const metadata = gitFile.trim().slice("gitdir: ".length);
  await fs.unlink(path.join(original, ".git"));
  await fs.rm(metadata, { recursive: true, force: true });
  const resumed = await Orchestrator.resume(root, {
    retryFailed: true,
    executeAgent: async (task, context) => {
      assert.equal(task.attempts, record.task.attempts + 1);
      assert.notEqual(context.workspacePath, original);
      assert.equal(
        await fs.readFile(path.join(context.workspacePath!, "feature.txt"), "utf8"),
        "preserved progress",
      );
      assert.match(context.previousError ?? "", /Fix the feature/);
      return implementation(task, context);
    },
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.status, "completed");
  assert.equal(await fs.readFile(path.join(original, "feature.txt"), "utf8"), "preserved progress");
  assert.equal((await store.load()).tasks[0]!.task.maxAttempts, record.task.attempts + 1);
});

test("explicit failed retry remains bounded and normal resume cannot renew it", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  let calls = 0;
  const fail = async (task: ScheduledTask): Promise<AgentResult> => {
    calls++;
    return {
      taskId: task.id,
      owner: task.owner,
      success: false,
      output: "",
      error: "Still broken",
      changedFiles: [],
    };
  };
  await assert.rejects(
    new Orchestrator(plan, {
      projectRoot: root,
      checkpointPath,
      executeAgent: fail,
    }).runUntilComplete(),
    /permanently failed/,
  );
  const before = calls;
  await assert.rejects(
    (await Orchestrator.resume(root, { retryFailed: true, executeAgent: fail })).runUntilComplete(),
    /permanently failed/,
  );
  assert.equal(calls, before + 1);
  await assert.rejects(
    (await Orchestrator.resume(root, { executeAgent: fail })).runUntilComplete(),
    /permanently failed/,
  );
  assert.equal(calls, before + 1);
  assert.equal((await store.load()).tasks[0]!.task.attempts, calls);
});

test("recovery refuses existing Git metadata and paths outside the workspace container", async (t) => {
  const { root, manager } = await fixture(t);
  const workspace = await manager.createTaskWorkspace("feature");
  await assert.rejects(
    recoverWorktree(root, workspace.path, workspace.baseCommit),
    /Existing Git metadata/,
  );
  await assert.rejects(recoverWorktree(root, root, workspace.baseCommit), /Unsafe recovery source/);
});

test("retry-failed is an explicit resume-only CLI option", () => {
  assert.equal(parseWorkflowArguments(["project", "--resume", "--retry-failed"]).retryFailed, true);
  assert.equal(parseWorkflowArguments(["--resume", "project", "--retry-failed"]).retryFailed, true);
  assert.throws(() => parseWorkflowArguments(["project", "--retry-failed"]));
  assert.throws(() => parseWorkflowArguments(["project", "--resume", "--unknown"]));
});
const neverAgent = async (): Promise<AgentResult> =>
  assert.fail("Implementation must not be repeated");
async function implementation(
  task: ScheduledTask,
  context: AgentExecutionContext,
): Promise<AgentResult> {
  await fs.writeFile(path.join(context.workspacePath!, `${task.id}.txt`), "preserved progress");
  return {
    taskId: task.id,
    owner: task.owner,
    success: true,
    output: "Implemented",
    changedFiles: [`${task.id}.txt`],
  };
}
async function fixture(t: TestContext) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-resume-"));
  t.after(() => fs.rm(suite, { recursive: true, force: true }));
  const root = path.join(suite, "project with spaces");
  const manager = new WorkspaceManager(root);
  await manager.initialize();
  const checkpointPath = defaultCheckpointPath(root);
  return { root, manager, checkpointPath, store: new WorkflowStore(checkpointPath) };
}

test("resume preserves agent memory, workspace and attempt; completed tasks never rerun", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    executeTester: async () => pass,
    executeAgent: async (task, context) =>
      executeTask(
        task,
        {
          ...context,
          onCheckpoint: async (session) => {
            await context.onCheckpoint!(session);
            if (session.audit.some((entry) => entry.action === "write_file")) throw stopped();
          },
        },
        {
          ask: async () =>
            JSON.stringify({
              action: "write_file",
              path: "feature.txt",
              content: "preserved progress",
            }),
        },
      ),
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  const saved = await store.load();
  assert.equal(saved.tasks[0]!.phase, "implementing");
  assert.equal(saved.tasks[0]!.session!.nextStep, 2);
  assert.equal(saved.tasks[0]!.task.attempts, 1);
  const originalWorkspace = saved.tasks[0]!.task.workspacePath;
  const resumed = await Orchestrator.resume(root, {
    executeTester: async () => pass,
    executeAgent: async (task, context) => {
      assert.equal(context.workspacePath, originalWorkspace);
      assert.equal(context.attempt, 1);
      assert.equal(
        await fs.readFile(path.join(context.workspacePath!, "feature.txt"), "utf8"),
        "preserved progress",
      );
      return executeTask(task, context, {
        ask: async (prompt) => {
          assert.match(prompt, /RESUMED RUN/);
          assert.match(prompt, /STEP 1: write_file feature.txt/);
          return JSON.stringify({ action: "done", summary: "Preserved implementation" });
        },
      });
    },
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.status, "completed");
  assert.equal(resumed.getAllTasks()[0]!.attempts, 1);
  const completed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => assert.fail("Tester must not repeat a completed task"),
  });
  await completed.runUntilComplete();
  assert.equal((await store.load()).tasks[0]!.task.testerAttempts, 1);
  assert.equal((await store.load()).tasks[0]!.testerResult!.passed, true);
});

test("resume after merge-before-save reconciles Git and goes straight to Tester", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  class InterruptAfterMerge extends GitIntegrationManager {
    override async integrateTask(workspace: TaskWorkspace, id: string): Promise<never> {
      await super.integrateTask(workspace, id);
      throw stopped();
    }
  }
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    gitManager: new InterruptAfterMerge(root),
    executeAgent: implementation,
    executeTester: async () => assert.fail("Interrupted before Tester"),
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  assert.equal((await store.load()).tasks[0]!.phase, "integrating");
  const head = await checkpointGit(root, ["rev-parse", "HEAD"]);
  let tests = 0;
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => {
      tests++;
      return pass;
    },
  });
  await resumed.runUntilComplete();
  assert.equal(await checkpointGit(root, ["rev-parse", "HEAD"]), head);
  assert.equal(tests, 1);
  assert.equal(resumed.getAllTasks()[0]!.integrationAttempts, 1);
});

test("resume an interrupted Tester without spending another tester or implementation attempt", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    executeAgent: implementation,
    executeTester: async () => {
      throw stopped();
    },
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  assert.equal((await store.load()).tasks[0]!.phase, "testing");
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => pass,
  });
  await resumed.runUntilComplete();
  const task = resumed.getAllTasks()[0]!;
  assert.deepEqual([task.attempts, task.integrationAttempts, task.testerAttempts], [1, 1, 1]);
});

test("successful parallel agent output is saved while its peer is interrupted", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const parallel: ProjectPlan = {
    goal: "Parallel",
    tasks: [
      plan.tasks[0]!,
      { ...plan.tasks[0]!, id: "peer", files: ["peer.txt"] },
      {
        ...plan.tasks[0]!,
        id: "dependent",
        dependencies: ["feature", "peer"],
        files: ["dependent.txt"],
      },
    ],
  };
  const first = new Orchestrator(parallel, {
    projectRoot: root,
    checkpointPath,
    enableTester: false,
    executeAgent: async (task, context) => {
      if (task.id === "peer") throw stopped();
      return implementation(task, context);
    },
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  assert.equal((await store.load()).tasks[0]!.phase, "agent_finished");
  const calls: string[] = [];
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async (task, context) => {
      calls.push(task.id);
      return implementation(task, context);
    },
  });
  await resumed.runUntilComplete();
  assert.deepEqual(calls, ["peer", "dependent"]);
  assert.ok(
    resumed.getAllTasks().every((task) => task.status === "completed" && task.attempts === 1),
  );
});

test("unexpected main changes stop resume before another agent or tester executes", async (t) => {
  const { root, checkpointPath } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    executeAgent: implementation,
    executeTester: async () => {
      throw stopped();
    },
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  await checkpointGit(root, ["commit", "--allow-empty", "-m", "external change"]);
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => assert.fail("No stale validation"),
  });
  await assert.rejects(resumed.runUntilComplete(), /Main HEAD changed/);
});

test("store prevents concurrent runs, rejects corrupt state and retains the prior file on failed saves", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    enableTester: false,
    executeAgent: implementation,
  }).runUntilComplete();
  const original = await store.load();
  await store.acquire();
  const other = new WorkflowStore(checkpointPath);
  await assert.rejects(other.acquire(), /already running/);
  await assert.rejects(
    store.save({ ...original, version: 2 } as unknown as typeof original),
    /Invalid checkpoint/,
  );
  assert.deepEqual(await store.load(), original);
  const rename = t.mock.method(fs, "rename", async () => {
    throw new Error("disk write failure");
  });
  await assert.rejects(store.save(original), /Cannot save checkpoint/);
  rename.mock.restore();
  assert.deepEqual(await store.load(), original);
  await store.release();
  await fs.writeFile(checkpointPath, '{"version":1');
  await assert.rejects(other.load(), /Cannot load checkpoint/);
});

test("permanent failure and exhausted attempts stay failed when resumed", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    enableTester: false,
    executeAgent: async (task) => ({
      taskId: task.id,
      owner: task.owner,
      success: false,
      output: "still broken",
      changedFiles: [],
      failureType: "validation",
    }),
  });
  await assert.rejects(first.runUntilComplete(), /permanently failed/);
  const resumed = await Orchestrator.resume(root, { executeAgent: neverAgent });
  await assert.rejects(resumed.runUntilComplete(), /permanently failed/);
  assert.equal((await store.load()).tasks[0]!.task.attempts, 2);
});

test("CLI resume forms cannot accidentally plan a new request", () => {
  assert.deepEqual(parseWorkflowArguments(["C:/project", "--resume"]), {
    projectRoot: "C:/project",
    request: "",
    resume: true,
  });
  assert.deepEqual(parseWorkflowArguments(["--resume", "C:/project"]), {
    projectRoot: "C:/project",
    request: "",
    resume: true,
  });
  assert.throws(() => parseWorkflowArguments(["C:/project", "--resume", "new task"]));
});

test("a lock left by an exited local process is reclaimed on resume", async (t) => {
  const { checkpointPath, store } = await fixture(t);
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await promisify(execFile)(
    process.execPath,
    [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({token:'old',pid:process.pid,hostname:require('node:os').hostname()}));",
      `${checkpointPath}.lock`,
    ],
    { windowsHide: true, shell: false },
  );
  await store.acquire();
  const owner = JSON.parse(await fs.readFile(`${checkpointPath}.lock`, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, "old");
  await store.release();
});

test("interruption before integration resumes integration without rerunning implementation", async (t) => {
  const { root, checkpointPath } = await fixture(t);
  class BeforeIntegration extends GitIntegrationManager {
    override async integrateTask(): Promise<never> {
      throw stopped();
    }
  }
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    gitManager: new BeforeIntegration(root),
    executeAgent: implementation,
    executeTester: async () => pass,
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => pass,
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.integrationAttempts, 1);
  assert.equal(await fs.readFile(path.join(root, "feature.txt"), "utf8"), "preserved progress");
});

test("a missing worktree stops resume without silently recreating it or losing its state", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    executeAgent: async () => {
      throw stopped();
    },
    enableTester: false,
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  const saved = await store.load();
  const workspacePath = saved.tasks[0]!.task.workspacePath!;
  // Move only this disposable fixture's worktree; preserve its contents for cleanup.
  await fs.rename(workspacePath, `${workspacePath}-moved`);
  const resumed = await Orchestrator.resume(root, { executeAgent: neverAgent });
  await assert.rejects(resumed.runUntilComplete(), /Cannot verify Git state/);
  assert.deepEqual(await store.load(), saved);
  await assert.rejects(fs.access(workspacePath));
});

test("a new workflow refuses to overwrite an existing checkpoint", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    enableTester: false,
    executeAgent: implementation,
  }).runUntilComplete();
  const original = await store.load();
  await assert.rejects(
    new Orchestrator(plan, {
      projectRoot: root,
      checkpointPath,
      enableTester: false,
      executeAgent: neverAgent,
    }).runUntilComplete(),
    /saved run already exists/,
  );
  assert.deepEqual(await store.load(), original);
});

test("interruption during an implementation retry preserves its original failure feedback", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const error = "GET /health expected 200 but received 404";
  const first = new Orchestrator(plan, {
    projectRoot: root,
    checkpointPath,
    enableTester: false,
    executeAgent: async (task, context) => {
      if (context.attempt === 2) throw stopped();
      return {
        taskId: task.id,
        owner: task.owner,
        success: false,
        output: error,
        error,
        changedFiles: [],
        failureType: "validation",
      };
    },
  });
  await assert.rejects(first.runUntilComplete(), /Simulated interruption/);
  assert.equal((await store.load()).tasks[0]!.previousError, error);
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async (task, context) => {
      assert.equal(context.attempt, 2);
      assert.equal(context.previousError, error);
      return implementation(task, context);
    },
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.attempts, 2);
});
