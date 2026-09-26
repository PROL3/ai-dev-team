import assert from "node:assert/strict";
import { test } from "node:test";
import { planner } from "../../src/agents/planner/planner.js";
import type { ProjectPlan } from "../../src/domain/plan.js";

function validPlan(): ProjectPlan {
  return {
    goal: "Build the requested task application",
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
        description: "Set up the architecture",
        owner: "backend",
        dependencies: [],
      },
      {
        id: "task-2",
        title: "API",
        description: "Implement the API",
        owner: "backend",
        dependencies: ["foundation"],
      },
      {
        id: "task-3",
        title: "UI",
        description: "Implement the UI",
        owner: "frontend",
        dependencies: ["foundation", "task-2"],
      },
    ],
  };
}

test("valid plans return unchanged with one LLM call, including fenced JSON", async () => {
  for (const fenced of [false, true]) {
    let calls = 0;
    const plan = validPlan();
    const result = await planner("Build a task application", {
      ask: async () => {
        calls += 1;
        return fenced ? `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` : JSON.stringify(plan);
      },
    });
    assert.deepEqual(result, plan);
    assert.equal(calls, 1);
  }
});

test("missing direct foundation dependency is completed without another LLM call", async (t) => {
  const logs: string[] = [];
  const warnings: string[] = [];
  t.mock.method(console, "log", (message: string) => {
    if (message.startsWith("[planner-log]")) logs.push(message);
  });
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const broken = validPlan();
  broken.tasks[2]!.dependencies = ["task-2"];
  const prompts: string[] = [];
  const result = await planner("Build a task application", {
    ask: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify(broken);
    },
  });
  assert.equal(prompts.length, 1);
  assert.equal(warnings.length, 0);
  assert.deepEqual(result, validPlan());
  assert.deepEqual(result.tasks[2]!.dependencies, ["foundation", "task-2"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /"status":"normalized"/);
  assert.match(logs[0]!, /"addedFoundationDependencies":\["task-3"\]/);
  assert.ok(
    !logs[0]!.includes(JSON.stringify(broken)),
    "normal logs must not dump model responses",
  );
});

test("invalid JSON then invalid schema can recover on the final allowed attempt", async (t) => {
  t.mock.method(console, "warn", () => {});
  const prompts: string[] = [];
  const answers = ["not-json-marker", '{"goal":42}', JSON.stringify(validPlan())];
  const result = await planner("Build a task application", {
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift()!;
    },
  });
  assert.deepEqual(result, validPlan());
  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /invalid JSON/);
  assert.match(prompts[2]!, /invalid plan/);
  assert.ok(!prompts[2]!.includes("not-json-marker"), "repair history must not accumulate");
});

test("graph validation remains enforced during repair", async (t) => {
  t.mock.method(console, "warn", () => {});
  const broken = validPlan();
  broken.tasks[1]!.dependencies.push("task-3");
  let calls = 0;
  const result = await planner("Build a task application", {
    ask: async (prompt) => {
      calls += 1;
      if (calls === 1) return JSON.stringify(broken);
      assert.match(prompt, /Circular dependency detected/);
      return JSON.stringify(validPlan());
    },
  });
  assert.deepEqual(result, validPlan());
  assert.equal(calls, 2);
});

test("persistent invalid plans stop after three attempts with the validation cause", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "warn", (message: string) => logs.push(message));
  const broken = validPlan();
  broken.tasks[2]!.dependencies = ["task-unknown"];
  let calls = 0;
  await assert.rejects(
    () =>
      planner("Build a task application", {
        ask: async () => {
          calls += 1;
          return JSON.stringify(broken);
        },
      }),
    /Planner failed validation after 3 attempts: Task task-3 depends on unknown task task-unknown/,
  );
  assert.equal(calls, 3);
  assert.match(logs[2]!, /"status":"failed"/);
});

test("repair prompt and normal logs bound oversized invalid model output", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "warn", (message: string) => logs.push(message));
  let calls = 0;
  const raw = "x".repeat(100_000);
  await planner("Build a task application", {
    ask: async (prompt) => {
      calls += 1;
      if (calls === 1) return raw;
      assert.match(prompt, /truncated/);
      assert.ok(prompt.length < 32_000);
      return JSON.stringify(validPlan());
    },
  });
  assert.ok(logs.every((line) => line.length < 2_000));
  assert.equal(calls, 2);
});

test("gateway errors are propagated without plan repair or another provider call", async () => {
  let calls = 0;
  const failure = new Error("Provider unavailable");
  await assert.rejects(
    () =>
      planner("Build a task application", {
        ask: async () => {
          calls += 1;
          throw failure;
        },
      }),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
});
