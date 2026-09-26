import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  collectAgentContext,
  formatAgentContext,
} from "../../src/agents/implementation/workspace-context.js";
import { runAgent } from "../../src/agents/implementation/run-agent.js";
import { taskTestDirectory } from "../../src/domain/task-test-scope.js";
import type { PlanTask } from "../../src/domain/plan.js";
import type { AgentSession } from "../../src/domain/workflow-state.js";

const task: PlanTask = {
  id: "foundation",
  title: "Foundation",
  description: "Export ready=true and verify it",
  owner: "backend",
  dependencies: [],
  files: ["package.json", "server.cjs"],
};
const directory = taskTestDirectory(task, [task])!;
const testFile = `${directory}/ready.test.cjs`;
const write = (file: string, content: string) => ({ action: "write_file", path: file, content });
const testSource =
  "const {test}=require('node:test');const assert=require('node:assert/strict');test('ready',()=>assert.equal(require('../../../server.cjs').ready,true));";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "commonjs",
      scripts: { test: "node --test" },
      dependencies: { express: "^4.17.1" },
    }),
  );
  await fs.writeFile(path.join(root, "server.cjs"), "exports.ready = false;");
  return root;
}

test("context supplies actual source, package scripts, missing paths and directory grants before any model action", async (t) => {
  const root = await fixture(t);
  const context = await collectAgentContext(
    root,
    { ...task, files: [...task.files!, "new.cjs"] },
    directory,
  );
  assert.equal(context.rootReadable, true);
  assert.deepEqual(context.ownedPaths, [
    { path: "package.json", state: "file" },
    { path: "server.cjs", state: "file" },
    { path: "new.cjs", state: "missing" },
  ]);
  assert.deepEqual(context.testDirectory, { path: directory, state: "missing" });
  assert.equal(
    context.files.find((file) => file.path === "server.cjs")!.content,
    "exports.ready = false;",
  );
  assert.deepEqual(context.packages[0]!.dependencies, ["express"]);
  assert.deepEqual(
    context.validationCandidates.map((candidate) => candidate.args),
    [["run", "test"]],
  );
  assert.match(formatAgentContext(context), /commands have NOT been run/);
  assert.match(formatAgentContext(context), /not proof of installation/);
  assert.equal(
    context.entries.some((entry) => entry.path === "new.cjs"),
    false,
  );
});

test("automatic context excludes secrets, dependencies and symbolic links, including explicit planned paths", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, ".env"), "SECRET_KEY=do-not-read");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules/hidden.js"), "dependency-secret");
  await fs.mkdir(path.join(root, "private"));
  await fs.writeFile(path.join(root, "private/secret.txt"), "link-secret");
  await fs.symlink(path.join(root, "private"), path.join(root, "linked"), "junction");
  const context = await collectAgentContext(root, {
    ...task,
    files: [".env", "node_modules/hidden.js", "linked/secret.txt", "../outside.js"],
  });
  assert.ok(context.ownedPaths.every((entry) => entry.state === "unavailable"));
  assert.doesNotMatch(formatAgentContext(context), /do-not-read|dependency-secret|link-secret/);
  assert.equal(
    context.entries.some((entry) => /node_modules|linked|\.env/.test(entry.path)),
    false,
  );
});

test("context reports invalid configuration and a file obstructing the test directory without editing them", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "package.json"), "```json\n{}\n```");
  await fs.mkdir(path.join(root, "tests/agent"), { recursive: true });
  await fs.writeFile(path.join(root, directory), "old misplaced test");
  const context = await collectAgentContext(root, task, directory);
  assert.equal(context.testDirectory?.state, "file");
  assert.match(context.warnings.join("\n"), /layout needs repair/);
  assert.match(context.warnings.join("\n"), /invalid JSON/);
  assert.deepEqual(context.validationCandidates, []);
  assert.equal(await fs.readFile(path.join(root, directory), "utf8"), "old misplaced test");
});

test("only observed runnable scripts and genuine Node test imports become validation candidates", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, "package.json"),
    '{"scripts":{"test":"npm test","typecheck":"tsc --noEmit","start":"node server.cjs"}}',
  );
  await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, testFile), testSource);
  const context = await collectAgentContext(root, task, directory);
  assert.deepEqual(context.validationCandidates[0]!.args, ["--test", testFile]);
  assert.deepEqual(context.validationCandidates[1]!.args, ["run", "typecheck"]);
  assert.equal(context.validationCandidates.length, 2);
  assert.match(context.warnings.join("\n"), /Recursive npm script/);
});

test("nested package candidates retain their working directory and bounded large manifests expose scripts", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "backend"));
  await fs.writeFile(
    path.join(root, "backend/package.json"),
    JSON.stringify({ description: "x".repeat(3000), scripts: { lint: "eslint ." } }),
  );
  const context = await collectAgentContext(root, { ...task, files: ["backend/"] });
  assert.equal(
    context.validationCandidates.find((candidate) => candidate.args[1] === "lint")?.cwd,
    "backend",
  );
  const content = context.files.find((file) => file.path === "backend/package.json")!;
  assert.equal(content.truncated, true);
  assert.ok(content.content.length <= 2048);
});

