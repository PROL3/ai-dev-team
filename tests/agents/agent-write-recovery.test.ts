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
  description: "Export ready=true and test the actual module",
  owner: "backend",
  dependencies: [],
  files: ["package.json", "server.cjs"],
};
const directory = taskTestDirectory(task, [task])!;
const testFile = `${directory}/foundation.test.cjs`;
const write = (file: string, content: string) => ({ action: "write_file", path: file, content });
const placeholder = {
  action: "diagnose",
  category: "configuration",
  hypothesis: "cause",
  evidence: ["observed fact"],
  nextStep: "specific check or fix",
};
const diagnosis = {
  action: "diagnose",
  category: "configuration",
  hypothesis: "The manifest payload contains Markdown fences instead of raw JSON.",
  evidence: [
    "write_file rejected package.json because its content starts with a Markdown code fence.",
  ],
  nextStep: "Send raw JSON and put a real test file inside the assigned test directory.",
};
const done = {
  action: "done",
  summary: "Implemented ready=true and passed its targeted Node test.",
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-write-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(root, "server.cjs"), "exports.ready = false;");
  return root;
}

test("reported fenced-file and directory mistakes return actionable feedback, then recover with real validation", async (t) => {
  const root = await fixture(t);
  const manifest = JSON.stringify({
    name: "fixture",
    scripts: { test: `node --test ${testFile}` },
  });
  const source =
    "const {test}=require('node:test');const assert=require('node:assert/strict');test('ready',()=>assert.equal(require('../../../server.cjs').ready,true));";
  const actions: unknown[] = [
    { action: "list_files", path: "." },
    { action: "read_file", path: "package.json" },
    write("package.json", `\`\`\`json\n${manifest}\n\`\`\``),
    write(directory, source),
    write(testFile, `\`\`\`javascript\n${source}\n\`\`\``),
    placeholder,
    diagnosis,
    write("package.json", manifest),
    write("server.cjs", "exports.ready = true;"),
    write(testFile, source),
    { action: "run_command", command: "node", args: ["--test", testFile] },
    done,
  ];
  const prompts: string[] = [];
  const result = await runAgent(
    task,
    root,
    { assignedTestDirectory: directory },
    {
      ask: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 4)
          assert.equal(
            await fs.readFile(path.join(root, "package.json"), "utf8"),
            '{"name":"fixture"}',
          );
        if (prompts.length === 6)
          await assert.rejects(fs.stat(path.join(root, directory)), { code: "ENOENT" });
        assert.ok(actions.length, "Unexpected model request");
        return JSON.stringify(actions.shift());
      },
    },
  );
  assert.equal(result.success, true, result.summary);
  assert.equal(actions.length, 0);
  assert.match(prompts[0]!, /DIRECTORY, not a file/);
  assert.match(prompts[0]!, /raw file content, without Markdown fences/);
  assert.doesNotMatch(prompts[0]!, /"hypothesis":"cause"/);
  assert.match(prompts[3]!, /WRITE_FILE_FAILED: package.json\nReason:.*Markdown code fence/);
  assert.match(prompts[4]!, /directory target, not a file/);
  assert.match(prompts[6]!, /Placeholder diagnosis is not an observation/);
  assert.match(prompts[7]!, /Latest diagnosis.*manifest payload contains Markdown fences/);
  assert.equal(
    result.audit.filter((entry) => entry.action === "diagnose" && entry.success).length,
    1,
  );
  const rejected = result.audit.filter((entry) => entry.action === "write_file" && !entry.success);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((entry) => !entry.progress && entry.changedFiles.length === 0));
  assert.deepEqual(
    result.audit.filter((entry) => entry.action === "run_command").map((entry) => entry.success),
    [true],
  );
  assert.match(result.audit.find((entry) => entry.action === "run_command")!.output, /ready/);
  assert.deepEqual(result.changedFiles.sort(), ["package.json", "server.cjs", testFile].sort());
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), manifest);
  assert.equal((await fs.stat(path.join(root, directory))).isDirectory(), true);
});

