import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runAgent, type AgentRunnerOptions } from "../../src/agents/implementation/run-agent.js";
import { AgentTools, type CommandResult } from "../../src/tools/agent-tools.js";

const task = {
  id: "recovery",
  title: "Repair feature",
  description: "Implement and validate the feature",
  owner: "backend" as const,
  dependencies: [],
};
const write = (content: string) => ({ action: "write_file", path: "server.js", content });
const check = { action: "run_command", command: "npm", args: ["test"] };
const done = { action: "done", summary: "Implemented and checked." };
const success: CommandResult = { stdout: "ok", stderr: "", exitCode: 0 };

async function runScenario(
  t: TestContext,
  actions: unknown[],
  command: NonNullable<AgentRunnerOptions["tools"]>["runCommand"],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "contract.txt"),
    "GET /health must return status 200 and ok:true",
  );
  const realTools = new AgentTools({ role: "backend", workspacePath: root });
  const prompts: string[] = [];
  const result = await runAgent(task, root, undefined, {
    tools: {
      readFile: (file) => realTools.readFile(file),
      writeFile: (file, content) => realTools.writeFile(file, content),
      listFiles: (directory) => realTools.listFiles(directory),
      runCommand: command,
    },
    ask: async (prompt) => {
      prompts.push(prompt);
      assert.ok(actions.length, "Unexpected model request");
      return JSON.stringify(actions.shift());
    },
    budget: { softMaxSteps: 18, hardMaxSteps: 22 },
  });
  return { result, prompts };
}

test("recovery retains evidence and permits diagnosis plus dependency installation without arbitrary edits", async (t) => {
  const calls: string[] = [];
  let installed = false;
  const { result, prompts } = await runScenario(
    t,
    [
      { action: "list_files", path: "." },
      { action: "read_file", path: "contract.txt" },
      write("const app = require('express')();"),
      check,
      {
        action: "diagnose",
        category: "dependency",
        hypothesis: "express is not installed",
        evidence: ["Cannot find module 'express'"],
        nextStep: "Inspect package configuration and install approved dependencies",
      },
      { action: "run_command", command: "git", args: ["diff"] },
      check, // Guarded: diagnosis and a different successful check do not fix a failure.
      { action: "run_command", command: "npm", args: ["install"] },
      check,
      done,
    ],
    async (command) => {
      calls.push(`${command.command} ${command.args.join(" ")}`);
      if (command.args[0] === "install") installed = true;
      if (command.args[0] === "test" && !installed) {
        return { stdout: "", stderr: "Cannot find module 'express'", exitCode: 1 };
      }
      return success;
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.deepEqual(calls, ["npm test", "git diff", "npm install", "npm test"]);
  assert.equal(result.audit.filter((entry) => entry.action === "write_file").length, 1);
  assert.match(prompts[6]!, /GET \/health must return status 200/);
  assert.match(prompts[6]!, /Cannot find module 'express'/);
  assert.match(prompts[6]!, /Latest diagnosis.*express is not installed/);
});

test("a runner-reported transient error allows one unchanged retry without rewriting source", async (t) => {
  let calls = 0;
  const { result } = await runScenario(t, [write("implemented"), check, check, done], async () => {
    calls += 1;
    return calls === 1
      ? {
          stdout: "",
          stderr: "temporary runner failure",
          exitCode: 1,
          executionError: { code: "EAGAIN", message: "temporary runner failure" },
        }
      : success;
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(calls, 2);
});

test("an unchanged write cannot unlock a failing command and ignored feedback terminates", async (t) => {
  let calls = 0;
  const { result } = await runScenario(
    t,
    [write("broken"), check, write("broken"), check, check, check],
    async () => {
      calls += 1;
      return { stdout: "404 !== 200", stderr: "", exitCode: 1 };
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.failureType, "validation");
  assert.equal(calls, 1);
  assert.match(result.summary, /unchanged failing command/);
});

test("successful diagnostics cannot hide an unresolved validation at completion", async (t) => {
  let checks = 0;
  const { result } = await runScenario(
    t,
    [
      write("broken"),
      check,
      { action: "run_command", command: "node", args: ["--version"] },
      done,
      write("fixed"),
      check,
      done,
    ],
    async (command) => {
      if (command.command !== "npm" || ++checks > 1) return success;
      return { stdout: "404 !== 200", stderr: "", exitCode: 1 };
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.equal(result.audit.filter((entry) => entry.action === "done" && !entry.success).length, 1);
});

test("distinct corrective writes give fresh attempts without removing the hard execution budget", async (t) => {
  let checks = 0;
  const { result } = await runScenario(
    t,
    [
      write("attempt 1"),
      check,
      write("attempt 2"),
      check,
      write("attempt 3"),
      check,
      write("attempt 4"),
      check,
      done,
    ],
    async () =>
      ++checks < 4 ? { stdout: `remaining failure ${checks}`, stderr: "", exitCode: 1 } : success,
  );
  assert.equal(result.success, true, result.summary);
  assert.equal(checks, 4);
  assert.ok(result.steps <= 22);
});

test("persistent execution errors do not allow unlimited unchanged command retries", async (t) => {
  let calls = 0;
  const { result } = await runScenario(
    t,
    [write("implemented"), check, check, check, check, check],
    async () => {
      calls += 1;
      return {
        stdout: "",
        stderr: "runner unavailable",
        exitCode: 1,
        executionError: { code: "ENOENT", message: "runner unavailable" },
      };
    },
  );
  assert.equal(result.success, false);
  assert.equal(calls, 2);
});
