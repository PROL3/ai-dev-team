import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { AgentTools } from "../../src/tools/agent-tools.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import {
  assertNpmScriptIsRunnable,
  parseNpmScripts,
} from "../../src/tools/commands/npm-validation.js";
import { runTester, TesterExecutionError } from "../../src/agents/tester/run-tester.js";
import { runAgent } from "../../src/agents/implementation/run-agent.js";

const execFileAsync = promisify(execFile);
const pass = {
  passed: true,
  summary: "Implemented and validated.",
  testsRun: ["npm test"],
  failures: [],
  warnings: [],
  changedFiles: [],
  suggestedFixes: [],
};
const task = {
  id: "foundation",
  title: "Foundation",
  description: "Provide executable project setup",
  owner: "backend" as const,
  dependencies: [],
};

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, windowsHide: true, shell: false });
}

test("Git status preserves the first unstaged filename, Unicode, nested files, and rename paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "old name.txt"), "rename me");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  const manager = new WorkspaceManager(root);
  const workspace = { path: root, taskId: "test", branchName: "main", baseCommit: "" };
  assert.deepEqual(await manager.getChangedFiles(workspace), []);
  await fs.writeFile(path.join(root, "package.json"), '{"private":true}');
  assert.deepEqual(await manager.getChangedFiles(workspace), ["package.json"]);
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "שלום file.txt"), "new");
  await git(root, ["mv", "old name.txt", "new name.txt"]);
  assert.deepEqual(
    new Set(await manager.getChangedFiles(workspace)),
    new Set(["package.json", "nested/שלום file.txt", "new name.txt", "old name.txt"]),
  );
});

test("npm preflight detects direct, indirect, chained, alias and lifecycle recursion", () => {
  for (const scripts of [
    { test: "npm test" },
    { test: "npm run test" },
    { test: 'npm.cmd run-script "test"' },
    { test: "echo starting && npm t" },
    { test: "npm run verify", verify: "npm test" },
    { test: "node --test", pretest: "npm test" },
    { test: "node --test", posttest: "npm run test" },
  ]) {
    assert.throws(() => assertNpmScriptIsRunnable(scripts, "test"), /Recursive npm script/);
  }
  assert.doesNotThrow(() =>
    assertNpmScriptIsRunnable(
      {
        test: "npm run unit && npm run unit",
        unit: "node --test",
        pretest: "node --version",
      },
      "test",
    ),
  );
  assert.doesNotThrow(() =>
    assertNpmScriptIsRunnable({ test: 'echo "npm test" && node --test' }, "test"),
  );
});

test("package parser rejects malformed configuration instead of hiding it as no scripts", () => {
  for (const raw of [
    "invalid",
    "[]",
    '{"scripts":[]}',
    '{"scripts":{"test":42}}',
    '{"scripts":{"test":""}}',
  ]) {
    assert.throws(() => parseNpmScripts(raw));
  }
  assert.deepEqual(parseNpmScripts("{}"), {});
});

test("AgentTools and Tester refuse recursive scripts before execution or LLM review", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-recursion-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"npm test"}}');
  const tools = new AgentTools({ role: "backend", workspacePath: root });
  const command = await tools.runCommand({ command: "npm", args: ["test"] });
  assert.equal(command.exitCode, 1);
  assert.match(command.validationError!, /test -> test/);
  assert.equal(command.executionError, undefined);
  const result = await runTester(
    { task, workspacePath: root, changedFiles: ["package.json"], previousAgentSummary: "setup" },
    {
      ask: async () => {
        assert.fail("A known configuration failure must not reach the LLM");
      },
    },
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.testsRun, []);
  assert.match(result.failures[0]!, /Recursive npm script/);
  assert.ok(!result.failures.some((failure) => failure.includes("No supported")));
});

test("npm cannot fall back to a parent package when the workspace has none", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-parent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = path.join(root, "child");
  await fs.mkdir(child);
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"npm test"}}');
  const result = await new AgentTools({ role: "tester", workspacePath: child }).runCommand({
    command: "npm",
    args: ["test"],
  });
  assert.match(result.validationError!, /parent project's npm script/);
});

test("Tester command failures bypass stale reviewer feedback; retries use only fresh evidence", async () => {
  let exitCode = 1;
  let reviews = 0;
  const tools = {
    listFiles: async () => ["package.json", "server.js"],
    readFile: async (file: string) =>
      file === "package.json" ? '{"scripts":{"test":"node --test"}}' : "export const ok = true;",
    runCommand: async () => ({ stdout: "", stderr: exitCode ? "expected true" : "", exitCode }),
  };
  const request = {
    task,
    workspacePath: "/unused",
    changedFiles: ["server.js"],
    previousAgentSummary: "setup",
  };
  const ask = async (prompt: string) => {
    reviews += 1;
    assert.ok(!prompt.includes("No supported validation scripts"));
    return JSON.stringify(pass);
  };
  const first = await runTester(request, { tools, ask });
  assert.equal(reviews, 0);
  assert.match(first.failures[0]!, /expected true/);
  exitCode = 0;
  const second = await runTester(
    {
      ...request,
      previousTesterResult: {
        ...first,
        summary: "No supported validation scripts",
        failures: ["No supported validation scripts"],
        suggestedFixes: ["Recheck setup"],
      },
    },
    { tools, ask },
  );
  assert.equal(second.passed, true);
  assert.equal(reviews, 1);
  assert.deepEqual(second.failures, []);
});

