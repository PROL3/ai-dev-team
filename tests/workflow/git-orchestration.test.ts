import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import { GitIntegrationManager } from "../../src/infrastructure/git/integration-manager.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import type {
  AgentExecutionContext,
  AgentResult,
} from "../../src/agents/implementation/execute-task.js";
import type { ScheduledTask } from "../../src/domain/scheduler.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    shell: false,
  });

  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-git-"));

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "AI Dev Test"]);
  await fs.writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);

  return root;
}

async function write(workspacePath: string, file: string, content: string) {
  await fs.writeFile(path.join(workspacePath, file), content, "utf8");
}

async function testParallelIndependentTasks(): Promise<void> {
  const root = await createRepository();
  const workspaces = new WorkspaceManager(root);
  const gitManager = new GitIntegrationManager(root);
  const first = await workspaces.createTaskWorkspace("parallel-a");
  const second = await workspaces.createTaskWorkspace("parallel-b");

  await Promise.all([write(first.path, "a.txt", "a\n"), write(second.path, "b.txt", "b\n")]);

  const [firstResult, secondResult] = await Promise.all([
    gitManager.integrateTask(first, "parallel-a"),
    gitManager.integrateTask(second, "parallel-b"),
  ]);

  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.equal(
    (await fs.readFile(path.join(root, "a.txt"), "utf8")).replaceAll("\r\n", "\n"),
    "a\n",
  );
  assert.equal(
    (await fs.readFile(path.join(root, "b.txt"), "utf8")).replaceAll("\r\n", "\n"),
    "b\n",
  );
}

async function testConflictAbortsMerge(): Promise<void> {
  const root = await createRepository();
  const workspaces = new WorkspaceManager(root);
  const gitManager = new GitIntegrationManager(root);
  const first = await workspaces.createTaskWorkspace("conflict-a");
  const second = await workspaces.createTaskWorkspace("conflict-b");

  await write(first.path, "shared.txt", "from a\n");
  await write(second.path, "shared.txt", "from b\n");

  const firstResult = await gitManager.integrateTask(first, "conflict-a");
  const secondResult = await gitManager.integrateTask(second, "conflict-b");

  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, false);
  assert.deepEqual(secondResult.conflictFiles, ["shared.txt"]);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  await assert.rejects(() => git(root, ["rev-parse", "--verify", "MERGE_HEAD"]));
}

async function testNoopTaskBranchIsNotABlocker(): Promise<void> {
  const root = await createRepository();
  const workspaceManager = new WorkspaceManager(root);
  const gitManager = new GitIntegrationManager(root);
  const workspace = await workspaceManager.createTaskWorkspace("noop-task");

  const result = await gitManager.integrateTask(workspace, "noop-task");

  assert.equal(result.success, true);
  assert.deepEqual(result.conflictFiles, []);
  assert.equal(result.commitHash, await git(root, ["rev-parse", "HEAD"]));
}

