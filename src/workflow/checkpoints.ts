import path from "node:path";
import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { checkpointGit, verifyCheckout } from "../infrastructure/git/checkpoint-git.js";
import fs from "node:fs/promises";
import { recoverWorktree } from "../infrastructure/git/recover-worktree.js";
import type { WorkflowState } from "../domain/workflow-state.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import { taskRecord } from "./task-state.js";
import type { WorkflowRuntime } from "./runtime.js";
import { listReviewChangedFiles } from "../infrastructure/git/review-snapshot.js";

export async function saveCheckpoint(state: WorkflowRuntime): Promise<void> {
  if (!state.store) return;
  if (!state.checkpointActive)
    throw new CheckpointError("Use runUntilComplete() for a checkpointed workflow.");
  await state.store.save({
    version: 1,
    runId: state.runId,
    updatedAt: new Date().toISOString(),
    projectRoot: state.projectRoot,
    mainCommit: state.mainCommit,
    enableTester: state.enableTester,
    enableCodeReview: state.enableCodeReview,
    enableTestAuthoring: state.enableTestAuthoring,
    validationOrder: "test-then-review",
    plan: state.plan,
    tasks: state.tasks.map((task) => taskRecord(state, task)),
  });
}

export async function restoreCheckpoint(
  state: WorkflowRuntime,
  saved: WorkflowState,
): Promise<void> {
  if (
    saved.runId !== state.runId ||
    path.resolve(saved.projectRoot) !== state.projectRoot ||
    saved.enableTester !== state.enableTester ||
    saved.enableCodeReview !== state.enableCodeReview ||
    saved.enableTestAuthoring !== state.enableTestAuthoring ||
    JSON.stringify(saved.plan) !== JSON.stringify(state.plan)
  ) {
    throw new CheckpointError("Checkpoint changed before resume; load it again.");
  }
  const common = await verifyCheckout(state.projectRoot, "main");
  if (await state.gitManager.getMainStatus())
    throw new CheckpointError("Main checkout has uncommitted changes; resolve them before resume.");
  const currentMain = await state.gitManager.getCurrentMainCommit();
  let accountedForMainChange = currentMain === saved.mainCommit;
  // Recovery writes are only safe against the saved main revision.
  if (state.retryFailed && !accountedForMainChange)
    throw new CheckpointError("Main HEAD changed; cannot retry failed tasks against stale state.");
  for (const record of saved.tasks) {
    const task = record.task;
    if (task.workspacePath && task.branchName && task.status !== "completed") {
      if (state.retryFailed && task.status === "failed") {
        let missingMetadata = false;
        try {
          await fs.lstat(path.join(task.workspacePath, ".git"));
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            missingMetadata = true;
          else throw error;
        }
        if (missingMetadata) {
          if (!record.workspaceHead)
            throw new CheckpointError(`No saved revision for ${task.id}; cannot recover safely.`);
          const originalWorkspace = task.workspacePath;
          const recovered = await recoverWorktree(
            state.projectRoot,
            originalWorkspace,
            record.workspaceHead,
          );
          task.workspacePath = recovered.workspacePath;
          task.branchName = recovered.branchName;
          console.log(
            `[workflow-log] ${JSON.stringify({ event: "worktree_recovered", taskId: task.id, originalWorkspace, ...recovered })}`,
          );
        }
      }
      await verifyCheckout(task.workspacePath, task.branchName, common);
      const head = await checkpointGit(task.workspacePath, ["rev-parse", "HEAD"]);
      if (record.phase === "integrating") {
        const dirty = await checkpointGit(task.workspacePath, ["status", "--porcelain"]);
        // Recover the narrow crash window after merge succeeded but before save.
        const parents = (
          await checkpointGit(state.projectRoot, ["rev-list", "--parents", "-n", "1", "HEAD"])
        ).split(" ");
        const mergedHere = !dirty && parents[1] === record.integrationBase && parents[2] === head;
        if (mergedHere) {
          record.phase = "integrated";
          record.integrationCommit = currentMain;
          if (state.enableCodeReview) {
            record.reviewPaths = [...new Set([
              ...(record.reviewPaths ?? []),
              ...await listReviewChangedFiles(state.projectRoot, record.integrationBase!, currentMain),
            ])];
          }
          task.commitHash = head;
          record.workspaceHead = head;
          accountedForMainChange = true;
        } else if (currentMain === saved.mainCommit) {
          // Commit/rebase may have finished, but merge has not. Preserve its attempt.
          record.workspaceHead = head;
        } else {
          throw new CheckpointError(
            `Cannot establish whether ${task.id} was integrated. Git state needs inspection.`,
          );
        }
      } else if (record.workspaceHead && head !== record.workspaceHead) {
        throw new CheckpointError(
          `Worktree HEAD changed for ${task.id}; refusing to resume against a different revision.`,
        );
      }
    } else if (task.status === "running") {
      throw new CheckpointError(`Missing workspace identity for ${task.id}.`);
    }
    if (task.status === "completed" && task.commitHash) {
      await checkpointGit(state.projectRoot, [
        "merge-base",
        "--is-ancestor",
        task.commitHash,
        "HEAD",
      ]);
    }
  }
  if (!accountedForMainChange)
    throw new CheckpointError(
      "Main HEAD changed since the saved run. Refusing to reuse stale validation.",
    );
  if (state.retryFailed) {
    for (const record of saved.tasks) {
      const task = record.task;
      if (task.status !== "failed") continue;
      task.maxAttempts = task.attempts + 1;
      task.testerMaxAttempts = task.testerAttempts + 1;
      task.reviewMaxAttempts = task.reviewAttempts + 2;
      task.status = "pending";
      record.phase = "settled";
      delete record.session;
      delete record.result;
      delete record.testerResult;
      delete record.testerCommit;
      delete record.reviewResult;
      console.log(
        `[workflow-log] ${JSON.stringify({ event: "failed_task_retry_authorized", taskId: task.id, attempts: task.attempts, maxAttempts: task.maxAttempts })}`,
      );
    }
  }
  // Upgrade unfinished review-before-test runs without reusing premature approval.
  if (!saved.validationOrder) {
    for (const record of saved.tasks) {
      if (record.task.status === "completed" && record.testerResult?.passed) {
        const tested = record.integrationCommit ?? record.task.commitHash!;
        record.integrationCommit = tested;
        record.testerCommit = tested;
      } else if (record.task.status === "running") {
        delete record.reviewResult;
        delete record.testerCommit;
        if (["reviewing", "reviewed"].includes(record.phase)) record.phase = "integrated";
      }
    }
  }
  // The schema and JSON serialization ensure no explicit undefined optionals.
  state.tasks = saved.tasks.map((record) => record.task as ScheduledTask);
  for (const record of saved.tasks) state.records.set(record.task.id, record);
  state.mainCommit = currentMain;
  await saveCheckpoint(state);
}
