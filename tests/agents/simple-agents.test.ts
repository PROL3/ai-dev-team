import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeTask } from "../../src/agents/implementation/execute-task.js";
import { AgentTools } from "../../src/tools/agent-tools.js";
import { orderSharedOwnership, tasksOverlap } from "../../src/domain/task-ownership.js";
import { validateProjectPlan, type PlanTask } from "../../src/domain/plan.js";
import { planner } from "../../src/agents/planner/planner.js";

const task = (id: string, files: string[]): PlanTask => ({
  id,
  title: id,
  description: `Implement ${id}`,
  owner: "backend",
  dependencies: [],
  files,
});

test("owned directories allow independent implementation and nested tests with a compact prompt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "simple-agent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = task("backend", ["backend/"]);
  const frontend = {
    ...task("frontend", ["public/"]),
    owner: "frontend" as const,
  };
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(path.join(root, "public/index.html"), "preserve UI");
  const actions = [
    { action: "list_files", path: "." },
    {
      action: "write_file",
      path: "backend/lib/service.cjs",
      content: "exports.ready=()=>true;",
    },
    {
      action: "write_file",
      path: "backend/tests/service.test.cjs",
      content:
        "const {test}=require('node:test');const assert=require('node:assert/strict');test('ready',()=>assert.equal(require('../lib/service.cjs').ready(),true));",
    },
    {
      action: "run_command",
      command: "node",
      args: ["--test", "backend/tests/service.test.cjs"],
    },
    { action: "done", summary: "Implemented service and passed task tests." },
  ];
  let first = true;
  const result = await executeTask(
    backend,
    { workspacePath: root, plannedTasks: [backend, frontend] },
    {
      ask: async (prompt) => {
        if (first) {
          assert.ok(prompt.length < 6500, `Prompt too large: ${prompt.length}`);
          first = false;
        }
        assert.match(prompt, /Directories in OWNED PATHS are yours recursively/);
        assert.ok(actions.length);
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.error ?? result.output);
  assert.equal(await fs.readFile(path.join(root, "public/index.html"), "utf8"), "preserve UI");
  assert.deepEqual(result.changedFiles.sort(), [
    "backend/lib/service.cjs",
    "backend/tests/service.test.cjs",
  ]);
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: backend.files!,
  });
  await assert.rejects(tools.writeFile("public/index.html", "bad"), /outside this task/);
  await assert.rejects(tools.writeFile("backend/../public/index.html", "bad"), /outside this task/);
  await fs.symlink(path.join(root, "public"), path.join(root, "backend/link"), "junction");
  await assert.rejects(tools.writeFile("backend/link/index.html", "bad"), /symbolic link/);
});

test("shared ownership is ordered without disabling independent directories or reversing dependencies", () => {
  const a = task("a", ["backend/"]),
    b = task("b", ["BACKEND\\routes/"]),
    c = task("c", ["public/"]);
  const ordered = orderSharedOwnership({ goal: "test", tasks: [a, b, c] });
  assert.deepEqual(ordered.tasks[1]!.dependencies, ["a"]);
  assert.deepEqual(ordered.tasks[2]!.dependencies, []);
  assert.deepEqual(a.dependencies, []);
  assert.equal(tasksOverlap(a, c), false);
  assert.equal(tasksOverlap(task("dot", ["backend/lib/../"]), b), true);
  assert.equal(tasksOverlap(task("legacy", []), c), true);
  const reversed = orderSharedOwnership({
    goal: "test",
    tasks: [{ ...a, dependencies: ["b"] }, b, c],
  });
  validateProjectPlan(reversed);
  assert.deepEqual(reversed.tasks[1]!.dependencies, []);
});

test("Planner requests simple directory-owned tasks and orders actual shared paths", async () => {
  const plan = await planner("Build a minimal service", {
    ask: async (prompt) => {
      assert.match(prompt, /one clear outcome per task/);
      assert.match(prompt, /Directory ownership includes all files and subdirectories/);
      return JSON.stringify({
        goal: "service",
        architecture: {
          runtime: "Node",
          storage: "memory",
          apiBasePath: "/",
          frontend: "none",
          fileLayout: ["backend/"],
          testCommand: "node --test",
        },
        tasks: [
          task("foundation", ["package.json"]),
          { ...task("api", ["backend/"]), dependencies: ["foundation"] },
          {
            ...task("more-api", ["backend/handler.js"]),
            dependencies: ["foundation"],
          },
        ],
      });
    },
  });
  assert.deepEqual(plan.tasks[2]!.dependencies, ["foundation", "api"]);
});

test("Planner tells new project setup to create .gitignore defaults", async () => {
  const plan = await planner("Create a starter app", {
    ask: async (prompt) => {
      assert.match(prompt, /\.gitignore/);
      assert.match(prompt, /node_modules\/|\.env|dist\/|coverage\//);
      return JSON.stringify({
        goal: "starter app",
        architecture: {
          runtime: "Node.js (ESM)",
          storage: "memory",
          apiBasePath: "/",
          frontend: "none",
          fileLayout: ["package.json"],
          testCommand: "node --test",
        },
        tasks: [
          {
            ...task("foundation", ["package.json", ".gitignore"]),
            dependencies: [],
          },
        ],
      });
    },
  });
  assert.ok(plan.tasks[0]?.files);
  assert.equal(plan.tasks[0].files.includes(".gitignore"), true);
});
