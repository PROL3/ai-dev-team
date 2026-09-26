import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { withProgress } from "../infrastructure/logging/progress.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import {
  TesterExecutionError,
  testerResultSchema,
  type TesterResult,
} from "../agents/tester/run-tester.js";
import { completeTask, taskRecord } from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import { installTesterDependencies } from "./dependencies.js";
import { logTask } from "./logging.js";
import type { WorkflowRuntime } from "./runtime.js";
import { reviewIntegratedTask } from "./code-review.js";

export async function validateIntegratedTask(
  state: WorkflowRuntime,
  task: ScheduledTask,
  result: AgentResult,
  interrupted = false,
): Promise<AgentResult> {
  // An integration conflict is not an integrated task, even if the agent succeeded.
  if (!result.success) return result;

  if (!state.enableTester) {
    completeTask(state, task.id, result.output);
    await saveCheckpoint(state);
    logTask(task, {
      agentStatus: "succeeded",
      currentMainCommit: await state.gitManager.getCurrentMainCommit(),
      integrationAttempt: task.integrationAttempts,
      mergeResult: "merged",
      conflictFiles: [],
      finalStatus: task.status,
    });
    return result;
  }

  const record = taskRecord(state, task);
  record.integrationCommit ??= await state.gitManager.getCurrentMainCommit();
  // Only a saved PASS for this exact integration can survive a review interruption.
  if (record.testerCommit === record.integrationCommit && record.testerCommit &&
      record.testerResult?.passed && record.testerResult.failures.length === 0 &&
      record.testerResult.testsRun.length > 0) {
    return finishValidatedTask(state, task, result);
  }
  if (!interrupted && task.testerAttempts >= task.testerMaxAttempts) {
    task.status = "failed";
    task.failureType = "test";
    task.error = "Tester attempt budget exhausted; review cannot run without a current PASS.";
    record.phase = "settled";
    await saveCheckpoint(state);
    return { ...result, success: false, failureType: "test", error: task.error };
  }
  delete record.reviewResult;
  delete record.testerCommit;

  if (!interrupted) task.testerAttempts += 1;
  taskRecord(state, task).phase = "testing";
  await saveCheckpoint(state);
  let testerResult: TesterResult;
  let executionFailed = false;
  try {
    await installTesterDependencies(state);
    testerResult = await withProgress(
      "tester",
      { taskId: task.id, attempt: task.testerAttempts },
      async () =>
        testerResultSchema.parse(
          await state.executeTester({
            task,
            workspacePath: state.projectRoot,
            changedFiles: result.changedFiles,
            previousAgentSummary: result.output,
            ...(record.testerTests ? { testerTests: record.testerTests } : {}),
            ...(task.previousTesterResult
              ? { previousTesterResult: task.previousTesterResult }
              : {}),
          }),
        ),
      {
        heartbeatMs: 0,
        details: (result) => ({
          passed: result.passed && result.failures.length === 0 && result.testsRun.length > 0,
          testsRun: result.testsRun.length,
          failures: result.failures.length,
          warnings: result.warnings.length,
        }),
      },
    );
    // Custom testers must obey the same pass/failure invariant.
    if (testerResult.failures.length > 0 || testerResult.testsRun.length === 0) {
      testerResult = {
        ...testerResult,
        passed: false,
        failures:
          testerResult.failures.length > 0
            ? testerResult.failures
            : ["Tester returned no executed validation."],
      };
    }
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    executionFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    testerResult =
      error instanceof TesterExecutionError
        ? error.result
        : {
            passed: false,
            summary: `Tester execution failed: ${message.slice(0, 1_000)}`,
            testsRun: [],
            failures: [`Tester execution failed: ${message.slice(0, 1_000)}`],
            warnings: [],
            changedFiles: result.changedFiles,
            suggestedFixes: ["Fix the tester execution error and retry validation."],
          };
    taskRecord(state, task).testerResult = testerResult;
    if (task.testerAttempts < task.testerMaxAttempts) {
      logTask(task, {
        agentStatus: "succeeded",
        currentMainCommit: await state.gitManager.getCurrentMainCommit(),
        integrationAttempt: task.integrationAttempts,
        mergeResult: "merged",
        conflictFiles: [],
        tester: testerResult,
        error: testerResult.summary,
        finalStatus: "running",
      });
      // The source has already been integrated. Retry only validation when
      // its runner failed, rather than spending another implementation attempt.
      return validateIntegratedTask(state, task, result);
    }
  }

  taskRecord(state, task).testerResult = testerResult;
  if (testerResult.passed) {
    record.testerCommit = record.integrationCommit!;
    record.phase = "tested";
    await saveCheckpoint(state);
    return finishValidatedTask(state, task, result);
  }

  task.previousTesterResult = {
    passed: false,
    summary: testerResult.summary,
    failures: testerResult.failures,
    suggestedFixes: testerResult.suggestedFixes,
  };
  task.previousChangedFiles = result.changedFiles;
  task.output = result.output;
  task.error = testerResult.summary;
  task.failureType = "test";

  if (
    executionFailed ||
    task.testerAttempts >= task.testerMaxAttempts ||
    task.attempts >= task.maxAttempts
  ) {
    task.status = "failed";
  } else {
    task.status = "pending";
  }
  taskRecord(state, task).phase = "settled";
  await saveCheckpoint(state);

  logTask(task, {
    agentStatus: "succeeded",
    currentMainCommit: await state.gitManager.getCurrentMainCommit(),
    integrationAttempt: task.integrationAttempts,
    mergeResult: "merged",
    conflictFiles: [],
    tester: testerResult,
    error: testerResult.summary,
    finalStatus: task.status,
  });
  return {
    ...result,
    success: false,
    error: testerResult.summary,
    failureType: "test",
  };
}

async function finishValidatedTask(
  state: WorkflowRuntime, task: ScheduledTask, result: AgentResult,
): Promise<AgentResult> {
  const reviewed = await reviewIntegratedTask(state, task, result);
  if (!reviewed.success) return reviewed;
  completeTask(state, task.id, result.output);
  await saveCheckpoint(state);
  logTask(task, {
    agentStatus: "succeeded",
    currentMainCommit: await state.gitManager.getCurrentMainCommit(),
    integrationAttempt: task.integrationAttempts, mergeResult: "merged", conflictFiles: [],
    tester: taskRecord(state, task).testerResult!, finalStatus: task.status,
  });
  return result;
}
