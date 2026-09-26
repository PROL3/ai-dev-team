import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import {
  selectDispatchableTasks,
  findWorkflowReadyTasks,
  startTask,
  handleTaskFailure,
  taskRecord,
} from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import { ensureWorkspaces, executeAndCheckpoint } from "./implementation.js";
import { integrateSuccessfulTask } from "./integration.js";
import { validateIntegratedTask } from "./validation.js";
import { logTask } from "./logging.js";
import type { WorkflowRuntime } from "./runtime.js";
import { prepareTesterTests } from "./test-authoring.js";

export async function retryIntegration(
  state: WorkflowRuntime,
  taskId: string,
): Promise<AgentResult> {
  const task = state.tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.status !== "integration_conflict") {
    throw new Error(`Task ${taskId} cannot retry integration from status ${task.status}`);
  }

  task.status = "running";

  const integrated = await integrateSuccessfulTask(state, task, {
    taskId: task.id,
    owner: task.owner,
    success: true,
    output: task.output ?? "",
    changedFiles: task.previousChangedFiles ?? task.conflictFiles,
  });
  return validateIntegratedTask(state, task, integrated);
}

export async function dispatchReadyTasks(state: WorkflowRuntime): Promise<AgentResult[]> {
  const readyTasks = selectDispatchableTasks(findWorkflowReadyTasks(state));

  if (readyTasks.length === 0) {
    return [];
  }

  console.log(`\nPreparing ${readyTasks.length} task(s)...\n`);

  // Git worktree creation is sequential.
  await ensureWorkspaces(state, readyTasks);

  console.log(`Dispatching ${readyTasks.length} task(s) in parallel...\n`);

  const previousErrors = new Map(readyTasks.map((task) => [task.id, task.error]));

  for (const task of readyTasks) {
    console.log(`${task.id} | ${task.owner} | ` + `${task.workspacePath}`);

    startTask(state, task.id);
  }
  await saveCheckpoint(state);

  const results = await Promise.allSettled(
    readyTasks.map((task) => executeAndCheckpoint(state, task, previousErrors.get(task.id))),
  );
  for (const result of results) {
    if (result.status === "rejected" && result.reason instanceof CheckpointError)
      throw result.reason;
  }

  const agentResults: AgentResult[] = [];
  const successfulAgents: Array<{
    task: ScheduledTask;
    result: AgentResult;
  }> = [];

  /*
   * Important:
   *
   * Agents run in parallel.
   * Integration happens one task at a time.
   *
   * This prevents multiple simultaneous
   * merges from touching the main repository.
   */
  for (const [index, task] of readyTasks.entries()) {
    const result = results[index];

    if (!result) {
      throw new Error(`Missing execution result for task ${task.id}`);
    }

    if (result.status === "rejected") {
      const errorMessage =
        result.reason instanceof Error ? result.reason.message : String(result.reason);

      handleTaskFailure(state, task.id, errorMessage);
      task.previousChangedFiles = [];

      logTask(task, {
        agentStatus: "failed",
        currentMainCommit: await state.gitManager.getCurrentMainCommit(),
        integrationAttempt: task.integrationAttempts,
        mergeResult: "not_attempted",
        conflictFiles: [],
        error: errorMessage,
        finalStatus: task.status,
      });

      agentResults.push({
        taskId: task.id,
        owner: task.owner,
        success: false,
        output: "",
        error: errorMessage,
        changedFiles: [],
      });

      continue;
    }

    const agentResult = result.value;

    if (!agentResult.success) {
      task.previousChangedFiles = agentResult.changedFiles;
      handleTaskFailure(
        state,
        task.id,
        agentResult.error ?? "Unknown agent error",
        agentResult.output,
        agentResult.failureType ?? "agent",
      );

      agentResults.push(agentResult);

      logTask(task, {
        agentStatus: "failed",
        currentMainCommit: await state.gitManager.getCurrentMainCommit(),
        integrationAttempt: task.integrationAttempts,
        mergeResult: "not_attempted",
        conflictFiles: [],
        ...(agentResult.error ? { error: agentResult.error } : {}),
        finalStatus: task.status,
      });

      continue;
    }

    successfulAgents.push({ task, result: agentResult });
  }

  await saveCheckpoint(state);

  // The queue is deliberately drained after all agents finish.
  // Its array order is deterministic and every integration is awaited.
  for (const { task, result: agentResult } of successfulAgents) {
    try {
      const prepared = await prepareTesterTests(state, task, agentResult);
      if (!prepared.success) {
        agentResults.push(prepared);
        continue;
      }
      const integrated = await integrateSuccessfulTask(state, task, prepared);
      agentResults.push(await validateIntegratedTask(state, task, integrated));
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (
        task.status === "integration_conflict" &&
        task.integrationError?.includes("Cleanup failed")
      ) {
        throw error;
      }

      task.status = "integration_conflict";
      task.failureType = "integration";
      task.integrationError = `Integration failed: ${errorMessage}`;
      task.conflictFiles = [];
      taskRecord(state, task).phase = "settled";
      await saveCheckpoint(state);

      logTask(task, {
        agentStatus: "succeeded",
        currentMainCommit: await state.gitManager.getCurrentMainCommit(),
        integrationAttempt: task.integrationAttempts,
        mergeResult: "failed",
        conflictFiles: [],
        error: errorMessage,
        finalStatus: task.status,
      });

      agentResults.push({
        ...agentResult,
        success: false,
        error: `Integration failed: ${errorMessage}`,
        changedFiles: agentResult.changedFiles,
        failureType: "integration",
      });
    }
  }

  return agentResults;
}
