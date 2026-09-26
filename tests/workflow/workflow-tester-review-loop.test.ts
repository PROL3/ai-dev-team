import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { CheckpointError, WorkflowStore, defaultCheckpointPath } from "../../src/infrastructure/persistence/workflow-store.js";
import { runTester } from "../../src/agents/tester/run-tester.js";
import { runCodeReview } from "../../src/agents/code-review/run-code-review.js";
import type { ProjectPlan } from "../../src/domain/plan.js";
import type { CodeReviewRequest } from "../../src/agents/code-review/types.js";
import type { CodeReviewResult } from "../../src/domain/code-review.js";
import type { TestAuthorRequest } from "../../src/agents/tester/author-tests.js";
import type { WorkflowState } from "../../src/domain/workflow-state.js";

const plan: ProjectPlan = {
  goal: "Return the correct answer",
  tasks: [{ id: "feature", title: "Feature", description: "Export 42 from feature.cjs", owner: "backend", dependencies: [], files: ["feature.cjs", "package.json"] }],
};
const pass = { passed: true, summary: "Functional tests passed", failures: [], testsRun: ["fixture test"], warnings: [], changedFiles: ["feature.cjs"], suggestedFixes: [] };
const approve = (r: CodeReviewRequest): CodeReviewResult => ({
  status: "approved", summary: "Reviewed", findings: [], limitations: [],
  baseCommit: r.baseCommit, headCommit: r.headCommit, reviewedFiles: ["feature.cjs"],
});
function testSource(request: TestAuthorRequest) {
  const relative = path.posix.relative(path.posix.dirname(request.testPath), "feature.cjs");
  return { summary: "Assert public result equals 42", content: `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport value from '${relative}';\ntest('required answer',()=>assert.equal(value,42));` };
}
async function fixture(t: TestContext) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "tester-review-loop-"));
  t.after(() => fs.rm(suite, { recursive: true, force: true }));
  const root = path.join(suite, "project");
  await new WorkspaceManager(root).initialize();
  const checkpointPath = defaultCheckpointPath(root);
  return { root, checkpointPath, store: new WorkflowStore(checkpointPath) };
}

test("real authored tests fail -> Coder repairs -> tests pass -> Reviewer; earlier files remain in review", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const events: string[] = [];
  const workflow = new Orchestrator(plan, {
    projectRoot: root, checkpointPath,
    executeAgent: async (task, context) => {
      events.push(`coder:${context.attempt}`);
      if (context.attempt === 2) {
        assert.match(context.previousTesterResult!.failures.join("\n"), /42/);
        assert.equal(context.testerOwnedTests?.length, 1);
        await fs.access(path.join(context.workspacePath!, context.testerOwnedTests![0]!));
      }
      await fs.writeFile(path.join(context.workspacePath!, "package.json"), '{"scripts":{"test":"node --test"}}');
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), `module.exports = ${context.attempt === 1 ? 0 : 42};`);
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: context.attempt === 1 ? ["package.json", "feature.cjs"] : ["feature.cjs"] };
    },
    executeTestAuthor: async (request) => { events.push("author"); return testSource(request); },
    executeTester: async (request) => {
      events.push("tester");
      return runTester(request, { ask: async () => JSON.stringify(pass) });
    },
    executeCodeReview: async (request) => {
      events.push("reviewer");
      assert.equal(request.validation?.commit, request.headCommit);
      assert.ok(request.validation!.testsRun.some((command) => command.includes("tester-attempt-1")));
      const result = await runCodeReview(request, { ask: async () => JSON.stringify({ summary: "Reviewed tested change", findings: [], limitations: [] }) });
      assert.ok(result.reviewedFiles.includes("package.json"), "First attempt's unreviewed files must not disappear");
      assert.ok(result.reviewedFiles.some((file) => file.includes("tester-attempt-1")));
      return result;
    },
  });
  await workflow.runUntilComplete();
  assert.deepEqual(events, ["coder:1", "author", "tester", "coder:2", "author", "tester", "reviewer"]);
  const record = (await store.load()).tasks[0]!;
  assert.equal(record.testerTests!.length, 2);
  assert.equal(record.task.testerAttempts, 2);
  assert.equal(record.task.reviewAttempts, 1);
  assert.equal(record.testerCommit, record.reviewResult!.headCommit);
});

test("a Reviewer repair that breaks tests cannot reach Reviewer a second time", async (t) => {
  const { root } = await fixture(t);
  const events: string[] = [];
  const workflow = new Orchestrator(plan, {
    projectRoot: root,
    executeAgent: async (task, context) => {
      events.push("coder");
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), `module.exports = ${context.attempt};`);
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["feature.cjs"] };
    },
    executeTester: async (request) => {
      events.push("tester");
      return request.task.attempts === 1 ? pass : { ...pass, passed: false, summary: "Regression", failures: ["Assertion failed after review fix"] };
    },
    executeCodeReview: async (request) => {
      events.push("reviewer");
      return { ...approve(request), status: "changes_requested", findings: [{
        priority: "P2", category: "security", title: "Validate the boundary", file: "feature.cjs", side: "after",
        startLine: 1, endLine: 1, evidence: "module.exports = 1;", scenario: "Unsupported input", impact: "Invalid result", suggestedFix: "Validate input",
      }] };
    },
  });
  await assert.rejects(workflow.runUntilComplete(), /permanently failed/);
  assert.deepEqual(events, ["coder", "tester", "reviewer", "coder", "tester"]);
  assert.equal(workflow.getAllTasks()[0]!.failureType, "test");
});

