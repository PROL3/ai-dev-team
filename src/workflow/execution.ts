import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { verifyCheckout } from "../infrastructure/git/checkpoint-git.js";
import { withProgress } from "../infrastructure/logging/progress.js";
import { findWorkflowReadyTasks, taskRecord } from "./task-state.js";
import { saveCheckpoint, restoreCheckpoint } from "./checkpoints.js";
import { continueInterruptedTasks } from "./recovery.js";
import { dispatchReadyTasks } from "./dispatch.js";
import type { WorkflowRuntime } from "./runtime.js";

export async function runUntilComplete(state: WorkflowRuntime): Promise<void> {
  if (!state.store) return runLoop(state);
  await state.store.acquire();
  state.checkpointActive = true;
  try {
    if (state.resuming) {
      await withProgress("resume", { runId: state.runId }, async () =>
        restoreCheckpoint(state, await state.store!.load()),
      );
      console.log(
        `[workflow-log] ${JSON.stringify({
          event: "resumed",
          runId: state.runId,
          checkpoint: state.store.filePath,
          tasks: state.tasks.map((task) => ({
            taskId: task.id,
            status: task.status,
            phase: taskRecord(state, task).phase,
          })),
        })}`,
      );
      await continueInterruptedTasks(state);
    } else {
      if (await state.store.exists())
        throw new CheckpointError(
          `A saved run already exists at ${state.store.filePath}. Use --resume.`,
        );
      await state.workspaceManager.initialize();
      await verifyCheckout(state.projectRoot, "main");
      state.mainCommit = await state.gitManager.getCurrentMainCommit();
      await saveCheckpoint(state);
      console.log(
        `[workflow-log] ${JSON.stringify({ event: "started", runId: state.runId, checkpoint: state.store.filePath })}`,
      );
    }
    await runLoop(state);
  } finally {
    state.checkpointActive = false;
    await state.store.release();
  }
}

export async function runLoop(state: WorkflowRuntime): Promise<void> {
  while (true) {
    const readyTasks = findWorkflowReadyTasks(state);

    if (readyTasks.length === 0) {
      break;
    }

    console.log(`\n=== DISPATCHING ${readyTasks.length} TASK(S) ===\n`);

    for (const task of readyTasks) {
      console.log(
        `${task.id} | ${task.owner} | ` +
          `${task.title} | ` +
          `attempt ${task.attempts + 1}/${task.maxAttempts}`,
      );
    }

    await dispatchReadyTasks(state);

    const failedTasks = state.tasks.filter((task) => task.status === "failed");

    const integrationConflicts = state.tasks.filter(
      (task) => task.status === "integration_conflict",
    );

    if (failedTasks.length > 0) {
      throw new Error(
        `Workflow stopped because ` + `${failedTasks.length} task(s) permanently failed.`,
      );
    }

    if (integrationConflicts.length > 0) {
      throw new Error(
        `Workflow stopped with integration conflicts: ` +
          integrationConflicts
            .map((task) => `${task.id} [${task.conflictFiles.join(", ") || "unknown files"}]`)
            .join("; "),
      );
    }
  }

  const failedTasks = state.tasks.filter((task) => task.status === "failed");

  const pendingTasks = state.tasks.filter((task) => task.status === "pending");

  const integrationConflicts = state.tasks.filter((task) => task.status === "integration_conflict");

  if (failedTasks.length > 0) {
    throw new Error(
      `Workflow stopped because ` + `${failedTasks.length} task(s) permanently failed.`,
    );
  }

  if (pendingTasks.length > 0) {
    throw new Error(
      `Workflow stopped with ` +
        `${pendingTasks.length} pending task(s). ` +
        `This usually means there is an unresolved dependency.`,
    );
  }

  if (integrationConflicts.length > 0) {
    throw new Error(
      `Workflow stopped with integration conflicts: ` +
        integrationConflicts
          .map((task) => `${task.id} [${task.conflictFiles.join(", ") || "unknown files"}]`)
          .join("; "),
    );
  }
}
