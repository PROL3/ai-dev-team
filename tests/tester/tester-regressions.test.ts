import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  runTester,
  TesterExecutionError,
  type TesterRequest,
  type TesterTools,
} from "../../src/agents/tester/run-tester.js";
import { AgentTools } from "../../src/tools/agent-tools.js";
import { Orchestrator, type OrchestratorOptions } from "../../src/workflow/orchestrator.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../../src/infrastructure/git/integration-manager.js";
import type { TesterResult } from "../../src/domain/tester-result.js";

const pass: TesterResult = {
  passed: true,
  summary: "Validated the actual implementation.",
  testsRun: ["npm test"],
  failures: [],
  warnings: [],
  changedFiles: ["feature.js"],
  suggestedFixes: [],
};
const request: TesterRequest = {
  task: { id: "feature", title: "Feature", description: "Return 42." },
  workspacePath: process.cwd(),
  changedFiles: ["feature.js"],
  previousAgentSummary: "Implemented the feature.",
};

function mockTools(overrides: Partial<TesterTools> = {}): TesterTools {
  return {
    listFiles: async () => ["package.json", "feature.js"],
    readFile: async (file) =>
      file === "package.json"
        ? JSON.stringify({ scripts: { test: "node --test" } })
        : "export const value = 42;",
    runCommand: async () => ({
      stdout: "1 test passed",
      stderr: "",
      exitCode: 0,
    }),
    ...overrides,
  };
}

test("real npm test and npm run work in a Windows path containing spaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tester npm space "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node check.cjs",
        typecheck: "node check.cjs",
        fail: "node fail.cjs",
      },
    }),
  );
  await fs.writeFile(path.join(root, "check.cjs"), "console.log('validation ran');");
  await fs.writeFile(
    path.join(root, "fail.cjs"),
    "console.error('assertion failed'); process.exit(3);",
  );
  const tools = new AgentTools({ role: "tester", workspacePath: root });
  for (const args of [["test"], ["run", "typecheck"]]) {
    const result = await tools.runCommand({ command: "npm", args });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.executionError, undefined);
    assert.match(result.stdout, /validation ran/);
  }
  const failed = await tools.runCommand({
    command: "npm",
    args: ["run", "fail"],
  });
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /assertion failed/);
  assert.equal(failed.executionError, undefined, "a test assertion is not a spawn failure");
});

test("node arguments remain literal without a command shell", async () => {
  const tools = new AgentTools({
    role: "tester",
    workspacePath: process.cwd(),
  });
  const literal = "spaces & pipes | %PATH% $(echo bad)";
  const result = await tools.runCommand({
    command: "node",
    args: ["-e", "console.log(process.argv[1])", literal],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), literal);
});

test("a nonexistent command cwd is classified as an execution error", async () => {
  const tools = new AgentTools({
    role: "tester",
    workspacePath: path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`),
  });
  const result = await tools.runCommand({
    command: "node",
    args: ["--version"],
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.executionError?.code, "ENOENT");
});

test("spawn EINVAL bypasses the LLM and does not claim a test was run", async () => {
  let llmCalls = 0;
  await assert.rejects(
    () =>
      runTester(request, {
        tools: mockTools({
          runCommand: async () => ({
            stdout: "",
            stderr: "spawn EINVAL",
            exitCode: 1,
            executionError: { code: "EINVAL", message: "spawn EINVAL" },
          }),
        }),
        ask: async () => {
          llmCalls += 1;
          return JSON.stringify(pass);
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof TesterExecutionError);
      assert.match(error.result.summary, /EINVAL/);
      assert.deepEqual(error.result.testsRun, []);
      return true;
    },
  );
  assert.equal(llmCalls, 0);
});

test("LLM receives source evidence and cannot invent command or file audit entries", async () => {
  const result = await runTester(request, {
    tools: mockTools(),
    ask: async (prompt) => {
      assert.match(prompt, /export const value = 42/);
      return JSON.stringify({
        ...pass,
        testsRun: ["invented test"],
        changedFiles: ["invented.js"],
      });
    },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.testsRun, ["npm test"]);
  assert.deepEqual(result.changedFiles, ["feature.js"]);
});

test("a command failure keeps exact output even when the LLM says PASS", async () => {
  const result = await runTester(request, {
    tools: mockTools({
      runCommand: async () => ({
        stdout: "",
        stderr: "expected 42, got 0",
        exitCode: 1,
      }),
    }),
    ask: async () => JSON.stringify(pass),
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /expected 42, got 0/);
  assert.match(result.summary, /failed/);
});

test("warnings survive LLM output and warnings alone allow PASS", async () => {
  const result = await runTester(request, {
    tools: mockTools({
      readFile: async (file) => {
        if (file === "feature.js") throw new Error("ENOENT");
        return '{"scripts":{"test":"node --test"}}';
      },
    }),
    ask: async () => JSON.stringify(pass),
  });
  assert.equal(result.passed, true);
  assert.match(result.warnings.join("\n"), /ENOENT/);
});

test("no supported validation cannot be turned into PASS by the model", async () => {
  const result = await runTester(request, {
    tools: mockTools({ readFile: async () => "{}" }),
    ask: async () => JSON.stringify(pass),
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.testsRun, []);
});

test("strict tester schema rejects unknown fields and prose wrappers but accepts fenced JSON", async () => {
  for (const answer of [
    JSON.stringify({ ...pass, extra: true }),
    `prefix ${JSON.stringify(pass)} suffix`,
  ]) {
    await assert.rejects(
      () => runTester(request, { tools: mockTools(), ask: async () => answer }),
      TesterExecutionError,
    );
  }

  const ok = await runTester(request, {
    tools: mockTools(),
    ask: async () => `\`\`\`json\n${JSON.stringify(pass)}\n\`\`\``,
  });
  assert.equal(ok.passed, true);
});

