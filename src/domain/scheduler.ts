import type { ArchitectureContract, ProjectPlan, PlanTask } from "./plan.js";
import type { CodeReviewResult } from "./code-review.js";

export type TaskStatus = "pending" | "running" | "integration_conflict" | "completed" | "failed";

export type TaskFailureType = "agent" | "validation" | "integration" | "test" | "review";

export type ScheduledTask = PlanTask & {
  architecture?: ArchitectureContract;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  output?: string;
  error?: string;
  previousChangedFiles?: string[];
  workspacePath?: string;
  branchName?: string;
  baseCommit?: string;
  commitHash?: string;
  integrationAttempts: number;
  testerAttempts: number;
  testerMaxAttempts: number;
  reviewAttempts: number;
  reviewMaxAttempts: number;
  previousReview?: CodeReviewResult;
  previousTesterResult?: {
    passed: boolean;
    summary: string;
    failures: string[];
    suggestedFixes: string[];
  };
  integrationError?: string;
  conflictFiles: string[];
  failureType?: TaskFailureType;
};

export function createTaskState(plan: ProjectPlan): ScheduledTask[] {
  return plan.tasks.map((task) => {
    const { architecture: _taskArchitecture, ...taskWithoutArchitecture } = task;

    return {
      ...taskWithoutArchitecture,
      ...(plan.architecture ? { architecture: plan.architecture } : {}),
      status: "pending",
      attempts: 0,
      maxAttempts: 2,
      integrationAttempts: 0,
      testerAttempts: 0,
      testerMaxAttempts: 2,
      reviewAttempts: 0,
      reviewMaxAttempts: 4,
      conflictFiles: [],
    };
  });
}

export function getReadyTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  const completedTaskIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );

  return tasks.filter((task) => {
    if (task.status !== "pending") {
      return false;
    }

    return task.dependencies.every((dependencyId) => completedTaskIds.has(dependencyId));
  });
}