async function testOrchestratorQueueRetryAndDependencies(): Promise<void> {
  const root = await createRepository();
  const workspaceManager = new WorkspaceManager(root);
  const gitManager = new GitIntegrationManager(root);
  const executionOrder: string[] = [];
  const attempts = new Map<string, number>();
  let activeAgents = 0;
  let maxActiveAgents = 0;

  const executeAgent = async (
    task: ScheduledTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> => {
    const attempt = (attempts.get(task.id) ?? 0) + 1;
    attempts.set(task.id, attempt);
    executionOrder.push(`${task.id}:${attempt}`);
    activeAgents += 1;
    maxActiveAgents = Math.max(maxActiveAgents, activeAgents);

    await new Promise((resolve) => setTimeout(resolve, 10));
    activeAgents -= 1;

    if (!context.workspacePath) {
      throw new Error("Missing test workspace");
    }

    if (task.id === "retry" && attempt === 1) {
      return {
        taskId: task.id,
        owner: task.owner,
        success: false,
        output: "partial output",
        error: "simulated agent failure",
        changedFiles: [],
      };
    }

    try {
      await write(context.workspacePath, `${task.id}.txt`, `${task.id}\n`);
    } catch (error) {
      return {
        taskId: task.id,
        owner: task.owner,
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        changedFiles: [],
      };
    }

    return {
      taskId: task.id,
      owner: task.owner,
      success: true,
      output: `${task.id} complete`,
      changedFiles: [`${task.id}.txt`],
    };
  };

  const orchestrator = new Orchestrator(
    {
      goal: "deterministic orchestration",
      tasks: [
        {
          id: "parallel-a",
          files: ["parallel-a.txt"],
          title: "A",
          description: "A",
          owner: "backend",
          dependencies: [],
        },
        {
          id: "parallel-b",
          files: ["parallel-b.txt"],
          title: "B",
          description: "B",
          owner: "frontend",
          dependencies: [],
        },
        {
          id: "retry",
          files: ["retry.txt"],
          title: "Retry",
          description: "Retry",
          owner: "backend",
          dependencies: [],
        },
        {
          id: "dependent",
          files: ["dependent.txt"],
          title: "Dependent",
          description: "Dependent",
          owner: "tester",
          dependencies: ["parallel-a"],
        },
      ],
    },
    {
      workspaceManager,
      gitManager,
      executeAgent,
    },
  );

  await orchestrator.runUntilComplete();

  const tasks = orchestrator.getAllTasks();
  assert.equal(maxActiveAgents >= 2, true);
  assert.equal(attempts.get("retry"), 2);
  assert.equal(attempts.get("dependent"), 1);
  assert.deepEqual(executionOrder.slice(-1), ["dependent:1"]);
  assert.ok(tasks.every((task) => task.status === "completed"));
}

async function testIntegrationConflictRetryDoesNotRetryAgent(): Promise<void> {
  const root = await createRepository();
  const workspaceManager = new WorkspaceManager(root);
  const gitManager = new GitIntegrationManager(root);
  const agentAttempts = new Map<string, number>();

  const orchestrator = new Orchestrator(
    {
      goal: "integration conflict",
      tasks: [
        {
          id: "conflict-a",
          files: ["conflict-a.txt"],
          title: "A",
          description: "A",
          owner: "backend",
          dependencies: [],
        },
        {
          id: "conflict-b",
          files: ["conflict-b.txt"],
          title: "B",
          description: "B",
          owner: "frontend",
          dependencies: [],
        },
      ],
    },
    {
      workspaceManager,
      gitManager,
      executeAgent: async (task, context) => {
        agentAttempts.set(task.id, (agentAttempts.get(task.id) ?? 0) + 1);

        if (!context.workspacePath) {
          throw new Error("Missing test workspace");
        }

        // Deliberately bypass agent tools and violate the disjoint declared scopes:
        // Git integration must still catch unexpected conflicting side effects.
        await write(context.workspacePath, "shared.txt", `${task.id}\n`);

        return {
          taskId: task.id,
          owner: task.owner,
          success: true,
          output: `${task.id} complete`,
          changedFiles: ["shared.txt"],
        };
      },
    },
  );

  const results = await orchestrator.dispatchReadyTasks();
  const tasks = orchestrator.getAllTasks();
  const conflictTask = tasks.find((task) => task.id === "conflict-b");

  assert.ok(conflictTask);
  assert.equal(tasks.find((task) => task.id === "conflict-a")?.status, "completed");
  assert.equal(conflictTask.status, "integration_conflict");
  assert.deepEqual(conflictTask.conflictFiles, ["shared.txt"]);
  assert.equal(conflictTask.attempts, 1);
  assert.equal(conflictTask.integrationAttempts, 1);
  assert.equal(agentAttempts.get("conflict-b"), 1);
  assert.equal(results.find((result) => result.taskId === "conflict-b")?.success, false);
  assert.equal(await git(root, ["status", "--porcelain"]), "");

  const conflictWorkspace = await workspaceManager.createTaskWorkspace("conflict-b");
  await fs.rm(path.join(conflictWorkspace.path, "shared.txt"));
  await write(conflictWorkspace.path, "resolved.txt", "resolved\n");
  await git(conflictWorkspace.path, ["add", "-A"]);
  await git(conflictWorkspace.path, ["commit", "--amend", "--no-edit"]);

  const retryResult = await orchestrator.retryIntegration("conflict-b");

  assert.equal(retryResult.success, true);
  assert.equal(conflictTask.status, "completed");
  assert.equal(conflictTask.attempts, 1);
  assert.equal(conflictTask.integrationAttempts, 2);
  assert.equal(agentAttempts.get("conflict-b"), 1);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
}

async function main() {
  await testParallelIndependentTasks();
  await testConflictAbortsMerge();
  await testNoopTaskBranchIsNotABlocker();
  await testOrchestratorQueueRetryAndDependencies();
  await testIntegrationConflictRetryDoesNotRetryAgent();
  console.log("Git orchestration tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
