import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTools, WriteScopeError } from "../../src/tools/agent-tools.js";
import { runAgent } from "../../src/agents/implementation/run-agent.js";
import { executeTask } from "../../src/agents/implementation/execute-task.js";
import { taskTestDirectory } from "../../src/domain/task-test-scope.js";
import type { PlanTask } from "../../src/domain/plan.js";

const backendTask: PlanTask = {
  id: "foundation",
  title: "Foundation",
  description: "Export 42",
  owner: "backend",
  dependencies: [],
  files: ["server.cjs"],
};

test("test grants are stable, disjoint and respect every planned owner", () => {
  const other: PlanTask = { ...backendTask, id: "other", files: ["other.cjs"] };
  const directory = taskTestDirectory(backendTask, [backendTask, other])!;
  assert.ok(directory.startsWith("tests/agent/foundation-"));
  assert.equal(taskTestDirectory(backendTask, structuredClone([backendTask, other])), directory);
  assert.notEqual(taskTestDirectory(other, [backendTask, other]), directory);
  for (const files of [
    ["tests"],
    [directory],
    [`${directory}/owned.test.cjs`],
    [directory.toUpperCase().replaceAll("/", "\\")],
    ["."],
  ]) {
    assert.equal(taskTestDirectory(backendTask, [backendTask, { ...other, files }]), undefined);
  }
  const { files: _files, ...unrestricted } = other;
  assert.equal(taskTestDirectory(backendTask, [backendTask, unrestricted]), undefined);
  assert.equal(taskTestDirectory({ ...backendTask, owner: "tester" }, [backendTask]), undefined);
  assert.equal(taskTestDirectory(backendTask, []), undefined);
});

test("backend automatically creates and runs its own test without permission to edit shared tests", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-auto-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await fs.writeFile(path.join(root, "server.cjs"), "module.exports = 0;");
  const plannedTasks = [backendTask];
  const directory = taskTestDirectory(backendTask, plannedTasks)!;
  const testFile = `${directory}/foundation.test.cjs`;
  const actions = [
    { action: "list_files", path: "." },
    { action: "read_file", path: "package.json" },
    { action: "read_file", path: "server.cjs" },
    { action: "write_file", path: "tests/test.js", content: "forbidden" },
    { action: "write_file", path: "server.cjs", content: "module.exports = 42;" },
    {
      action: "write_file",
      path: testFile,
      content:
        "const {test}=require('node:test');const assert=require('node:assert/strict');test('foundation',()=>assert.equal(require('../../../server.cjs'),42));",
    },
    { action: "run_command", command: "node", args: ["--test", testFile] },
    { action: "done", summary: "Implemented and validated foundation." },
  ];
  const result = await executeTask(
    backendTask,
    { workspacePath: root, plannedTasks },
    {
      ask: async (prompt) => {
        assert.ok(prompt.includes(directory));
        assert.match(prompt, /do not retry that path/);
        assert.ok(actions.length, prompt);
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.error ?? result.output);
  assert.ok(result.changedFiles.includes(testFile));
  await assert.rejects(fs.access(path.join(root, "tests/test.js")));
});

test("automatic test scope cannot escape into another task or follow directory links", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = taskTestDirectory(backendTask, [backendTask])!;
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: [...backendTask.files!, directory],
    assignedTestDirectory: directory,
  });
  await assert.rejects(tools.writeFile(`${directory}/../other.test.cjs`, "bad"), WriteScopeError);
  await assert.rejects(tools.writeFile("frontend.js", "bad"), WriteScopeError);
  await fs.mkdir(path.join(root, "source"));
  await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.symlink(path.join(root, "source"), path.join(root, directory, "escape"), "junction");
  await assert.rejects(tools.writeFile(`${directory}/escape/app.cjs`, "bad"), /symbolic link/);
  await assert.rejects(fs.access(path.join(root, "source/app.cjs")));
});

test("agent receives explicit scope feedback and validates only its task despite another failing test", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-task-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await fs.writeFile(path.join(root, "feature.cjs"), "module.exports = 0;\n");
  await fs.writeFile(path.join(root, "other.cjs"), "preserve another task's file\n");
  await fs.writeFile(
    path.join(root, "tests", "feature.test.cjs"),
    "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('assigned feature',()=>assert.equal(require('../feature.cjs'),42));\n",
  );
  await fs.writeFile(
    path.join(root, "tests", "unrelated.test.cjs"),
    "throw new Error('Unrelated unfinished task must not run here');\n",
  );
  const actions = [
    { action: "list_files", path: "." },
    { action: "read_file", path: "package.json" },
    { action: "list_files", path: "tests" },
    { action: "read_file", path: "tests/feature.test.cjs" },
    { action: "write_file", path: "other.cjs", content: "unwanted change" },
    { action: "write_file", path: "feature.cjs", content: "module.exports = 42;\n" },
    { action: "run_command", command: "node", args: ["--test", "tests/feature.test.cjs"] },
    { action: "done", summary: "Implemented feature and passed its targeted test." },
  ];
  const prompts: string[] = [];
  const result = await runAgent(
    {
      id: "feature",
      title: "Feature",
      description: "Export 42",
      owner: "backend",
      dependencies: [],
      files: ["feature.cjs"],
    },
    root,
    undefined,
    {
      budget: { softMaxSteps: 10, hardMaxSteps: 12 },
      ask: async (prompt) => {
        prompts.push(prompt);
        assert.ok(actions.length);
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.match(
    prompts[0]!,
    /Validate your own task with the smallest relevant existing check first/,
  );
  assert.match(prompts[0]!, /Broader checks must be justified by the task and project scripts/);
  assert.match(
    prompts[5]!,
    /WRITE_FILE_FAILED: other\.cjs is NOT in your allowed files list \(feature\.cjs\)/,
  );
  assert.match(
    prompts[5]!,
    /Do NOT attempt to write or fix this file\. Focus only on your assigned files/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "other.cjs"), "utf8"),
    "preserve another task's file\n",
  );
  const commands = result.audit.filter((entry) => entry.action === "run_command");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.command, "node --test tests/feature.test.cjs");
  assert.equal(commands[0]!.success, true);
  assert.deepEqual(result.changedFiles, ["feature.cjs"]);
});

test("scope checks normalize dot segments and cannot be bypassed through an allowed directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-write-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: ["src/feature"],
  });
  for (const target of ["src/feature/../other.cjs", "src\\feature\\..\\other.cjs", "other.cjs"]) {
    await assert.rejects(tools.writeFile(target, "forbidden"), (error: unknown) => {
      assert.ok(error instanceof WriteScopeError);
      assert.match(error.message, /allowed files list \(src\/feature\)/);
      assert.match(error.message, /Do NOT attempt to write or fix this file/);
      return true;
    });
  }
  await tools.writeFile("./src/feature/./valid.cjs", "allowed");
  assert.equal(
    await fs.readFile(path.join(root, "src", "feature", "valid.cjs"), "utf8"),
    "allowed",
  );
  await assert.rejects(fs.access(path.join(root, "src", "other.cjs")));
});
