import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeFoundationDependencies,
  validateFoundationTask,
  type ProjectPlan,
} from "../../src/domain/plan.js";
import { createTaskState, getReadyTasks } from "../../src/domain/scheduler.js";
import { planner } from "../../src/agents/planner/planner.js";

function plan(): ProjectPlan {
  return {
    goal: "Build an application",
    architecture: {
      runtime: "Node.js",
      storage: "in-memory",
      apiBasePath: "/tasks",
      frontend: "plain JavaScript",
      fileLayout: ["server.js", "public/"],
      testCommand: "npm test",
    },
    tasks: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Set up the project",
        owner: "backend",
        dependencies: [],
      },
      {
        id: "backend",
        title: "API",
        description: "Build the API",
        owner: "backend",
        dependencies: [],
      },
      {
        id: "frontend",
        title: "UI",
        description: "Build the UI",
        owner: "frontend",
        dependencies: [],
      },
      {
        id: "tests",
        title: "Tests",
        description: "Test the application",
        owner: "tester",
        dependencies: ["backend", "frontend"],
      },
    ],
  };
}

test("adds foundation to every other task while preserving existing edges and metadata", () => {
  const source = plan();
  const before = structuredClone(source);
  const result = normalizeFoundationDependencies(source);
  assert.deepEqual(
    result.tasks.map((task) => task.dependencies),
    [[], ["foundation"], ["foundation"], ["foundation", "backend", "frontend"]],
  );
  assert.deepEqual(source, before, "normalization must not mutate the supplied plan");
  assert.deepEqual(
    result.tasks.map(({ dependencies: _, ...task }) => task),
    source.tasks.map(({ dependencies: _, ...task }) => task),
  );
  assert.equal(result.goal, source.goal);
  assert.equal(result.architecture, source.architecture);
});

test("deduplicates dependency IDs stably and is idempotent", () => {
  const source = plan();
  source.tasks[3]!.dependencies = ["backend", "foundation", "backend", "frontend", "foundation"];
  const result = normalizeFoundationDependencies(source);
  assert.deepEqual(result.tasks[3]!.dependencies, ["backend", "foundation", "frontend"]);
  assert.strictEqual(normalizeFoundationDependencies(result), result);
  assert.deepEqual(result.tasks[0]!.dependencies, []);
});

test("does not invent, reorder, or repair an invalid foundation task", () => {
  const variants: Array<{ change: (value: ProjectPlan) => void; error: RegExp }> = [
    {
      change: (value) => {
        value.tasks = [];
      },
      error: /must include a foundation task/,
    },
    {
      change: (value) => {
        value.tasks.shift();
      },
      error: /first task must be a backend foundation/,
    },
    {
      change: (value) => {
        value.tasks.push(value.tasks.shift()!);
      },
      error: /first task must be a backend foundation/,
    },
    {
      change: (value) => {
        value.tasks[0]!.owner = "frontend";
      },
      error: /first task must be a backend foundation/,
    },
    {
      change: (value) => {
        value.tasks[0]!.dependencies = ["backend"];
      },
      error: /no dependencies/,
    },
    {
      change: (value) => {
        delete value.architecture;
      },
      error: /shared architecture contract/,
    },
    {
      change: (value) => {
        value.tasks.push({ ...value.tasks[0]! });
      },
      error: /Duplicate task ID/,
    },
  ];
  for (const { change, error } of variants) {
    const source = plan();
    change(source);
    const before = structuredClone(source);
    assert.throws(() => normalizeFoundationDependencies(source), error);
    assert.deepEqual(source, before);
  }
});

test("missing foundation edges never hide unknown references, self references, or cycles", () => {
  const unknown = plan();
  unknown.tasks[1]!.dependencies = ["not-a-task"];
  assert.throws(() => normalizeFoundationDependencies(unknown), /unknown task not-a-task/);

  const self = plan();
  self.tasks[1]!.dependencies = ["backend"];
  assert.throws(() => normalizeFoundationDependencies(self), /cannot depend on itself/);

  const cycle = plan();
  cycle.tasks[1]!.dependencies = ["frontend"];
  cycle.tasks[2]!.dependencies = ["backend"];
  assert.throws(() => normalizeFoundationDependencies(cycle), /Circular dependency/);
});

test("strict foundation validation still rejects missing edges without normalization", () => {
  assert.throws(
    () => validateFoundationTask(plan()),
    /must directly depend on the foundation task/,
  );
});

test("scheduler waits for foundation once, then preserves parallel readiness and later dependencies", () => {
  const tasks = createTaskState(normalizeFoundationDependencies(plan()));
  assert.deepEqual(
    getReadyTasks(tasks).map((task) => task.id),
    ["foundation"],
  );
  tasks[0]!.status = "completed";
  assert.deepEqual(
    getReadyTasks(tasks).map((task) => task.id),
    ["backend", "frontend"],
  );
  tasks[1]!.status = "completed";
  assert.deepEqual(
    getReadyTasks(tasks).map((task) => task.id),
    ["frontend"],
  );
  tasks[2]!.status = "completed";
  assert.deepEqual(
    getReadyTasks(tasks).map((task) => task.id),
    ["tests"],
  );
  tasks[3]!.status = "completed";
  assert.deepEqual(getReadyTasks(tasks), []);
});

test("Planner still asks the model to repair invalid foundation configuration", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  let calls = 0;
  const invalid = plan();
  invalid.tasks[0]!.owner = "tester";
  const result = await planner("Build an application", {
    ask: async (prompt) => {
      calls += 1;
      if (calls === 1) return JSON.stringify(invalid);
      assert.match(prompt, /first task must be a backend foundation/);
      return JSON.stringify(plan());
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, normalizeFoundationDependencies(plan()));
});