test("unavailable workspaces return honest incomplete evidence instead of crashing", async (t) => {
  const root = await fixture(t);
  const context = await collectAgentContext(path.join(root, "absent"), task, directory);
  assert.equal(context.rootReadable, false);
  assert.deepEqual(context.files, []);
  assert.deepEqual(context.validationCandidates, []);
});

test("context remains bounded in large repositories and marks partial observations", async (t) => {
  const root = await fixture(t);
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      fs.writeFile(path.join(root, `file-${index}.js`), "x".repeat(5000)),
    ),
  );
  const context = await collectAgentContext(root, {
    ...task,
    files: Array.from({ length: 25 }, (_, index) => `file-${index}.js`),
  });
  assert.equal(context.truncated, true);
  assert.ok(context.entries.length <= 60);
  assert.ok(context.files.length <= 6);
  assert.ok(context.ownedPaths.length <= 16);
  assert.ok(formatAgentContext(context).length < 11000);
});

test("prepared agent creates its actual test, diagnoses a real failure and repairs source in one attempt", async (t) => {
  const root = await fixture(t);
  const actions: unknown[] = [
    write(testFile, testSource),
    { action: "run_command", command: "node", args: ["--test", testFile] },
    write("server.cjs", "exports.ready = true;"),
    { action: "run_command", command: "node", args: ["--test", testFile] },
    { action: "done", summary: "Implemented ready=true and passed the task's test." },
  ];
  const prompts: string[] = [];
  const result = await runAgent(
    task,
    root,
    { assignedTestDirectory: directory },
    {
      ask: async (prompt) => {
        prompts.push(prompt);
        assert.ok(actions.length, "Unexpected model call");
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.equal(result.steps, 5);
  assert.match(prompts[0]!, /Workspace inspection is already supplied/);
  assert.match(prompts[0]!, /exports.ready = false/);
  assert.match(prompts[0]!, /"testDirectory":\{"path":.*"state":"missing"\}/);
  assert.doesNotMatch(
    prompts[0]!,
    /"path":"actual path"|"path":"owned path"|actual task test file/,
  );
  assert.ok(prompts[1]!.includes(testFile));
  assert.match(prompts[2]!, /VALIDATION RECOVERY/);
  assert.match(prompts[2]!, /false !== true/);
  assert.match(prompts[3]!, /exports.ready = true/);
  assert.deepEqual(
    result.audit.filter((entry) => entry.action === "run_command").map((entry) => entry.success),
    [false, true],
  );
  assert.equal(
    result.audit.some((entry) => entry.action === "read_file" || entry.action === "list_files"),
    false,
  );
});

test("resume rebuilds context from current files without consuming or renewing the saved step budget", async (t) => {
  const root = await fixture(t);
  let saved: AgentSession | undefined;
  await assert.rejects(
    runAgent(task, root, undefined, {
      ask: async () => JSON.stringify(write("server.cjs", "exports.ready = true;")),
      onCheckpoint: async (session) => {
        if (session.nextStep === 2) {
          saved = structuredClone(session);
          throw new Error("interrupted");
        }
      },
    }),
    /interrupted/,
  );
  assert.ok(saved);
  await fs.writeFile(path.join(root, "server.cjs"), "exports.ready = 'external-change';");
  const resumed = await runAgent(task, root, undefined, {
    resumeSession: saved,
    ask: async (prompt) => {
      assert.match(prompt, /external-change/);
      assert.match(prompt, /STEP: 2\/40/);
      return JSON.stringify({ action: "done", summary: "Existing changes retained." });
    },
  });
  assert.equal(resumed.steps, 2);
  assert.equal(resumed.success, true);
});

test("an invented read receives fresh real paths and can recover within the same attempt", async (t) => {
  const root = await fixture(t);
  const actions: unknown[] = [
    { action: "read_file", path: "actual path" },
    write("server.cjs", "exports.ready = true;"),
    { action: "run_command", command: "node", args: ["--check", "server.cjs"] },
    { action: "done", summary: "Source updated and syntax checked." },
  ];
  const result = await runAgent(task, root, undefined, {
    ask: async (prompt) => {
      if (actions.length === 3) {
        assert.match(prompt, /READ_FILE_FAILED: actual path/);
        const snapshot = prompt.split("WORKSPACE SNAPSHOT")[1]!.split("ACTUAL TOOL EVIDENCE")[0]!;
        assert.match(snapshot, /"path":"server.cjs","state":"file"/);
        assert.match(snapshot, /exports.ready = false/);
        assert.doesNotMatch(snapshot, /"path":"actual path"/);
      }
      assert.ok(actions.length);
      return JSON.stringify(actions.shift());
    },
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(result.steps, 4);
  assert.equal(result.audit.filter((entry) => !entry.success).length, 1);
});
