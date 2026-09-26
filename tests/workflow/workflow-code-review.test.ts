import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import { WorkflowRuntime } from "../../src/workflow/runtime.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { runCodeReview } from "../../src/agents/code-review/run-code-review.js";
import { CheckpointError, WorkflowStore, defaultCheckpointPath } from "../../src/infrastructure/persistence/workflow-store.js";
import { workflowStateSchema } from "../../src/domain/workflow-state.js";
import type { ProjectPlan } from "../../src/domain/plan.js";
import type { AgentExecutor } from "../../src/workflow/types.js";
import type { CodeReviewRequest } from "../../src/agents/code-review/types.js";
import type { CodeReviewResult, ReviewFinding } from "../../src/domain/code-review.js";

const plan: ProjectPlan = {
  goal: "Write a working feature",
  tasks: [{ id: "feature", title: "Feature", description: "Write working feature.txt", owner: "backend", dependencies: [], files: ["feature.txt"] }],
};
const pass = { passed: true, summary: "Validated", testsRun: ["fixture validation"], failures: [], warnings: [], changedFiles: ["feature.txt"], suggestedFixes: [] };
const finding: ReviewFinding = {
  priority: "P1", category: "correctness", title: "Replace the broken result", file: "feature.txt",
  side: "after", startLine: 1, endLine: 1, evidence: "broken",
  scenario: "Reading the feature returns broken.", impact: "The required working result is missing.",
  suggestedFix: "Return working.",
};
const approve = (request: CodeReviewRequest): CodeReviewResult => ({
  summary: "Reviewed", status: "approved", findings: [], limitations: [], reviewedFiles: ["feature.txt"],
  baseCommit: request.baseCommit, headCommit: request.headCommit,
});
const implement: AgentExecutor = async (task, context) => {
  await fs.writeFile(path.join(context.workspacePath!, "feature.txt"), "working\n");
  return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["feature.txt"] };
};
const neverAgent: AgentExecutor = async () => assert.fail("Implementation must not rerun");
const stopped = () => new CheckpointError("Simulated interruption");

async function fixture(t: TestContext) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-review-"));
  t.after(() => fs.rm(suite, { recursive: true, force: true }));
  const root = path.join(suite, "project with spaces");
  await new WorkspaceManager(root).initialize();
  const checkpointPath = defaultCheckpointPath(root);
  return { root, checkpointPath, store: new WorkflowStore(checkpointPath) };
}

test("default workflows enable review; legacy injected executors opt in explicitly", () => {
  assert.equal(new WorkflowRuntime(plan).enableCodeReview, true);
  assert.equal(new WorkflowRuntime(plan, { executeAgent: implement }).enableCodeReview, false);
  assert.equal(new WorkflowRuntime(plan, { executeAgent: implement, executeTester: async () => pass, executeCodeReview: async (r) => approve(r) }).enableCodeReview, true);
  assert.throws(() => new WorkflowRuntime(plan, { enableTester: false, enableCodeReview: true }), /requires Tester/);
});

test("blocking review feeds implementation, keeps dependents locked, and reruns Tester before every review", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const events: string[] = [];
  const workflow = new Orchestrator({ ...plan, tasks: [
    ...plan.tasks,
    { id: "dependent", title: "Dependent", description: "Use working feature", owner: "frontend", dependencies: ["feature"], files: ["dependent.txt"] },
  ] }, {
    projectRoot: root, checkpointPath,
    executeAgent: async (task, context) => {
      events.push(`implement:${task.id}:${context.attempt}`);
      if (task.id === "dependent") {
        assert.equal(workflow.getAllTasks()[0]!.status, "completed");
        await fs.writeFile(path.join(context.workspacePath!, "dependent.txt"), "ready");
        return { taskId: task.id, owner: task.owner, success: true, output: "Ready", changedFiles: ["dependent.txt"] };
      }
      if (context.attempt === 2) {
        assert.equal(context.previousReview?.findings[0]?.title, finding.title);
        assert.match(context.previousError!, /Replace the broken result/);
      }
      await fs.writeFile(path.join(context.workspacePath!, "feature.txt"), context.attempt === 1 ? "broken\n" : "working\n");
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["feature.txt"] };
    },
    executeCodeReview: async (request) => {
      assert.equal(request.validation?.commit, request.headCommit);
      events.push(`review:${request.task.id}`);
      return runCodeReview(request, { ask: async (prompt) => {
        const broken = request.task.id === "feature" && !request.previousReview;
        if (request.previousReview) assert.match(prompt, /HISTORICAL FINDINGS/);
        return JSON.stringify({ summary: broken ? "Fix the feature" : "Reviewed current code", findings: broken ? [finding] : [], limitations: [] });
      } });
    },
    executeTester: async (request) => { events.push(`tester:${request.task.id}`); return pass; },
  });
  await workflow.runUntilComplete();
  assert.deepEqual(events, ["implement:feature:1", "tester:feature", "review:feature", "implement:feature:2", "tester:feature", "review:feature", "implement:dependent:1", "tester:dependent", "review:dependent"]);
  const saved = await store.load();
  assert.equal(saved.enableCodeReview, true);
  assert.equal(saved.tasks[0]!.task.attempts, 2);
  assert.equal(saved.tasks[0]!.task.reviewAttempts, 2);
  assert.equal(saved.tasks[0]!.task.testerAttempts, 2);
  assert.equal(saved.tasks[0]!.reviewResult!.status, "approved");
  const invalid = structuredClone(saved);
  delete invalid.tasks[0]!.reviewResult;
  assert.equal(workflowStateSchema.safeParse(invalid).success, false);
});

