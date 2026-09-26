import type { ScheduledTask } from "../domain/scheduler.js";
import type { TesterResult } from "../agents/tester/run-tester.js";
import type { CodeReviewResult } from "../domain/code-review.js";

export function logTask(
  task: ScheduledTask,
  details: {
    agentStatus: string;
    currentMainCommit: string;
    commitHash?: string;
    integrationAttempt: number;
    mergeResult: string;
    conflictFiles: string[];
    finalStatus: string;
    error?: string;
    tester?: TesterResult;
    review?: CodeReviewResult;
  },
): void {
  console.log(
    `[task-log] ${JSON.stringify({
      taskId: task.id,
      agentStatus: details.agentStatus,
      attempt: task.attempts,
      branch: task.branchName ?? null,
      baseCommit: task.baseCommit ?? null,
      currentMainCommit: details.currentMainCommit,
      commitHash: details.commitHash ?? task.commitHash ?? null,
      integrationAttempt: details.integrationAttempt,
      mergeResult: details.mergeResult,
      conflictFiles: details.conflictFiles,
      error: details.error ?? null,
      failureType: task.failureType ?? null,
      review: details.review ? { attempt: task.reviewAttempts, ...details.review } : null,
      tester: details.tester
        ? {
            attempt: task.testerAttempts,
            status: details.tester.passed ? "passed" : "failed",
            passed: details.tester.passed,
            testsRun: details.tester.testsRun,
            failures: details.tester.failures,
            warnings: details.tester.warnings,
            suggestedFixes: details.tester.suggestedFixes,
            changedFiles: details.tester.changedFiles,
          }
        : null,
      finalStatus: details.finalStatus,
    })}`,
  );
}
