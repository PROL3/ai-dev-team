import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runAgent } from "../../src/agents/implementation/run-agent.js";
import { taskTestDirectory } from "../../src/domain/task-test-scope.js";
import type { PlanTask } from "../../src/domain/plan.js";
import type { AgentSession } from "../../src/domain/workflow-state.js";

const task: PlanTask = {
  id: "foundation",
  title: "Foundation",
  description: "Export ready=true and test it",
  owner: "backend",
  dependencies: [],
  files: ["package.json", "server.cjs"],
};
const directory = taskTestDirectory(task, [task])!;
const testFile = `${directory}/foundation.test.cjs`;
const write = (file: string, content: string) => ({ action: "write_file", path: file, content });
const badWrite = write("tests/test.js", "it('works',()=>fetch('/api'));");
const decision = (nextAction: unknown) => ({
  diagnosis:
    "The shared test path is outside my scope; the test already exists in my assigned directory.",
  evidence: ["write_file to tests/test.js was denied", `write_file to ${testFile} succeeded`],
  nextAction,
});
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scope-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, "server.cjs"), "module.exports={ready:true};");
  return root;
}
function setupActions() {
  return [
    { action: "list_files", path: "." },
    { action: "read_file", path: "package.json" },
    { action: "read_file", path: "server.cjs" },
    badWrite,
    write(testFile, "it('works',()=>fetch('/api'));"),
    write("package.json", JSON.stringify({ scripts: { test: `node --test ${testFile}` } })),
    badWrite,
  ];
}

test("reported scope loop switches to recovery, repairs the actual test and runs real validation", async (t) => {
  const root = await fixture(t);
  const actions: unknown[] = [
    ...setupActions(),
    decision({ action: "read_file", path: testFile }),
    { action: "run_command", command: "node", args: ["--test", testFile] },
    {
      action: "diagnose",
      category: "implementation",
      hypothesis:
        "Node's test function must be imported, and the test should validate the actual module.",
      evidence: ["it is not defined"],
      nextStep: "Use node:test and inspect the module export.",
    },
    write(
      testFile,
      "const {test}=require('node:test');const assert=require('node:assert/strict');test('ready',()=>assert.equal(require('../../../server.cjs').ready,true));",
    ),
    { action: "run_command", command: "node", args: ["--test", testFile] },
    { action: "done", summary: "Foundation validated with its task test." },
  ];
  const prompts: string[] = [];
  const result = await runAgent(
    task,
    root,
    { assignedTestDirectory: directory },
    {
      ask: async (prompt) => {
        prompts.push(prompt);
        assert.ok(actions.length);
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.match(prompts[6]!, /Latest scope failure: WRITE_FILE_FAILED:/);
  assert.match(prompts[7]!, /^RECOVERY DECISION REQUIRED/);
  assert.ok(prompts[7]!.includes(testFile));
  assert.ok(result.audit.some((entry) => entry.action === "scope_recovery_decision"));
  assert.deepEqual(
    result.audit.filter((entry) => entry.action === "run_command").map((entry) => entry.success),
    [false, true],
  );
  await assert.rejects(fs.access(path.join(root, "tests/test.js")));
});

test("uncooperative recovery is bounded and never writes the forbidden path", async (t) => {
  const root = await fixture(t);
  const actions: unknown[] = setupActions();
  const result = await runAgent(
    task,
    root,
    { assignedTestDirectory: directory },
    {
      ask: async () => JSON.stringify(actions.length ? actions.shift() : decision(badWrite)),
    },
  );
  assert.equal(result.success, false);
  assert.match(result.summary, /safe recovery decision/);
  assert.equal(
    result.audit.filter((entry) => entry.action === "scope_recovery_rejected").length,
    2,
  );
  assert.equal(
    result.audit.filter((entry) => entry.action === "write_file" && entry.path === "tests/test.js")
      .length,
    2,
  );
  await assert.rejects(fs.access(path.join(root, "tests/test.js")));
});

test("scope recovery survives a process interruption without forgetting the denied path", async (t) => {
  const root = await fixture(t);
  let saved: AgentSession | undefined;
  const actions: unknown[] = setupActions();
  await assert.rejects(
    runAgent(
      task,
      root,
      { assignedTestDirectory: directory },
      {
        ask: async () => JSON.stringify(actions.shift()),
        onCheckpoint: async (session) => {
          if (session.nextStep === 8) {
            saved = structuredClone(session);
            throw new Error("interrupted");
          }
        },
      },
    ),
    /interrupted/,
  );
  assert.ok(saved);
  const resumed = await runAgent(
    task,
    root,
    { assignedTestDirectory: directory },
    {
      resumeSession: saved,
      ask: async (prompt) => {
        assert.match(prompt, /^RECOVERY DECISION REQUIRED/);
        assert.match(prompt, /tests\/test.js/);
        return JSON.stringify(decision(badWrite));
      },
    },
  );
  assert.equal(resumed.success, false);
  assert.equal(resumed.steps, 9);
});
