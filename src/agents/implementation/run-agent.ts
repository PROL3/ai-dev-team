import type { AgentFeedback, AgentRunResult, AgentRunnerOptions } from "./types.js";
import { logProgress, progressCommand } from "../../infrastructure/logging/progress.js";
import type { PlanTask } from "../../domain/plan.js";
import { getFailureType, actionKey, summarizeAudit, getChangedFiles } from "./audit.js";
import { createRunState } from "./run-state.js";
import { prepareStep } from "./prepare-step.js";
import { requestAction } from "./request-action.js";
import { guardValidation } from "./guard-validation.js";
import { guardWrite } from "./guard-write.js";
import { guardCompletion } from "./guard-completion.js";
import { executeStep } from "./execute-step.js";

export async function runAgent(
  task: PlanTask,
  workspacePath: string,
  context?: AgentFeedback,
  options: AgentRunnerOptions = {},
): Promise<AgentRunResult> {
  const state = createRunState(task, workspacePath, context, options);
  for (let step = state.resumed?.nextStep ?? 1; step <= state.budget.hardMaxSteps; step++) {
    const { prompt, recovery } = await prepareStep(state, step);
    const selected = await requestAction(state, step, prompt, recovery);
    if (!selected) continue;
    if (!("action" in selected)) return selected;
    const action = selected;
    const progressFields = {
      taskId: state.task.id,
      role: state.task.owner,
      attempt: state.context?.attempt ?? 1,
      step,
      action: action.action,
      ...(action.action === "write_file" ||
      action.action === "read_file" ||
      action.action === "list_files"
        ? { path: action.path ?? "." }
        : {}),
      ...(action.action === "run_command"
        ? { command: progressCommand(action.command, action.args) }
        : {}),
    };
    logProgress("agent.action", "selected", progressFields);
    const key = actionKey(action);

    const validation = await guardValidation(state, step, action, key, progressFields);
    if (validation === "continue") continue;
    if (validation) return validation;

    if (key === state.lastActionKey) {
      state.repeatedActionCount += 1;
    } else {
      state.lastActionKey = key;
      state.repeatedActionCount = 1;
    }

    const write = await guardWrite(state, step, action, progressFields);
    if (write === "continue") continue;
    if (write) return write;

    const completion = await guardCompletion(state, step, action, progressFields);
    if (completion === "continue") continue;
    if (completion) return completion;

    const result = await executeStep(state, step, action, key, progressFields);
    if (result && result !== "continue") return result;
  }

  const finalWorkspace = {
    taskId: state.task.id,
    branchName: `ai/task/${state.task.id}`,
    path: state.workspacePath,
    baseCommit: "",
  };

  const changedFiles = await getChangedFiles(state.workspaceManager, finalWorkspace, state.audit);

  return {
    success: false,
    summary:
      `Agent exceeded hard execution limit ` +
      `(${state.budget.hardMaxSteps} steps).\n` +
      summarizeAudit(state.audit),
    steps: state.budget.hardMaxSteps,
    audit: state.audit,
    changedFiles,
    failureType: getFailureType(state.audit),
  };
}

export type { AgentBudget, ToolAuditEntry, AgentRunResult, AgentRunnerOptions } from "./types.js";
