import assert from "node:assert/strict";
import { test } from "node:test";
import { progressCommand, withProgress } from "../../src/infrastructure/logging/progress.js";

test("progress reports waiting and clears its timer on completion and failure without changing the result", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish!: (value: string) => void;
  const pending = withProgress(
    "agent.llm",
    { taskId: "foundation", step: 3 },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  t.mock.timers.tick(15_000);
  assert.ok(
    lines.some(
      (line) => line.includes('"event":"waiting"') && line.includes('"taskId":"foundation"'),
    ),
  );
  finish("private model response");
  assert.equal(await pending, "private model response");
  const count = lines.length;
  t.mock.timers.tick(30_000);
  assert.equal(lines.length, count);
  assert.ok(!lines.join("\n").includes("private model response"));

  const failure = new Error("private provider response");
  await assert.rejects(
    withProgress("agent.llm", { taskId: "foundation" }, async () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  const failedCount = lines.length;
  t.mock.timers.tick(30_000);
  assert.equal(lines.length, failedCount);
  assert.ok(lines.at(-1)!.includes('"event":"error"'));
  assert.ok(!lines.join("\n").includes(failure.message));
});

test("progress logging failures cannot fail work, and command labels omit inline code and credentials", async (t) => {
  t.mock.method(console, "log", () => {
    throw new Error("closed output");
  });
  assert.equal(
    await withProgress("tool", {}, async () => 42, {
      details: () => {
        throw new Error("bad log formatter");
      },
    }),
    42,
  );
  assert.equal(progressCommand("node", ["-e", "private code"]), "node");
  assert.equal(progressCommand("npm", ["test", "--", "--token=secret"]), "npm test");
  assert.equal(progressCommand("npm", ["run", "typecheck"]), "npm run typecheck");
});
