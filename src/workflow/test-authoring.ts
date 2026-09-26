import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import { testerTestDirectory, testAuthorResponseSchema, sameTestContent } from "../domain/test-authoring.js";
import { readAuthorSource, testExecutionProfile } from "../agents/tester/author-tests.js";
import { AgentTools } from "../tools/agent-tools.js";
import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { saveCheckpoint } from "./checkpoints.js";
import { taskRecord, handleTaskFailure } from "./task-state.js";
import type { WorkflowRuntime } from "./runtime.js";
import { logTask } from "./logging.js";

class TestSetupError extends Error {}

/** Author tests in the task worktree, then integrate them together with the implementation. */
export async function prepareTesterTests(
  state: WorkflowRuntime, task: ScheduledTask, result: AgentResult,
): Promise<AgentResult> {
  if (!result.success || !state.enableTestAuthoring) return result;
  const record = taskRecord(state, task);
  if (record.testsPreparedAttempt === task.attempts) return result;
  record.phase = "authoring_tests";
  record.result = result;
  await saveCheckpoint(state);
  try {
    const workspacePath = task.workspacePath!;
    const previousTests = record.testerTests ?? [];
    for (const test of previousTests) {
      try {
        if (!sameTestContent(await readAuthorSource(workspacePath, test.path), test.content)) {
          throw new TestSetupError(`Tester-owned assertions changed: ${test.path}. Restore them and fix production behavior.`);
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw new TestSetupError(`Tester-owned assertions disappeared: ${test.path}. Restore this test file.`);
        }
        throw error;
      }
    }
    if (!record.testDraft) {
      const directory = testerTestDirectory(task, state.plan.tasks);
      let profile: ReturnType<typeof testExecutionProfile>;
      try {
        profile = testExecutionProfile(await readAuthorSource(workspacePath, "package.json"), directory, task.attempts);
      } catch (error) {
        if (error instanceof SyntaxError ||
            (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw new TestSetupError("Tester requires a valid root package.json before it can author tests. Fix the missing or malformed manifest.");
        }
        throw error;
      }
      // Protocol/provider failures get a bounded retry without re-running the Coder.
      for (let attempt = record.testAuthorAttempts ?? 0; attempt < 2; attempt++) {
        record.testAuthorAttempts = attempt + 1;
        await saveCheckpoint(state);
        try {
          const response = testAuthorResponseSchema.parse(await state.executeTestAuthor({
            task: { ...task, ...(state.plan.architecture ? { architecture: state.plan.architecture } : {}) },
            workspacePath, changedFiles: result.changedFiles,
            testPath: profile.path, framework: profile.framework, previousTests,
          }));
          record.testDraft = { path: profile.path, content: response.content, command: profile.command };
          break;
        } catch (error) {
          if (error instanceof CheckpointError || attempt === 1) throw error;
        }
      }
      if (!record.testDraft) throw new Error("Test authoring attempt budget exhausted.");
      // Persist the exact proposed bytes before the first write; resume replays this draft.
      await saveCheckpoint(state);
    }
    const draft = record.testDraft!;
    const tools = new AgentTools({ role: "tester", workspacePath, exactPaths: true, allowedPaths: [draft.path] });
    try {
      const existing = await readAuthorSource(workspacePath, draft.path);
      if (!sameTestContent(existing, draft.content)) throw new Error(`Refusing to overwrite an existing test: ${draft.path}`);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    await tools.writeFile(draft.path, draft.content);
    record.testerTests = [...previousTests, draft];
    record.testsPreparedAttempt = task.attempts;
    delete record.testDraft;
    result = { ...result, changedFiles: [...new Set([...result.changedFiles, draft.path])] };
    record.result = result;
    record.phase = "agent_finished";
    await saveCheckpoint(state);
    return result;
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    // An authoring/protocol failure is not evidence of a production bug.
    const message = error instanceof TestSetupError ? error.message
      : "Tester could not safely prepare executable tests. Inspect its scope, saved draft and test configuration.";
    if (error instanceof TestSetupError) {
      task.previousTesterResult = { passed: false, summary: message, failures: [message], suggestedFixes: [message] };
      handleTaskFailure(state, task.id, message, result.output, "test");
    } else {
      task.status = "failed";
    }
    task.failureType = "test";
    task.error = message;
    task.output = result.output;
    task.previousChangedFiles = result.changedFiles;
    record.phase = "settled";
    await saveCheckpoint(state);
    logTask(task, {
      agentStatus: "succeeded", currentMainCommit: state.mainCommit,
      integrationAttempt: task.integrationAttempts, mergeResult: "not_attempted", conflictFiles: [],
      finalStatus: task.status, error: message,
    });
    return { ...result, success: false, failureType: "test", error: message };
  }
}