function harness(
  executeTester: NonNullable<OrchestratorOptions["executeTester"]>,
  integrationSuccess = true,
) {
  const events: string[] = [];
  class Workspaces extends WorkspaceManager {
    override async initialize() {}
    override async createTaskWorkspace(taskId: string) {
      return {
        taskId,
        path: process.cwd(),
        branchName: "ai/task/feature",
        baseCommit: "base",
      };
    }
  }
  class Integration extends GitIntegrationManager {
    override async getCurrentMainCommit() {
      return "main";
    }
    override async integrateTask() {
      events.push("integration");
      return {
        success: integrationSuccess,
        commitHash: "integrated",
        mainCommit: "main",
        conflictFiles: integrationSuccess ? [] : ["feature.js"],
      };
    }
  }
  const orchestrator = new Orchestrator(
    {
      goal: "regression",
      tasks: [{ ...request.task, owner: "backend", dependencies: [] }],
    },
    {
      workspaceManager: new Workspaces(),
      gitManager: new Integration(),
      executeAgent: async (task) => {
        events.push("agent");
        return {
          taskId: task.id,
          owner: task.owner,
          success: true,
          output: "implemented",
          changedFiles: ["feature.js"],
        };
      },
      executeTester: async (input) => {
        events.push("tester");
        return executeTester(input);
      },
    },
  );
  return { orchestrator, events };
}

test("an execution error retries only Tester after integration, then completes", async () => {
  let calls = 0;
  const { orchestrator, events } = harness(async () => {
    if (++calls === 1)
      throw new TesterExecutionError({
        ...pass,
        passed: false,
        summary: "spawn EINVAL",
        failures: ["spawn EINVAL"],
        testsRun: [],
      });
    return pass;
  });
  await orchestrator.runUntilComplete();
  assert.deepEqual(events, ["agent", "integration", "tester", "tester"]);
  const task = orchestrator.getAllTasks()[0]!;
  assert.equal(task.status, "completed");
  assert.equal(task.attempts, 1);
  assert.equal(task.integrationAttempts, 1);
  assert.equal(task.testerAttempts, 2);
});

test("persistent execution errors terminate without rewriting implementation", async () => {
  const { orchestrator, events } = harness(async () => {
    throw "spawn ENOENT";
  });
  await assert.rejects(() => orchestrator.runUntilComplete(), /permanently failed/);
  assert.deepEqual(events, ["agent", "integration", "tester", "tester"]);
  const task = orchestrator.getAllTasks()[0]!;
  assert.equal(task.status, "failed");
  assert.equal(task.failureType, "test");
  assert.equal(task.attempts, 1);
  assert.equal(task.testerAttempts, 2);
});

test("Tester is never called for failed integration or its conflict retry", async () => {
  const { orchestrator, events } = harness(async () => pass, false);
  await orchestrator.dispatchReadyTasks();
  assert.deepEqual(events, ["agent", "integration"]);
  const task = orchestrator.getAllTasks()[0]!;
  assert.equal(task.status, "integration_conflict");
  assert.equal(task.testerAttempts, 0);
  await orchestrator.retryIntegration("feature");
  assert.deepEqual(events, ["agent", "integration", "integration"]);
  assert.equal(task.status, "integration_conflict");
  assert.equal(task.integrationAttempts, 2);
});
