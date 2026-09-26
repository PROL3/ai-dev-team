import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planner } from "../../src/agents/planner/planner.js";
import { executeTask } from "../../src/agents/implementation/execute-task.js";
import { runTester } from "../../src/agents/tester/run-tester.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../../src/infrastructure/git/integration-manager.js";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import type { ProjectPlan } from "../../src/domain/plan.js";

test("real workflow: normalize plan, integrate, reject recursive validation, repair, then run parallel tasks", async (t) => {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-workflow-"));
  const root = path.join(suite, "project with spaces");
  t.after(() => fs.rm(suite, { recursive: true, force: true }));
  const logs: string[] = [];
  t.mock.method(console, "log", (message: unknown) => logs.push(String(message)));
  const rawPlan: ProjectPlan = {
    goal: "Implement independently tested modules after foundation",
    architecture: {
      runtime: "Node.js CommonJS",
      storage: "in-memory",
      apiBasePath: "/",
      frontend: "plain HTML",
      fileLayout: ["server.cjs", "backend.cjs", "frontend.cjs"],
      testCommand: "npm test",
    },
    tasks: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Set up working validation",
        owner: "backend",
        dependencies: [],
        files: ["package.json", "server.cjs", "foundation.test.cjs"],
      },
      {
        id: "backend",
        title: "Backend",
        description: "Export the answer 42",
        owner: "backend",
        dependencies: [],
        files: ["backend.cjs", "backend.test.cjs"],
      },
      {
        id: "frontend",
        title: "Frontend",
        description: "Export HTML markup",
        owner: "frontend",
        dependencies: [],
        files: ["frontend.cjs", "frontend.test.cjs"],
      },
    ],
  };
  let plannerCalls = 0;
  const plan = await planner(rawPlan.goal, {
    ask: async () => {
      plannerCalls += 1;
      return JSON.stringify(rawPlan);
    },
  });
  assert.equal(plannerCalls, 1);
  const manager = new WorkspaceManager(root);
  const integration = new GitIntegrationManager(root);
  let active = 0;
  let maxActive = 0;
  let reviewCalls = 0;
  const events: string[] = [];
  const invocation = { action: "run_command", command: "npm", args: ["test"] };
  const manifest = (script: string) =>
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: script } });
  const write = (file: string, content: string) => ({ action: "write_file", path: file, content });
  const orchestrator = new Orchestrator(plan, {
    // Root must also be inferred correctly when callers inject managers only.
    workspaceManager: manager,
    gitManager: integration,
    executeAgent: async (task, context) => {
      assert.deepEqual(context.plannedTasks, plan.tasks);
      events.push(`agent:${task.id}:${context.attempt}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      let actions: object[];
      if (task.id === "foundation" && context.attempt === 1) {
        actions = [
          { action: "list_files", path: "." },
          write("package.json", manifest("npm test")),
          write("server.cjs", "module.exports = { ready: true };\n"),
          write(
            "foundation.test.cjs",
            "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('setup',()=>assert.equal(require('./server.cjs').ready,true));\n",
          ),
          { action: "done", summary: "Created project files." },
        ];
      } else if (task.id === "foundation") {
        assert.match(context.previousTesterResult!.failures.join("\n"), /Recursive npm script/);
        assert.match(context.previousError!, /Recursive npm script/);
        assert.equal(context.previousOutput, "Created project files.");
        assert.ok(!context.previousChangedFiles?.includes("ackage.json"));
        actions = [
          { action: "read_file", path: "package.json" },
          write("package.json", manifest("node --test")),
          invocation,
          { action: "done", summary: "Replaced recursive script with the real Node test runner." },
        ];
      } else {
        assert.equal(orchestrator.getAllTasks()[0]!.status, "completed");
        const value = task.id === "backend" ? "42" : "'<main>Ready</main>'";
        actions = [
          { action: "list_files", path: "." },
          write(`${task.id}.cjs`, `module.exports = ${value};\n`),
          write(
            `${task.id}.test.cjs`,
            `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('${task.id}',()=>assert.equal(require('./${task.id}.cjs'),${value}));\n`,
          ),
          invocation,
          { action: "done", summary: `Implemented and tested ${task.id}.` },
        ];
      }
      try {
        return await executeTask(task, context, {
          ask: async (prompt) => {
            assert.ok(actions.length > 0, "Agent should complete without extra LLM calls");
            if (task.id === "foundation" && context.attempt === 2)
              assert.match(prompt, /Recursive npm script/);
            return JSON.stringify(actions.shift());
          },
          budget: { softMaxSteps: 8, hardMaxSteps: 10 },
        });
      } finally {
        active -= 1;
      }
    },
    executeTester: async (request) => {
      events.push(`tester:${request.task.id}:${request.task.attempts}`);
      assert.equal(request.workspacePath, root);
      assert.equal(request.task.status, "running");
      assert.ok(request.task.commitHash);
      assert.equal(await integration.getMainStatus(), "");
      for (const file of request.changedFiles) {
        await fs.access(path.join(root, file)); // Must be present in the integrated repository.
        assert.notEqual(file, "ackage.json");
      }
      return runTester(request, {
        ask: async (prompt) => {
          reviewCalls += 1;
          assert.match(prompt, /"exitCode":0/);
          return JSON.stringify({
            passed: true,
            summary: "Requirement verified against current source and successful tests.",
            testsRun: ["npm test"],
            failures: [],
            warnings: [],
            changedFiles: request.changedFiles,
            suggestedFixes: [],
          });
        },
      });
    },
  });
  await orchestrator.runUntilComplete();
  const tasks = orchestrator.getAllTasks();
  assert.ok(tasks.every((task) => task.status === "completed"));
  assert.deepEqual(
    tasks.map((task) => [task.id, task.attempts, task.integrationAttempts, task.testerAttempts]),
    [
      ["foundation", 2, 2, 2],
      ["backend", 1, 1, 1],
      ["frontend", 1, 1, 1],
    ],
  );
  assert.deepEqual(events.slice(0, 4), [
    "agent:foundation:1",
    "tester:foundation:1",
    "agent:foundation:2",
    "tester:foundation:2",
  ]);
  assert.equal(maxActive, 2);
  assert.equal(reviewCalls, 3, "Deterministic recursion failure must not invoke the reviewer LLM");
  assert.equal(await integration.getMainStatus(), "");
  const taskLogs = logs
    .filter((line) => line.startsWith("[task-log] "))
    .map((line) => JSON.parse(line.slice("[task-log] ".length)));
  assert.deepEqual(taskLogs[0].tester.testsRun, []);
  assert.match(taskLogs[0].tester.failures[0], /Recursive npm script/);
  assert.equal(taskLogs[0].finalStatus, "pending");
  assert.deepEqual(taskLogs[1].tester.failures, []);
  assert.deepEqual(taskLogs[1].tester.changedFiles, ["package.json"]);
});
