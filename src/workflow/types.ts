import type { ScheduledTask } from "../domain/scheduler.js";
import type { AgentExecutionContext, AgentResult } from "../agents/implementation/execute-task.js";
import { WorkspaceManager } from "../infrastructure/git/workspace-manager.js";
import { GitIntegrationManager } from "../infrastructure/git/integration-manager.js";
import type { TesterResult, TesterRetryContext } from "../agents/tester/run-tester.js";
import type { CodeReviewRequest } from "../agents/code-review/types.js";
import type { CodeReviewResult } from "../domain/code-review.js";
import type { TestAuthorRequest } from "../agents/tester/author-tests.js";
import type { TestAuthorResponse, TesterTestArtifact } from "../domain/test-authoring.js";

export type AgentExecutor = (
  task: ScheduledTask,
  context: AgentExecutionContext,
) => Promise<AgentResult>;

export type OrchestratorOptions = {
  /** Explicitly grant one additional attempt to failed tasks during resume. */
  retryFailed?: boolean;
  /** Opt-in for library callers; CLI runs enable persistence by default. */
  checkpointPath?: string;
  projectRoot?: string;
  workspaceManager?: WorkspaceManager;
  gitManager?: GitIntegrationManager;
  executeAgent?: AgentExecutor;
  enableTester?: boolean;
  enableCodeReview?: boolean;
  enableTestAuthoring?: boolean;
  executeTestAuthor?: (request: TestAuthorRequest) => Promise<TestAuthorResponse>;
  executeCodeReview?: (request: CodeReviewRequest) => Promise<CodeReviewResult>;
  executeTester?: (request: {
    task: ScheduledTask;
    workspacePath: string;
    changedFiles: string[];
    previousAgentSummary: string;
    testerTests?: TesterTestArtifact[];
    previousTesterResult?: TesterRetryContext;
  }) => Promise<TesterResult>;
};