test("protocol failures retry review only and stop within the runner budget", async (t) => {
  const { root } = await fixture(t);
  let implementations = 0;
  let reviews = 0;
  const workflow = new Orchestrator(plan, {
    projectRoot: root, executeTester: async () => pass,
    executeAgent: async (...args) => { implementations++; return implement(...args); },
    executeCodeReview: async () => { reviews++; throw new Error("Malformed response"); },
  });
  await assert.rejects(workflow.runUntilComplete(), /permanently failed/);
  assert.equal(implementations, 1);
  assert.equal(reviews, 2);
  assert.equal(workflow.getAllTasks()[0]!.failureType, "review");
  assert.equal(workflow.getAllTasks()[0]!.status, "failed");
});

test("stale or contradictory injected approvals cannot complete tasks", async (t) => {
  const { root } = await fixture(t);
  let reviews = 0;
  const workflow = new Orchestrator(plan, {
    projectRoot: root, executeTester: async () => pass, executeAgent: implement,
    executeCodeReview: async (request) => {
      reviews++;
      return reviews === 1
        ? { ...approve(request), headCommit: "a".repeat(40) }
        : { ...approve(request), findings: [finding] };
    },
  });
  await assert.rejects(workflow.runUntilComplete(), /permanently failed/);
  assert.equal(reviews, 2);
  assert.equal(workflow.getAllTasks()[0]!.attempts, 1);
});

test("interrupted review resumes the same attempt and committed revision", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await assert.rejects(new Orchestrator(plan, {
    projectRoot: root, checkpointPath, executeTester: async () => pass, executeAgent: implement,
    executeCodeReview: async () => { throw stopped(); },
  }).runUntilComplete(), /Simulated interruption/);
  const before = await store.load();
  assert.equal(before.tasks[0]!.phase, "reviewing");
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeTester: async () => assert.fail("Tester PASS for this revision is already saved"),
    executeCodeReview: async (request) => {
      assert.equal(request.headCommit, before.tasks[0]!.integrationCommit);
      return approve(request);
    },
  });
  await resumed.runUntilComplete();
  const after = await store.load();
  assert.equal(after.tasks[0]!.task.reviewAttempts, 1);
  assert.equal(after.tasks[0]!.task.attempts, 1);
  assert.equal(after.tasks[0]!.task.integrationAttempts, 1);
  await assert.rejects(Orchestrator.resume(root, { enableCodeReview: false }), /cannot change/);
});

test("Tester interruption does not run Reviewer until resumed tests pass", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await assert.rejects(new Orchestrator(plan, {
    projectRoot: root, checkpointPath, executeAgent: implement,
    executeCodeReview: async () => assert.fail("Reviewer cannot run before Tester PASS"),
    executeTester: async () => { throw stopped(); },
  }).runUntilComplete(), /Simulated interruption/);
  assert.equal((await store.load()).tasks[0]!.phase, "testing");
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeCodeReview: async (request) => approve(request),
    executeTester: async () => pass,
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.reviewAttempts, 1);
  assert.equal(resumed.getAllTasks()[0]!.testerAttempts, 1);
});

test("older checkpoints default to disabled review and preserve completed work", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await new Orchestrator(plan, { projectRoot: root, checkpointPath, enableTester: false, executeAgent: implement }).runUntilComplete();
  const raw = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  delete raw.enableCodeReview;
  for (const record of raw.tasks) { delete record.task.reviewAttempts; delete record.task.reviewMaxAttempts; }
  await fs.writeFile(checkpointPath, JSON.stringify(raw));
  const resumed = await Orchestrator.resume(root, {
    executeAgent: neverAgent,
    executeCodeReview: async () => assert.fail("Legacy runs must not start new review calls"),
  });
  await resumed.runUntilComplete();
  assert.equal((await store.load()).enableCodeReview, false);
});

test("persistent defects exhaust implementation attempts and explicit retry preserves review history", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  let implementations = 0;
  let reviews = 0;
  const workflow = new Orchestrator(plan, {
    projectRoot: root, checkpointPath, executeTester: async () => pass,
    executeAgent: async (...args) => { implementations++; return implement(...args); },
    executeCodeReview: async (request) => {
      reviews++;
      return { ...approve(request), status: "changes_requested", findings: [finding] };
    },
  });
  await assert.rejects(workflow.runUntilComplete(), /permanently failed/);
  assert.equal(implementations, 2);
  assert.equal(reviews, 2);
  const exhausted = await store.load();
  const normalResume = await Orchestrator.resume(root, { executeAgent: neverAgent });
  await assert.rejects(normalResume.runUntilComplete(), /permanently failed/);
  const resumed = await Orchestrator.resume(root, {
    retryFailed: true,
    executeTester: async () => pass,
    executeAgent: async (task, context) => {
      assert.equal(context.previousReview?.findings[0]?.title, finding.title);
      return implement(task, context);
    },
    executeCodeReview: async (request) => {
      assert.deepEqual(request.reviewPaths, ["feature.txt"]);
      assert.equal(request.baseCommit, exhausted.tasks[0]!.reviewBase);
      return approve(request);
    },
  });
  await resumed.runUntilComplete();
  assert.equal(resumed.getAllTasks()[0]!.reviewAttempts, 3);
  assert.equal(resumed.getAllTasks()[0]!.maxAttempts, 3);
});

test("inconclusive reviews never complete a tested task", async (t) => {
  const { root } = await fixture(t);
  let reviews = 0;
  const workflow = new Orchestrator(plan, {
    projectRoot: root, executeTester: async () => pass, executeAgent: implement,
    executeCodeReview: async (request) => {
      reviews++;
      return { ...approve(request), status: "inconclusive", limitations: ["Changed file unavailable"] };
    },
  });
  await assert.rejects(workflow.runUntilComplete(), /permanently failed/);
  assert.equal(reviews, 2);
  assert.equal(workflow.getAllTasks()[0]!.attempts, 1);
});
