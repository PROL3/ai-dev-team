import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../../src/agents/implementation/run-agent.js";
import type { PlanTask } from "../../src/domain/plan.js";

function createTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "test-task",
    owner: "backend",
    title: "Test backend task",
    description: "Test failure recovery behavior.",
    dependencies: [],
    ...overrides,
  };
}

async function createWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-agent-test-"));
}

async function testInvalidJsonRecovery() {
  console.log("\n[TEST 1] runAgent recovers from invalid JSON");

  const workspacePath = await createWorkspace();

  let calls = 0;

  const task = createTask({
    id: "invalid-json-recovery",
  });

  const result = await runAgent(task, workspacePath, undefined, {
    ask: async () => {
      calls++;

      // First response: intentionally invalid JSON.
      if (calls === 1) {
        return `
{
  "action": "write_file",
  "path": "src/test.ts",
  "content": \`
    export const value = 1;
  \`
}
`;
      }

      // Second response: valid action.
      if (calls === 2) {
        return JSON.stringify({
          action: "write_file",
          path: "src/test.ts",
          content: "export const value = 1;\n",
        });
      }

      // Third response: valid completion.
      return JSON.stringify({
        action: "done",
        summary: "Implemented and verified the test task.",
      });
    },
    softMaxSteps: 5,
    hardMaxSteps: 8,
  });

  assert.equal(result.success, true, `Expected success, got:\n${result.summary}`);

  assert.equal(calls, 3, "Expected exactly 3 LLM calls");

  const invalidJsonEntries = result.audit.filter((entry) => entry.action === "invalid_json");

  assert.equal(
    invalidJsonEntries.length,
    0,
    "Expected repaired JSON to execute without an invalid_json entry",
  );

  assert.ok(
    result.changedFiles.some(
      (file) => file === "src/test.ts" || file.endsWith(`${path.sep}src${path.sep}test.ts`),
    ),
    `Expected src/test.ts to be changed. Got: ${result.changedFiles.join(", ")}`,
  );

  console.log("✓ Invalid JSON was detected");
  console.log("✓ Agent retried with the next response");
  console.log("✓ Valid write_file action executed");
  console.log("✓ Agent completed successfully");
}

async function testFailedListFilesRecovery() {
  console.log("\n[TEST 2] runAgent recovers from invalid workspace path");

  const workspacePath = await createWorkspace();

  let calls = 0;

  const task = createTask({
    id: "workspace-path-recovery",
  });

  const result = await runAgent(task, workspacePath, undefined, {
    ask: async (prompt: string) => {
      calls++;

      /*
       * First response intentionally reproduces
       * the failure from your real log:
       *
       * LIST_FILES_FAILED: backend
       */
      if (calls === 1) {
        return JSON.stringify({
          action: "list_files",
          path: "backend",
        });
      }

      /*
       * After the failure the next model response
       * should use the workspace root instead of
       * blindly repeating "backend".
       */
      if (calls === 2) {
        assert.ok(
          prompt.includes("A previous inspection operation failed"),
          "Retry prompt should contain failure guidance",
        );

        return JSON.stringify({
          action: "list_files",
          path: ".",
        });
      }

      if (calls === 3) {
        return JSON.stringify({
          action: "write_file",
          path: "src/recovery-test.ts",
          content: "export const recovered = true;\n",
        });
      }

      return JSON.stringify({
        action: "done",
        summary: "Recovered from invalid workspace path and completed task.",
      });
    },
    softMaxSteps: 6,
    hardMaxSteps: 10,
  });

  assert.equal(result.success, true, `Expected recovery success, got:\n${result.summary}`);

  assert.equal(calls, 4, "Expected 4 LLM calls");

  const failedListEntries = result.audit.filter(
    (entry) => entry.action === "list_files" && !entry.success,
  );

  assert.equal(failedListEntries.length, 1, "Expected exactly one failed list_files action");

  assert.equal(failedListEntries[0]?.output?.startsWith("LIST_FILES_FAILED: backend"), true);

  const successfulRootList = result.audit.find(
    (entry) => entry.action === "list_files" && entry.success && entry.path === ".",
  );

  assert.ok(successfulRootList, "Expected successful list_files('.') after failure");

  assert.ok(
    result.changedFiles.some(
      (file) =>
        file === "src/recovery-test.ts" ||
        file.endsWith(`${path.sep}src${path.sep}recovery-test.ts`),
    ),
    `Expected recovery file to be changed. Got: ${result.changedFiles.join(", ")}`,
  );

  console.log("✓ Invalid 'backend' path failed as expected");
  console.log("✓ Retry prompt contained recovery instruction");
  console.log("✓ Agent switched to list_files('.')");
  console.log("✓ Agent continued to implementation");
  console.log("✓ Task completed successfully");
}

async function testRepeatedInvalidJsonStops() {
  console.log("\n[TEST 3] runAgent stops after repeated invalid JSON");

  const workspacePath = await createWorkspace();

  let calls = 0;

  const task = createTask({
    id: "invalid-json-stop",
  });

  const result = await runAgent(task, workspacePath, undefined, {
    ask: async () => {
      calls++;

      return `
{
  "action": "write_file",
  "content": \`
    broken
  \`
}
`;
    },
    softMaxSteps: 10,
    hardMaxSteps: 12,
  });

  assert.equal(result.success, false);

  assert.match(result.summary, /repeatedly returned (invalid JSON|the same invalid action)/i);

  assert.equal(calls, 4, "Expected failure after 4 identical invalid JSON responses");

  const invalidEntries = result.audit.filter(
    (entry) => entry.action === "invalid_json" || entry.action === "invalid_action",
  );

  assert.equal(invalidEntries.length, 4);

  console.log("✓ Invalid JSON detected repeatedly");
  console.log("✓ Agent retried exactly 4 times");
  console.log("✓ Agent stopped instead of looping forever");
}

async function main() {
  console.log("======================================");
  console.log("REAL AGENT FAILURE-RECOVERY TEST");
  console.log("======================================");

  await testInvalidJsonRecovery();
  await testFailedListFilesRecovery();
  await testRepeatedInvalidJsonStops();

  console.log("\n======================================");
  console.log("ALL REAL AGENT FAILURE TESTS PASSED");
  console.log("======================================");
}

main().catch((error) => {
  console.error("\n✗ TEST FAILED");
  console.error(error);
  process.exit(1);
});
