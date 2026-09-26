import { codeReviewResultSchema, type CodeReviewResult } from "../domain/code-review.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { withProgress } from "../infrastructure/logging/progress.js";
import { listReviewChangedFiles } from "../infrastructure/git/review-snapshot.js";
import { taskRecord } from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import { logTask } from "./logging.js";
import type { WorkflowRuntime } from "./runtime.js";

/** Gate completion on a review of this exact integration, with bounded runner retries. */
export async function reviewIntegratedTask(
  state: WorkflowRuntime, task: ScheduledTask, result: AgentResult,
): Promise<AgentResult> {
  if (!result.success || !state.enableCodeReview) return result;
  const record = taskRecord(state, task);
  if (!state.enableTester || !record.testerResult?.passed ||
      record.testerResult.failures.length > 0 || record.testerResult.testsRun.length === 0 ||
      !record.testerCommit || record.testerCommit !== record.integrationCommit) {
    throw new CheckpointError("Code Review requires Tester PASS for the current integrated revision.");
  }
  const baseCommit = record.reviewBase;
  const headCommit = record.integrationCommit;
  const integrationBase = record.integrationBase;
  if (!baseCommit || !headCommit || !integrationBase) throw new CheckpointError("Review is missing its integrated revisions.");
  if (record.reviewResult?.status === "approved" &&
      record.reviewResult.baseCommit === baseCommit && record.reviewResult.headCommit === headCommit) return result;

  let interrupted = record.phase === "reviewing";
  let review: CodeReviewResult | undefined;
  let errorMessage = "Code Review exhausted its attempt budget.";
  // Protocol/provider errors retry the reviewer, never an implementation that has succeeded.
  for (let runnerAttempt = 0; runnerAttempt < 2 &&
      (interrupted || task.reviewAttempts < task.reviewMaxAttempts); runnerAttempt++) {
    if (!interrupted) task.reviewAttempts++;
    interrupted = false;
    record.phase = "reviewing";
    await saveCheckpoint(state);
    try {
      record.reviewPaths = [...new Set([
        ...(record.reviewPaths ?? []),
        ...await listReviewChangedFiles(state.projectRoot, integrationBase, headCommit),
      ])];
      await saveCheckpoint(state);
      review = await withProgress<CodeReviewResult>("code_review", { taskId: task.id, attempt: task.reviewAttempts }, async (): Promise<CodeReviewResult> =>
        codeReviewResultSchema.parse(await state.executeCodeReview({
          task: { ...task, ...(state.plan.architecture ? { architecture: state.plan.architecture } : {}) },
          workspacePath: state.projectRoot, baseCommit, headCommit, integrationBase,
          reviewPaths: record.reviewPaths!,
          previousAgentSummary: result.output,
          validation: {
            commit: record.testerCommit!,
            summary: record.testerResult!.summary,
            testsRun: record.testerResult!.testsRun,
          },
          ...(task.previousReview ? { previousReview: task.previousReview } : {}),
        })), {
          heartbeatMs: 0,
          details: (value) => ({ status: value.status, findings: value.findings.length, limitations: value.limitations.length }),
        });
      if (review.baseCommit !== baseCommit || review.headCommit !== headCommit) {
        throw new Error("Reviewer returned evidence for a different revision.");
      }
      record.reviewResult = review;
      task.previousReview = review;
      errorMessage = review.summary;
      if (review.status !== "inconclusive") break;
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      review = undefined;
      delete record.reviewResult;
      // Error strings from providers or Git may contain source/prompt data.
      errorMessage = "Code Review execution or response validation failed; no approval was recorded.";
    }
    await saveCheckpoint(state);
  }
  if (review?.status === "approved") {
    record.phase = "reviewed";
    await saveCheckpoint(state);
    logTask(task, {
      agentStatus: "succeeded", currentMainCommit: state.mainCommit,
      integrationAttempt: task.integrationAttempts, mergeResult: "merged", conflictFiles: [],
      finalStatus: task.status, review,
    });
    return result;
  }

  if (review?.status === "changes_requested") {
    task.previousReview = review;
    const blocking = review.findings.filter((finding) => finding.priority !== "P3");
    errorMessage = [review.summary, ...blocking.map((finding) =>
      `[${finding.priority}] ${finding.file}:${finding.startLine}: ${finding.title}. ${finding.scenario} ${finding.impact} Fix: ${finding.suggestedFix}`,
    )].join("\n");
  }
  task.status = review?.status === "changes_requested" && task.attempts < task.maxAttempts &&
    task.reviewAttempts < task.reviewMaxAttempts && task.testerAttempts < task.testerMaxAttempts
    ? "pending" : "failed";
  task.failureType = "review";
  task.error = errorMessage;
  task.output = result.output;
  task.previousChangedFiles = result.changedFiles;
  record.phase = "settled";
  await saveCheckpoint(state);
  logTask(task, {
    agentStatus: "succeeded", currentMainCommit: state.mainCommit,
    integrationAttempt: task.integrationAttempts, mergeResult: "merged", conflictFiles: [],
    finalStatus: task.status, error: errorMessage, ...(review ? { review } : {}),
  });
  return { ...result, success: false, error: errorMessage, failureType: "review" };
}
