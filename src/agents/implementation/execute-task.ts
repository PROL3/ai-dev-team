import type { PlanTask } from "../../domain/plan.js";
import { runAgent, type AgentRunnerOptions } from "./run-agent.js";
import type { TesterRetryContext } from "../tester/run-tester.js";
import type { AgentSession } from "../../domain/workflow-state.js";
import { taskTestDirectory } from "../../domain/task-test-scope.js";
import type { CodeReviewResult } from "../../domain/code-review.js";
import type { TaskFailureType } from "../../domain/scheduler.js";

export type AgentResult = {
  taskId: string;
  owner: PlanTask["owner"];
  success: boolean;
  output: string;
  error?: string;
  changedFiles: string[];
  failureType?: TaskFailureType;
};

export type AgentContext = {
  testerOwnedTests?: string[];
  previousOutput?: string;
  previousError?: string;
  previousChangedFiles?: string[];
  attempt?: number;
  previousTesterResult?: TesterRetryContext;
  previousReview?: CodeReviewResult;
};

export type AgentExecutionContext = AgentContext & {
  plannedTasks?: readonly PlanTask[];
  workspacePath?: string;
  resumeSession?: AgentSession;
  onCheckpoint?: (session: AgentSession) => Promise<void>;
};

export async function executeTask(
  task: PlanTask,
  context?: AgentExecutionContext,
  options: AgentRunnerOptions = {},
): Promise<AgentResult> {
  if (!context?.workspacePath) {
    throw new Error(`No workspace provided for task ${task.id}`);
  }

  const assignedTestDirectory = context.plannedTasks
    ? taskTestDirectory(task, context.plannedTasks)
    : undefined;
  const feedback = {
    ...(context.testerOwnedTests ? { testerOwnedTests: context.testerOwnedTests } : {}),
    ...(assignedTestDirectory ? { assignedTestDirectory } : {}),
    ...(context.previousOutput !== undefined ? { previousOutput: context.previousOutput } : {}),
    ...(context.previousError !== undefined ? { previousError: context.previousError } : {}),
    ...(context.previousChangedFiles !== undefined
      ? { previousChangedFiles: context.previousChangedFiles }
      : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.previousTesterResult !== undefined
      ? { previousTesterResult: context.previousTesterResult }
      : {}),
    ...(context.previousReview ? { previousReview: context.previousReview } : {}),
  };

  const result = await runAgent(task, context.workspacePath, feedback, {
    ...options,
    ...(context.resumeSession ? { resumeSession: context.resumeSession } : {}),
    ...(context.onCheckpoint ? { onCheckpoint: context.onCheckpoint } : {}),
  });

  if (!result.success) {
    return {
      taskId: task.id,
      owner: task.owner,
      success: false,
      output: result.summary,
      error: result.summary,
      changedFiles: result.changedFiles,
      ...(result.failureType ? { failureType: result.failureType } : {}),
    };
  }

  return {
    taskId: task.id,
    owner: task.owner,
    success: true,
    output: result.summary,
    changedFiles: result.changedFiles,
  };
}
