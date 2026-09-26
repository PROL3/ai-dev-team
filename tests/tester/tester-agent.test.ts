import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  runTester,
  TesterExecutionError,
  type TesterTools,
} from "../../src/agents/tester/run-tester.js";
import { Orchestrator } from "../../src/workflow/orchestrator.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../../src/infrastructure/git/integration-manager.js";

const execFileAsync = promisify(execFile);

const pass = {
  passed: true,
  summary: "Validated.",
  testsRun: ["npm test"],
  failures: [],
  warnings: [],
  changedFiles: ["feature.ts"],
  suggestedFixes: [],
};

function tools(options: { commandExitCode?: number; missingFile?: boolean } = {}): TesterTools {
  return {
    async listFiles() {
      return ["package.json", "feature.ts"];
    },
    async readFile(file) {
      if (options.missingFile && file === "feature.ts") throw new Error("ENOENT");
      return file === "package.json" ? '{"scripts":{"test":"node --test"}}' : "export {};";
    },
    async runCommand() {
      return { stdout: "test output", stderr: "", exitCode: options.commandExitCode ?? 0 };
    },
  };
}

function request() {
  return {
    task: { id: "feature", title: "Feature", description: "Implement a feature" },
    workspacePath: "/unused",
    changedFiles: ["feature.ts"],
    previousAgentSummary: "Implemented feature.ts",
  };
}

async function testTesterProtocol(): Promise<void> {
  assert.equal(
    (await runTester(request(), { tools: tools(), ask: async () => JSON.stringify(pass) })).passed,
    true,
  );
  assert.equal(
    (
      await runTester(request(), {
        tools: tools(),
        ask: async () =>
          JSON.stringify({
            ...pass,
            passed: false,
            failures: ["endpoint fails"],
            suggestedFixes: ["fix endpoint"],
          }),
      })
    ).passed,
    false,
  );
  await assert.rejects(
    () => runTester(request(), { tools: tools(), ask: async () => "not json" }),
    TesterExecutionError,
  );
  await assert.rejects(
    () =>
      runTester(request(), { tools: tools(), ask: async () => JSON.stringify({ passed: true }) }),
    TesterExecutionError,
  );
  const missing = await runTester(request(), {
    tools: tools({ missingFile: true }),
    ask: async () => JSON.stringify(pass),
  });
  assert.equal(missing.passed, true);
  assert.ok(missing.warnings.some((warning) => warning.includes("ENOENT")));
  assert.equal(
    (
      await runTester(request(), {
        tools: tools({ commandExitCode: 1 }),
        ask: async () => JSON.stringify(pass),
      })
    ).passed,
    false,
  );
  assert.equal(
    (await runTester(request(), { tools: tools(), ask: async () => JSON.stringify(pass) }))
      .testsRun[0],
    "npm test",
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, shell: false });
}

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-tester-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Tester"]);
  await fs.writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function testOrchestratorTesterLoop(): Promise<void> {
  const root = await repository();
  const feedback: unknown[] = [];
  let testCalls = 0;
  const orchestrator = new Orchestrator(
    {
      goal: "tester loop",
      tasks: [
        {
          id: "feature",
          title: "Feature",
          description: "Feature",
          owner: "backend",
          dependencies: [],
        },
      ],
    },
    {
      projectRoot: root,
      workspaceManager: new WorkspaceManager(root),
      gitManager: new GitIntegrationManager(root),
      executeAgent: async (task, context) => {
        feedback.push(context.previousTesterResult ?? null);
        await fs.writeFile(
          path.join(context.workspacePath!, "feature.txt"),
          `attempt ${context.attempt}\n`,
        );
        return {
          taskId: task.id,
          owner: task.owner,
          success: true,
          output: "implemented",
          changedFiles: ["feature.txt"],
        };
      },
      executeTester: async () => {
        testCalls += 1;
        return testCalls === 1
          ? {
              ...pass,
              passed: false,
              summary: "Feature is broken",
              failures: ["broken"],
              suggestedFixes: ["fix it"],
            }
          : pass;
      },
    },
  );
  await orchestrator.runUntilComplete();
  assert.equal(orchestrator.getAllTasks()[0]?.status, "completed");
  assert.equal(testCalls, 2);
  assert.deepEqual(feedback[1], {
    passed: false,
    summary: "Feature is broken",
    failures: ["broken"],
    suggestedFixes: ["fix it"],
  });
}

async function testTesterRetryLimit(): Promise<void> {
  const root = await repository();
  const orchestrator = new Orchestrator(
    {
      goal: "tester limit",
      tasks: [
        {
          id: "feature",
          title: "Feature",
          description: "Feature",
          owner: "backend",
          dependencies: [],
        },
      ],
    },
    {
      projectRoot: root,
      workspaceManager: new WorkspaceManager(root),
      gitManager: new GitIntegrationManager(root),
      executeAgent: async (task, context) => {
        await fs.writeFile(path.join(context.workspacePath!, "feature.txt"), "broken\n");
        return {
          taskId: task.id,
          owner: task.owner,
          success: true,
          output: "implemented",
          changedFiles: ["feature.txt"],
        };
      },
      executeTester: async () => ({
        ...pass,
        passed: false,
        summary: "still broken",
        failures: ["still broken"],
        suggestedFixes: ["fix it"],
      }),
    },
  );
  await assert.rejects(() => orchestrator.runUntilComplete());
  const task = orchestrator.getAllTasks()[0];
  assert.equal(task?.status, "failed");
  assert.equal(task?.failureType, "test");
  assert.equal(task?.testerAttempts, 2);
}

async function main(): Promise<void> {
  await testTesterProtocol();
  await testOrchestratorTesterLoop();
  await testTesterRetryLimit();
  console.log("Tester agent tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
