import { CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import { withProgress } from "../infrastructure/logging/progress.js";
import type { TaskCheckpoint } from "../domain/workflow-state.js";
import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import { taskRecord } from "./task-state.js";
import { saveCheckpoint } from "./checkpoints.js";
import type { WorkflowRuntime } from "./runtime.js";

export async function ensureWorkspaces(
  state: WorkflowRuntime,
  tasks: ScheduledTask[],
): Promise<void> {
  await state.workspaceManager.initialize();

  for (const task of tasks) {
    if (task.workspacePath && task.branchName) {
      continue;
    }

    const workspace = await withProgress("workspace", { taskId: task.id }, () =>
      state.workspaceManager.createTaskWorkspace(task.id),
    );

    task.workspacePath = workspace.path;

    task.branchName = workspace.branchName;
    task.baseCommit = workspace.baseCommit;
    taskRecord(state, task).workspaceHead = workspace.baseCommit;
  }
  await saveCheckpoint(state);
}

export async function executeAndCheckpoint(
  state: WorkflowRuntime,
  task: ScheduledTask,
  previousError?: string,
): Promise<AgentResult> {
  if (!task.workspacePath) throw new Error(`No workspace path for task ${task.id}`);
  const workspacePath = task.workspacePath;
  const record = taskRecord(state, task);
  let result: AgentResult;
  try {
    result = await withProgress(
      "implementation",
      { taskId: task.id, role: task.owner, attempt: task.attempts },
      () =>
        state.executeAgent(task, {
          workspacePath,
          attempt: task.attempts,
          plannedTasks: state.plan.tasks,
          ...(record.testerTests ? { testerOwnedTests: record.testerTests.map((test) => test.path) } : {}),
          ...(task.output !== undefined ? { previousOutput: task.output } : {}),
          ...(previousError !== undefined ? { previousError } : {}),
          ...(task.previousChangedFiles ? { previousChangedFiles: task.previousChangedFiles } : {}),
          ...(task.previousTesterResult ? { previousTesterResult: task.previousTesterResult } : {}),
          ...(task.previousReview ? { previousReview: task.previousReview } : {}),
          ...(record.session ? { resumeSession: record.session } : {}),
          ...(state.store
            ? {
                onCheckpoint: async (session: NonNullable<TaskCheckpoint["session"]>) => {
                  record.session = session;
                  await saveCheckpoint(state);
                },
              }
            : {}),
        }),
      {
        heartbeatMs: 0,
        details: (result) => ({
          success: result.success,
          changedFiles: result.changedFiles.length,
        }),
      },
    );
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    result = {
      taskId: task.id,
      owner: task.owner,
      success: false,
      output: message,
      error: message,
      changedFiles: [],
      failureType: "agent",
    };
  }
  record.phase = "agent_finished";
  record.result = result;
  delete record.session;
  await saveCheckpoint(state);
  return result;
}