test("interrupted test authoring resumes without calling Coder or losing its attempt budget", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await assert.rejects(new Orchestrator(plan, {
    projectRoot: root, checkpointPath, enableCodeReview: false,
    executeAgent: async (task, context) => {
      await fs.writeFile(path.join(context.workspacePath!, "package.json"), "{}");
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), "module.exports = 42;");
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["package.json", "feature.cjs"] };
    },
    executeTestAuthor: async () => { throw new CheckpointError("Simulated author interruption"); },
    executeTester: async () => pass,
  }).runUntilComplete(), /Simulated author interruption/);
  const before = await store.load();
  assert.equal(before.tasks[0]!.phase, "authoring_tests");
  assert.equal(before.tasks[0]!.testAuthorAttempts, 1);
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async () => assert.fail("Coder must not rerun"),
    executeTestAuthor: async (request) => testSource(request),
    executeTester: async () => pass,
  });
  await resumed.runUntilComplete();
  const record = (await store.load()).tasks[0]!;
  assert.equal(record.task.attempts, 1);
  assert.equal(record.testAuthorAttempts, 2);
  assert.equal(record.testerTests?.length, 1);
});

test("a malformed project manifest goes directly back to Coder before authoring or Review", async (t) => {
  const { root } = await fixture(t);
  const events: string[] = [];
  const workflow = new Orchestrator(plan, {
    projectRoot: root,
    executeAgent: async (task, context) => {
      events.push(`coder:${context.attempt}`);
      if (context.attempt === 2) assert.match(context.previousTesterResult!.failures[0]!, /package.json/);
      await fs.writeFile(path.join(context.workspacePath!, "package.json"), context.attempt === 1 ? "{broken" : "{}");
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), "module.exports = 42;");
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["package.json", "feature.cjs"] };
    },
    executeTestAuthor: async (request) => { events.push("author"); return testSource(request); },
    executeTester: async () => { events.push("tester"); return pass; },
    executeCodeReview: async (request) => { events.push("reviewer"); return approve(request); },
  });
  await workflow.runUntilComplete();
  assert.deepEqual(events, ["coder:1", "coder:2", "author", "tester", "reviewer"]);
});

test("a saved test draft survives a crash after its file write without another author call", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  const save = WorkflowStore.prototype.save;
  let interrupt = true;
  t.mock.method(WorkflowStore.prototype, "save", async function(this: WorkflowStore, state: WorkflowState) {
    const record = state.tasks[0]!;
    if (interrupt && record.phase === "agent_finished" && record.testerTests?.length) {
      interrupt = false;
      throw new CheckpointError("Interrupted after draft write");
    }
    return save.call(this, state);
  });
  await assert.rejects(new Orchestrator(plan, {
    projectRoot: root, checkpointPath, enableCodeReview: false,
    executeAgent: async (task, context) => {
      await fs.writeFile(path.join(context.workspacePath!, "package.json"), "{}");
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), "module.exports = 42;");
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["package.json", "feature.cjs"] };
    },
    executeTestAuthor: async (request) => testSource(request), executeTester: async () => pass,
  }).runUntilComplete(), /Interrupted after draft write/);
  const saved = (await store.load()).tasks[0]!;
  assert.equal(saved.phase, "authoring_tests");
  assert.ok(saved.testDraft);
  assert.equal(await fs.readFile(path.join(saved.task.workspacePath!, saved.testDraft.path), "utf8"), saved.testDraft.content);
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async () => assert.fail("Coder must not rerun"),
    executeTestAuthor: async () => assert.fail("The persisted draft must be reused"),
    executeTester: async () => pass,
  });
  await resumed.runUntilComplete();
  assert.equal((await store.load()).tasks[0]!.testerTests!.length, 1);
});

test("resume migrates an unfinished old review-before-test run through Tester first", async (t) => {
  const { root, checkpointPath, store } = await fixture(t);
  await assert.rejects(new Orchestrator(plan, {
    projectRoot: root, checkpointPath,
    executeAgent: async (task, context) => {
      await fs.writeFile(path.join(context.workspacePath!, "feature.cjs"), "module.exports = 42;");
      return { taskId: task.id, owner: task.owner, success: true, output: "Implemented", changedFiles: ["feature.cjs"] };
    },
    executeTester: async () => pass,
    executeCodeReview: async () => { throw new CheckpointError("Interrupted review"); },
  }).runUntilComplete(), /Interrupted review/);
  const saved = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  delete saved.validationOrder;
  delete saved.tasks[0].testerResult;
  delete saved.tasks[0].testerCommit;
  await fs.writeFile(checkpointPath, JSON.stringify(saved));
  const events: string[] = [];
  const resumed = await Orchestrator.resume(root, {
    executeAgent: async () => assert.fail("Coder must not rerun"),
    executeTester: async () => { events.push("tester"); return pass; },
    executeCodeReview: async (request) => { events.push("reviewer"); return approve(request); },
  });
  await resumed.runUntilComplete();
  assert.deepEqual(events, ["tester", "reviewer"]);
  const updated = await store.load();
  assert.equal(updated.validationOrder, "test-then-review");
  assert.equal(updated.tasks[0]!.testerCommit, updated.tasks[0]!.reviewResult!.headCommit);
});