test("Tester lists actual directories and does not read invented changed paths", async () => {
  const reads: string[] = [];
  const result = await runTester(
    {
      task,
      workspacePath: "/unused",
      changedFiles: ["ackage.json", "src/server.js"],
      previousAgentSummary: "setup",
    },
    {
      tools: {
        listFiles: async (directory) =>
          directory === "." ? ["package.json", "src/"] : ["server.js"],
        readFile: async (file) => {
          reads.push(file);
          return file === "package.json"
            ? '{"scripts":{"test":"node --test"}}'
            : "export const ok = true;";
        },
        runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
      ask: async () => JSON.stringify(pass),
    },
  );
  assert.deepEqual(reads, ["src/server.js", "package.json"]);
  assert.match(result.warnings.join("\n"), /ackage.json/);
});

test("Tester reports zero discovered Node tests as incomplete validation", async () => {
  const result = await runTester(
    { task, workspacePath: "/unused", changedFiles: [], previousAgentSummary: "setup" },
    {
      tools: {
        listFiles: async () => ["package.json"],
        readFile: async () => '{"scripts":{"test":"node --test"}}',
        runCommand: async () => ({
          stdout: "TAP version 13\n# tests 0\n# pass 0\n",
          stderr: "",
          exitCode: 0,
        }),
      },
      ask: async () => {
        assert.fail("Do not claim pass for zero executed tests");
      },
    },
  );
  assert.equal(result.passed, false);
  assert.match(result.summary, /zero tests/);
});

test("Tester protocol errors retain command evidence and request tester-only retries", async () => {
  await assert.rejects(
    () =>
      runTester(
        { task, workspacePath: "/unused", changedFiles: [], previousAgentSummary: "setup" },
        {
          tools: {
            listFiles: async () => ["package.json"],
            readFile: async () => '{"scripts":{"test":"node --test"}}',
            runCommand: async () => ({ stdout: "tests passed", stderr: "", exitCode: 0 }),
          },
          ask: async () => "invalid JSON",
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof TesterExecutionError);
      assert.deepEqual(error.result.testsRun, ["npm test"]);
      return true;
    },
  );
});

test("implementation can finish after correcting and rerunning the same failed command", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actions = [
    { action: "list_files", path: "." },
    { action: "write_file", path: "check.cjs", content: "process.exit(1);" },
    { action: "run_command", command: "node", args: ["check.cjs"] },
    { action: "write_file", path: "check.cjs", content: "process.exit(0);" },
    { action: "run_command", command: "node", args: ["check.cjs"] },
    { action: "done", summary: "Fixed validation and reran it successfully." },
  ];
  const result = await runAgent(task, root, undefined, {
    ask: async () => {
      assert.ok(actions.length);
      return JSON.stringify(actions.shift());
    },
    budget: { softMaxSteps: 8, hardMaxSteps: 8 },
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(result.steps, 6);
  assert.deepEqual(
    result.audit.filter((entry) => entry.action === "run_command").map((entry) => entry.success),
    [false, true],
  );
});

test("failed validation preserves evidence and blocks an unchanged rerun until a repair", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-repair-first-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "node --test tests/foundation.test.cjs" },
    }),
  );
  await fs.writeFile(
    path.join(root, "server.cjs"),
    "exports.createServer = () => require('node:http').createServer((req, res) => { res.statusCode = 500; res.end(); });\n",
  );
  await fs.writeFile(
    path.join(root, "tests", "foundation.test.cjs"),
    [
      'const assert = require("node:assert/strict");',
      'const test = require("node:test");',
      'const { createServer } = require("../server.cjs");',
      'test("GET /health returns 200 with ok true", async (t) => {',
      "  const server = createServer();",
      "  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));",
      '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
      "  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);",
      "  assert.equal(response.status, 200);",
      "  assert.deepEqual(await response.json(), { ok: true });",
      "});",
      "",
    ].join("\n"),
  );

  const prompts: string[] = [];
  const actions = [
    { action: "list_files", path: "." },
    { action: "read_file", path: "server.cjs" },
    {
      action: "write_file",
      path: "server.cjs",
      content:
        "exports.createServer = () => require('node:http').createServer((req, res) => { res.statusCode = 404; res.end(); });\n",
    },
    { action: "run_command", command: "npm", args: ["test"] },
    // This is deliberately wrong. The runner must block it rather than execute it.
    { action: "run_command", command: "npm", args: ["test"] },
    { action: "read_file", path: "tests/foundation.test.cjs" },
    { action: "read_file", path: "server.cjs" },
    {
      action: "write_file",
      path: "server.cjs",
      content:
        "exports.createServer = () => require('node:http').createServer((req, res) => { if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); } else { res.statusCode = 404; res.end(); } });\n",
    },
    { action: "run_command", command: "npm", args: ["test"] },
    { action: "done", summary: "Implemented the required health endpoint and verified it." },
  ];

  const result = await runAgent(task, root, undefined, {
    ask: async (prompt) => {
      prompts.push(prompt);
      const action = actions.shift();
      assert.ok(action, "unexpected extra agent step");
      return JSON.stringify(action);
    },
    budget: { softMaxSteps: 12, hardMaxSteps: 14 },
  });

  assert.equal(result.success, true, result.summary);
  assert.equal(
    result.audit.filter((entry) => entry.action === "run_command").length,
    2,
    "the duplicate failed command must not execute",
  );
  assert.ok(result.audit.some((entry) => entry.action === "validation_recovery_blocked"));
  assert.match(prompts[4] ?? "", /VALIDATION RECOVERY \(MANDATORY\)/);
  assert.match(prompts[4] ?? "", /tests\/foundation\.test\.cjs/);
});