test("a placeholder in any diagnosis field is rejected without claiming successful diagnosis", async (t) => {
  const root = await fixture(t);
  const actions: unknown[] = [
    { ...diagnosis, hypothesis: " CAUSE. " },
    { ...diagnosis, evidence: ["Observed fact"] },
    { ...diagnosis, nextStep: "specific check or fix" },
    diagnosis,
    write("server.cjs", "exports.ready = true;"),
    done,
  ];
  const result = await runAgent(task, root, undefined, {
    ask: async () => {
      assert.ok(actions.length);
      return JSON.stringify(actions.shift());
    },
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(result.audit.filter((entry) => entry.action === "invalid_action").length, 3);
  assert.equal(result.audit.filter((entry) => entry.action === "diagnose").length, 1);
});

test("repeated placeholder diagnosis terminates within existing retry bounds without writing anything", async (t) => {
  const root = await fixture(t);
  const result = await runAgent(task, root, undefined, {
    ask: async () => JSON.stringify(placeholder),
  });
  assert.equal(result.success, false);
  assert.equal(result.steps, 4);
  assert.match(result.summary, /same invalid action/);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(
    result.audit.some((entry) => entry.action === "diagnose" && entry.success),
    false,
  );
});

test("scope recovery rejects placeholder reasoning before executing its proposed write", async (t) => {
  const root = await fixture(t);
  const badWrite = write("another-task.cjs", "exports.ready = true;");
  const nextAction = write("server.cjs", "exports.ready = true;");
  const actions: unknown[] = [
    badWrite,
    badWrite,
    { diagnosis: "cause supported by evidence", evidence: ["observed facts"], nextAction },
    {
      diagnosis:
        "The denied path belongs to another task; server.cjs is explicitly owned by this task.",
      evidence: [
        "WRITE_FILE_FAILED: another-task.cjs is NOT in your allowed files list (package.json, server.cjs)",
      ],
      nextAction,
    },
    done,
  ];
  const result = await runAgent(task, root, undefined, {
    ask: async (prompt) => {
      if (actions.length === 2) {
        assert.match(prompt, /^RECOVERY DECISION REQUIRED/);
        assert.doesNotMatch(prompt, /Return ONLY JSON:.*cause supported by evidence/);
        assert.equal(
          await fs.readFile(path.join(root, "server.cjs"), "utf8"),
          "exports.ready = false;",
        );
      }
      assert.ok(actions.length);
      return JSON.stringify(actions.shift());
    },
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(
    result.audit.filter((entry) => entry.action === "scope_recovery_rejected").length,
    1,
  );
  assert.equal(
    result.audit.filter((entry) => entry.action === "scope_recovery_decision").length,
    1,
  );
  assert.equal(await fs.readFile(path.join(root, "server.cjs"), "utf8"), "exports.ready = true;");
  await assert.rejects(fs.stat(path.join(root, "another-task.cjs")), { code: "ENOENT" });
});

test("repeated invalid writes fail with original content preserved and no fabricated progress", async (t) => {
  const root = await fixture(t);
  const result = await runAgent(task, root, undefined, {
    ask: async () => JSON.stringify(write("package.json", "```json\n{}\n```")),
  });
  assert.equal(result.success, false);
  assert.equal(result.steps, 3);
  assert.match(result.summary, /raw file contents/);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), '{"name":"fixture"}');
});

test("write-rejection feedback survives interruption and old placeholder diagnoses are not pinned as facts", async (t) => {
  const root = await fixture(t);
  let saved: AgentSession | undefined;
  await assert.rejects(
    runAgent(task, root, undefined, {
      ask: async () => JSON.stringify(write("package.json", "```json\n{}\n```")),
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
  // Older checkpoints accepted the literal prompt example as a successful diagnosis.
  saved.audit.unshift({
    step: 0,
    action: "diagnose",
    input: placeholder,
    output: JSON.stringify(placeholder),
    success: true,
    progress: false,
    changedFiles: [],
    testResults: [],
  });
  const actions: unknown[] = [write("package.json", '{"name":"repaired"}'), done];
  const result = await runAgent(task, root, undefined, {
    resumeSession: saved,
    ask: async (prompt) => {
      assert.match(prompt, /Latest diagnosis \(hypothesis, not verified fact\): none/);
      assert.match(prompt, /Markdown code fence/);
      assert.ok(actions.length);
      return JSON.stringify(actions.shift());
    },
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), '{"name":"repaired"}');
});
