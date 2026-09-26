import type { ProjectPlan } from "../domain/plan.js";
import path from "node:path";
import {
  WorkflowStore,
  CheckpointError,
  defaultCheckpointPath,
} from "../infrastructure/persistence/workflow-store.js";
import type { TaskFailureType, ScheduledTask } from "../domain/scheduler.js";
import type { AgentResult } from "../agents/implementation/execute-task.js";
import {
  findWorkflowReadyTasks,
  startTask,
  completeTask,
  handleTaskFailure,
  allTasks,
} from "./task-state.js";
import { dispatchReadyTasks, retryIntegration } from "./dispatch.js";
import { runUntilComplete } from "./execution.js";
import { WorkflowRuntime } from "./runtime.js";
import type { OrchestratorOptions } from "./types.js";

/** Public workflow API. Stage implementations live alongside this facade. */
export class Orchestrator {
  private readonly state: WorkflowRuntime;

  constructor(plan: ProjectPlan, options: OrchestratorOptions = {}) {
    this.state = new WorkflowRuntime(plan, options);
  }

  static async resume(
    projectRoot: string,
    options: OrchestratorOptions = {},
  ): Promise<Orchestrator> {
    const checkpointPath = options.checkpointPath ?? defaultCheckpointPath(projectRoot);
    const saved = await new WorkflowStore(checkpointPath).load();
    if (path.resolve(saved.projectRoot) !== path.resolve(projectRoot))
      throw new CheckpointError("Checkpoint belongs to a different project.");
    if (options.enableTester !== undefined && options.enableTester !== saved.enableTester) {
      throw new CheckpointError("Resume cannot change whether Tester is enabled.");
    }
    if (options.enableCodeReview !== undefined && options.enableCodeReview !== saved.enableCodeReview) {
      throw new CheckpointError("Resume cannot change whether Code Review is enabled.");
    }
    if (options.enableTestAuthoring !== undefined && options.enableTestAuthoring !== saved.enableTestAuthoring) {
      throw new CheckpointError("Resume cannot change whether test authoring is enabled.");
    }
    const orchestrator = new Orchestrator(saved.plan, {
      ...options,
      projectRoot,
      checkpointPath,
      enableTester: saved.enableTester,
      enableCodeReview: saved.enableCodeReview,
      enableTestAuthoring: saved.enableTestAuthoring,
    });
    orchestrator.state.runId = saved.runId;
    orchestrator.state.resuming = true;
    orchestrator.state.retryFailed = options.retryFailed ?? false;
    return orchestrator;
  }

  getReadyTasks(): ScheduledTask[] {
    return findWorkflowReadyTasks(this.state);
  }
  getAllTasks(): ScheduledTask[] {
    return allTasks(this.state);
  }
  startTask(taskId: string): void {
    startTask(this.state, taskId);
  }
  completeTask(taskId: string, output?: string): void {
    completeTask(this.state, taskId, output);
  }
  handleTaskFailure(
    taskId: string,
    error: string,
    output?: string,
    failureType: TaskFailureType = "agent",
  ): void {
    handleTaskFailure(this.state, taskId, error, output, failureType);
  }
  retryIntegration(taskId: string): Promise<AgentResult> {
    return retryIntegration(this.state, taskId);
  }
  dispatchReadyTasks(): Promise<AgentResult[]> {
    return dispatchReadyTasks(this.state);
  }
  runUntilComplete(): Promise<void> {
    return runUntilComplete(this.state);
  }
}

export type { OrchestratorOptions } from "./types.js";
