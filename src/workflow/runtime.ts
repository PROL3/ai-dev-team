import type { ProjectPlan } from "../domain/plan.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowStore, CheckpointError } from "../infrastructure/persistence/workflow-store.js";
import type { TaskCheckpoint } from "../domain/workflow-state.js";
import { createTaskState, type ScheduledTask } from "../domain/scheduler.js";
import { executeTask } from "../agents/implementation/execute-task.js";
import { WorkspaceManager } from "../infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../infrastructure/git/integration-manager.js";
import { runTester } from "../agents/tester/run-tester.js";
import { runCodeReview } from "../agents/code-review/run-code-review.js";
import { authorTests } from "../agents/tester/author-tests.js";
import type { AgentExecutor, OrchestratorOptions } from "./types.js";

/** Mutable state owned by one Orchestrator instance; never shared across runs. */
export class WorkflowRuntime {
  tasks: ScheduledTask[];

  readonly plan: ProjectPlan;

  readonly store: WorkflowStore | undefined;

  runId: string = randomUUID();

  mainCommit = "";

  resuming = false;

  retryFailed = false;

  checkpointActive = false;

  readonly records = new Map<string, TaskCheckpoint>();

  readonly workspaceManager: WorkspaceManager;

  readonly gitManager: GitIntegrationManager;

  readonly executeAgent: AgentExecutor;

  readonly projectRoot: string;

  readonly enableTester: boolean;
  readonly enableCodeReview: boolean;
  readonly executeCodeReview: NonNullable<OrchestratorOptions["executeCodeReview"]>;
  readonly enableTestAuthoring: boolean;
  readonly executeTestAuthor: NonNullable<OrchestratorOptions["executeTestAuthor"]>;

  readonly executeTester: NonNullable<OrchestratorOptions["executeTester"]>;

  constructor(plan: ProjectPlan, options: OrchestratorOptions = {}) {
    this.plan = structuredClone(plan);
    this.store = options.checkpointPath ? new WorkflowStore(options.checkpointPath) : undefined;
    this.tasks = createTaskState(plan);
    this.projectRoot = path.resolve(
      options.projectRoot ??
        options.workspaceManager?.getProjectRoot() ??
        options.gitManager?.getProjectRoot() ??
        process.cwd(),
    );
    if (this.store) {
      const relative = path.relative(this.projectRoot, this.store.filePath);
      if (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      ) {
        throw new CheckpointError("Checkpoint files must be outside the project checkout.");
      }
    }
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager(this.projectRoot);
    this.gitManager = options.gitManager ?? new GitIntegrationManager(this.projectRoot);
    if (
      path.resolve(this.workspaceManager.getProjectRoot()) !== this.projectRoot ||
      path.resolve(this.gitManager.getProjectRoot()) !== this.projectRoot
    ) {
      throw new Error("Workspace, integration, and tester must use the same project root.");
    }
    this.executeAgent = options.executeAgent ?? executeTask;
    this.enableCodeReview = options.enableCodeReview ??
      (options.executeCodeReview !== undefined || options.executeAgent === undefined);
    this.executeCodeReview = options.executeCodeReview ?? runCodeReview;
    // Custom executors are commonly legacy/test integrations. They opt in so
    // existing callers do not unexpectedly invoke an LLM during an upgrade.
    this.enableTester =
      options.enableTester ??
      (options.executeTester !== undefined || options.executeAgent === undefined);
    if (this.enableCodeReview && !this.enableTester) {
      throw new Error("Code Review requires Tester to be enabled; provide a Tester executor or enable Tester.");
    }
    this.enableTestAuthoring = options.enableTestAuthoring ??
      (options.executeTestAuthor !== undefined ||
       (this.enableTester && options.executeAgent === undefined && options.executeTester === undefined));
    if (this.enableTestAuthoring && !this.enableTester) {
      throw new Error("Test authoring requires Tester to be enabled.");
    }
    this.executeTestAuthor = options.executeTestAuthor ?? authorTests;
    this.executeTester =
      options.executeTester ??
      (async (request) =>
        runTester({
          task: request.task,
          workspacePath: request.workspacePath,
          changedFiles: request.changedFiles,
          previousAgentSummary: request.previousAgentSummary,
          ...(request.testerTests ? { testerTests: request.testerTests } : {}),
          ...(request.previousTesterResult
            ? { previousTesterResult: request.previousTesterResult }
            : {}),
        }));
  }
}
