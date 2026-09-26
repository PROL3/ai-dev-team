import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import { handleTaskFailure, taskRecord } from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import { executeAndCheckpoint } from "./implementation.js";
import { integrateSuccessfulTask } from "./integration.js";
import { validateIntegratedTask } from "./validation.js";
import { logTask } from "./logging.js";
import type { WorkflowRuntime } from "./runtime.js";
import { prepareTesterTests } from "./test-authoring.js";

export async function continueInterruptedTasks(state: WorkflowRuntime): Promise<void> {
  const unfinished = state.tasks.filter(
    (task) => task.status === "running" && taskRecord(state, task).phase === "implementing",
  );
  const continuations = await Promise.allSettled(
    unfinished.map((task) =>
      executeAndCheckpoint(state, task, taskRecord(state, task).previousError),
    ),
  );
  for (const continuation of continuations) {
    if (continuation.status === "rejected") throw continuation.reason;
  }
  for (const task of state.tasks) {
    const record = taskRecord(state, task);
    if (task.status !== "running") continue;
    let result = record.result as AgentResult | undefined;
    if (!result)
      throw new CheckpointError(`No implementation result for interrupted task ${task.id}.`);
    if (!result.success) {
      handleTaskFailure(
        state,
        task.id,
        result.error ?? "Agent failed",
        result.output,
        result.failureType ?? "agent",
      );
      task.previousChangedFiles = result.changedFiles;
      record.phase = "settled";
      await saveCheckpoint(state);
      logTask(task, {
        agentStatus: "failed",
        currentMainCommit: state.mainCommit,
        integrationAttempt: task.integrationAttempts,
        mergeResult: "not_attempted",
        conflictFiles: [],
        error: result.error ?? result.output,
        finalStatus: task.status,
      });
      continue;
    }
    if (record.phase === "agent_finished" || record.phase === "authoring_tests") {
      result = await prepareTesterTests(state, task, result);
      if (!result.success) continue;
    }
    if (record.phase === "agent_finished" || record.phase === "integrating") {
      result = await integrateSuccessfulTask(state, task, result, record.phase === "integrating");
    }
    await validateIntegratedTask(state, task, result, record.phase === "testing");
  }
}
