import { tasksOverlap } from "../domain/task-ownership.js";
import type { TaskCheckpoint } from "../domain/workflow-state.js";
import { getReadyTasks, type TaskFailureType, type ScheduledTask } from "../domain/scheduler.js";
import type { WorkflowRuntime } from "./runtime.js";

export function selectDispatchableTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  const selected: ScheduledTask[] = [];

  for (const task of tasks) {
    const overlaps = selected.some((other) => tasksOverlap(task, other));

    if (overlaps) {
      continue;
    }

    selected.push(task);
  }

  return selected;
}

export function findWorkflowReadyTasks(state: WorkflowRuntime): ScheduledTask[] {
  return getReadyTasks(state.tasks);
}

export function startTask(state: WorkflowRuntime, taskId: string): void {
  const task = state.tasks.find((task) => task.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.status !== "pending") {
    throw new Error(`Task ${taskId} cannot be started because its status is ${task.status}`);
  }

  const readyTasks = findWorkflowReadyTasks(state);

  const isReady = readyTasks.some((readyTask) => readyTask.id === taskId);

  if (!isReady) {
    throw new Error(`Task ${taskId} is not ready yet`);
  }

  task.status = "running";
  task.attempts += 1;
  const record = taskRecord(state, task);
  record.phase = "implementing";
  delete record.result;
  delete record.session;
  delete record.testerResult;
  delete record.testerCommit;
  delete record.reviewResult;
  delete record.testDraft;
  delete record.testAuthorAttempts;
  if (task.error !== undefined) record.previousError = task.error;
  else delete record.previousError;

  delete task.error;
  delete task.failureType;
}

export function completeTask(state: WorkflowRuntime, taskId: string, output?: string): void {
  const task = state.tasks.find((task) => task.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.status !== "running") {
    throw new Error(`Task ${taskId} cannot be completed because its status is ${task.status}`);
  }

  task.status = "completed";
  taskRecord(state, task).phase = "settled";

  if (output === undefined) {
    delete task.output;
  } else {
    task.output = output;
  }

  delete task.error;
  delete task.integrationError;
  task.conflictFiles = [];
  delete task.failureType;
}

export function handleTaskFailure(
  state: WorkflowRuntime,
  taskId: string,
  error: string,
  output?: string,
  failureType: TaskFailureType = "agent",
): void {
  const task = state.tasks.find((task) => task.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.status !== "running") {
    throw new Error(`Task ${taskId} cannot fail because its status is ${task.status}`);
  }

  task.error = error;
  task.failureType = failureType;
  taskRecord(state, task).phase = "settled";

  if (output !== undefined && output.length > 0) {
    task.output = output;
  }

  if (task.attempts < task.maxAttempts) {
    task.status = "pending";

    console.log(
      `↻ ${task.id} will be retried ` + `(attempt ${task.attempts + 1}/${task.maxAttempts})`,
    );
  } else {
    task.status = "failed";

    console.log(`✗ ${task.id} permanently failed ` + `after ${task.attempts} attempt(s)`);
  }
}

export function taskRecord(state: WorkflowRuntime, task: ScheduledTask): TaskCheckpoint {
  let record = state.records.get(task.id);
  if (!record) {
    record = { task, phase: "settled" };
    state.records.set(task.id, record);
  }
  return record;
}

export function allTasks(state: WorkflowRuntime): ScheduledTask[] {
  return state.tasks;
}
