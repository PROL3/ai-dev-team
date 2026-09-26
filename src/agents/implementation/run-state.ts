import type { AgentFeedback, ToolAuditEntry, AgentRunResult, AgentRunnerOptions } from "./types.js";
import { askLLM } from "../../infrastructure/llm/gateway.js";
import { WorkspaceManager } from "../../infrastructure/git/workspace-manager.js";
import { AgentTools } from "../../tools/agent-tools.js";
import type { PlanTask } from "../../domain/plan.js";
import { agentSessionSchema } from "../../domain/workflow-state.js";
import type { AgentWorkspaceContext } from "./workspace-context.js";
import { getBudget } from "./budget.js";

export function createRunState(
  task: PlanTask,
  workspacePath: string,
  context?: AgentFeedback,
  options: AgentRunnerOptions = {},
) {
  const tools =
    options.tools ??
    new AgentTools({
      role: task.owner,
      workspacePath,
      ...(task.files
        ? {
            allowedPaths: [
              ...task.files,
              ...(context?.assignedTestDirectory ? [context.assignedTestDirectory] : []),
            ],
          }
        : {}),
      ...(context?.assignedTestDirectory
        ? { assignedTestDirectory: context.assignedTestDirectory }
        : {}),
    });

  const workspaceManager = new WorkspaceManager();

  const workspace = {
    taskId: task.id,
    branchName: `ai/task/${task.id}`,
    path: workspacePath,
    baseCommit: "",
  };

  const resumed = options.resumeSession
    ? agentSessionSchema.parse(options.resumeSession)
    : undefined;
  const audit: ToolAuditEntry[] = (resumed?.audit ?? []).map(({ path, command, ...entry }) => ({
    ...entry,
    ...(path !== undefined ? { path } : {}),
    ...(command !== undefined ? { command } : {}),
  }));

  let history = resumed?.history ?? "";

  const budget = getBudget(task.owner, resumed?.budget ?? options.budget);

  const ask = options.ask ?? askLLM;

  let lastActionKey = resumed?.lastActionKey ?? "";
  let repeatedActionCount = resumed?.repeatedActionCount ?? 0;
  let lastWritePath = "";
  let consecutiveWritePathCount = 0;

  const repeatedInvalidActions = new Map<string, number>(resumed?.repeatedInvalidActions);

  const failedActionAttempts = new Map<string, number>(resumed?.failedActionAttempts);
  const validationRecoveryBlocks = new Map<string, number>(resumed?.validationRecoveryBlocks);
  // Re-check actual files after an interrupted process; do not trust cached writes.
  const successfulWrites = new Map<string, string>();
  const observedEvidence = new Set<string>(resumed?.observedEvidence);

  let noProgressSteps = resumed?.noProgressSteps ?? 0;
  let softLimitReached = false;
  let workspaceContext: AgentWorkspaceContext | undefined;
  let contextDirty = true;

  return {
    task,
    workspacePath,
    context,
    options,
    tools,
    workspaceManager,
    workspace,
    resumed,
    audit,
    history,
    budget,
    ask,
    lastActionKey,
    repeatedActionCount,
    lastWritePath,
    consecutiveWritePathCount,
    repeatedInvalidActions,
    failedActionAttempts,
    validationRecoveryBlocks,
    successfulWrites,
    observedEvidence,
    noProgressSteps,
    softLimitReached,
    workspaceContext,
    contextDirty,
  };
}

export type AgentRunState = ReturnType<typeof createRunState>;
export type StepProgressFields = Record<string, string | number | boolean | undefined>;
export type StepControl = AgentRunResult | "continue" | undefined;
