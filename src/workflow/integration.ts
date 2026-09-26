import { checkpointGit } from "../infrastructure/git/checkpoint-git.js";
import { withProgress } from "../infrastructure/logging/progress.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import type { TaskWorkspace } from "../infrastructure/git/workspace-manager.js";
import { taskRecord } from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import { logTask } from "./logging.js";
import type { WorkflowRuntime } from "./runtime.js";
import { listReviewChangedFiles } from "../infrastructure/git/review-snapshot.js";
import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";

export async function integrateSuccessfulTask(
  state: WorkflowRuntime,
  task: ScheduledTask,
  result: AgentResult,
  interrupted = false,
): Promise<AgentResult> {
  if (!task.workspacePath || !task.branchName) {
    throw new Error(`Task ${task.id} has no workspace`);
  }

  const workspace: TaskWorkspace = {
    taskId: task.id,
    branchName: task.branchName,
    path: task.workspacePath,
    baseCommit: task.baseCommit ?? "",
  };

  if (!interrupted) task.integrationAttempts += 1;
  // Retain the implementation evidence for conflict retries and tester feedback.
  task.output = result.output;
  task.previousChangedFiles = result.changedFiles;
  const record = taskRecord(state, task);
  record.phase = "integrating";
  record.result = result;
  record.integrationBase = await state.gitManager.getCurrentMainCommit();
  if (state.enableCodeReview) record.reviewBase ??= record.integrationBase;
  delete record.reviewResult;
  delete record.testerResult;
  delete record.testerCommit;
  delete record.integrationCommit;
  await saveCheckpoint(state);

  const integration = await withProgress(
    "integration",
    { taskId: task.id, attempt: task.integrationAttempts },
    () => state.gitManager.integrateTask(workspace, task.id),
    {
      details: (result) => ({ success: result.success, conflicts: result.conflictFiles.length }),
    },
  );

  task.commitHash = integration.commitHash;
  state.mainCommit = integration.mainCommit;
  if (state.store)
    record.workspaceHead = await checkpointGit(workspace.path, ["rev-parse", "HEAD"]);

  if (integration.success) {
    record.integrationCommit = integration.mainCommit;
    if (state.enableCodeReview) {
      try {
        record.reviewPaths = [...new Set([
          ...(record.reviewPaths ?? []),
          ...await listReviewChangedFiles(state.projectRoot, record.integrationBase, integration.mainCommit),
        ])];
      } catch {
        throw new CheckpointError("Integration succeeded but its review paths could not be recorded; resume to recover.");
      }
    }
    record.phase = "integrated";
    await saveCheckpoint(state);
    return result;
  }

  const errorMessage = [
    integration.error ?? "Git integration failed",
    integration.conflictFiles.length > 0
      ? `Conflict files: ${integration.conflictFiles.join(", ")}`
      : "",
    integration.cleanupError ? `Cleanup failed: ${integration.cleanupError}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  task.status = "integration_conflict";
  task.integrationError = errorMessage;
  task.conflictFiles = integration.conflictFiles;
  task.failureType = "integration";
  record.phase = "settled";
  await saveCheckpoint(state);

  logTask(task, {
    agentStatus: "succeeded",
    currentMainCommit: integration.mainCommit,
    commitHash: integration.commitHash,
    integrationAttempt: task.integrationAttempts,
    mergeResult: "conflict",
    conflictFiles: integration.conflictFiles,
    finalStatus: task.status,
  });

  if (integration.cleanupError) {
    throw new Error(errorMessage);
  }

  return {
    ...result,
    success: false,
    error: errorMessage,
    failureType: "integration",
  };
}
