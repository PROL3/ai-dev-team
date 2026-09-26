import { logProgress, withProgress } from "../../infrastructure/logging/progress.js";
import { MAX_NO_PROGRESS_STEPS, MAX_REPEATED_ACTIONS } from "./budget.js";
import {
  agentActionSchema,
  cleanModelOutput,
  repairJsonProtocol,
  recoveryDecisionSchema,
  type AgentAction,
} from "./protocol.js";
import type { ToolAuditEntry, AgentRunResult } from "./types.js";
import { errorToMessage } from "./formatting.js";
import { getFailureType, summarizeAudit, trimHistory, getChangedFiles } from "./audit.js";
import { scopePath, scopeFailures } from "./recovery.js";
import type { AgentRunState } from "./run-state.js";

export async function requestAction(
  state: AgentRunState,
  step: number,
  prompt: string,
  recovery: ToolAuditEntry | undefined,
): Promise<AgentAction | AgentRunResult | undefined> {
  let rawOutput: string;

  try {
    rawOutput = await withProgress(
      "agent.llm",
      {
        taskId: state.task.id,
        role: state.task.owner,
        attempt: state.context?.attempt ?? 1,
        step,
        maxSteps: state.budget.hardMaxSteps,
        recovery: !!recovery,
      },
      () => state.ask(prompt),
    );
  } catch (error) {
    const errorMessage = errorToMessage(error);

    state.audit.push({
      step,
      action: "llm_error",
      input: prompt,
      output: errorMessage,
      success: false,
      progress: false,
      changedFiles: [],
      testResults: [],
    });

    state.noProgressSteps += 1;

    state.history = trimHistory(`
STEP ${step}
ACTION:
llm_error

ERROR:
${errorMessage}
`);

    if (state.noProgressSteps >= MAX_NO_PROGRESS_STEPS) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      return {
        success: false,
        summary:
          `LLM failed repeatedly and the agent could not continue.\n` + summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: "agent",
      };
    }

    return undefined;
  }

  const cleanedOutput = repairJsonProtocol(cleanModelOutput(rawOutput));

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleanedOutput);
  } catch (error) {
    const invalidKey = `invalid_json:${cleanedOutput}`;

    const invalidCount = (state.repeatedInvalidActions.get(invalidKey) ?? 0) + 1;

    state.repeatedInvalidActions.set(invalidKey, invalidCount);

    const parseError = errorToMessage(error);
    logProgress("agent", "response_rejected", {
      taskId: state.task.id,
      step,
      reason: "invalid_json",
    });

    state.audit.push({
      step,
      action: "invalid_json",
      input: cleanedOutput,
      output: `Model returned invalid JSON.\n` + `Parser error: ${parseError}`,
      success: false,
      progress: false,
      changedFiles: [],
      testResults: [],
    });

    state.noProgressSteps += 1;

    if (invalidCount >= MAX_REPEATED_ACTIONS) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      return {
        success: false,
        summary:
          `Agent repeatedly returned invalid JSON (${invalidCount} times).\n` +
          summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: getFailureType(state.audit),
      };
    }

    state.history = trimHistory(`
STEP ${step}
ERROR:
Model returned invalid JSON.

PARSER ERROR:
${parseError}

MODEL OUTPUT:
${cleanedOutput}
`);

    return undefined;
  }

  if (recovery) {
    const decision = recoveryDecisionSchema.safeParse(parsed);
    const next = decision.success ? decision.data.nextAction : undefined;
    const forbidden =
      next?.action === "write_file" &&
      scopeFailures(state.audit).some((entry) => scopePath(entry.path!) === scopePath(next.path));
    if (
      !decision.success ||
      !next ||
      next.action === "done" ||
      next.action === "diagnose" ||
      forbidden
    ) {
      const output =
        "Recovery requires diagnosis, observed evidence and a different investigative/corrective nextAction; repeating a blocked write or claiming completion is not accepted.";
      state.audit.push({
        step,
        action: "scope_recovery_rejected",
        input: parsed,
        output,
        success: false,
        progress: false,
        changedFiles: [],
        testResults: [],
      });
      state.noProgressSteps += 1;
      state.history = output;
      if (
        state.audit.filter(
          (entry) => entry.action === "scope_recovery_rejected" && entry.step > recovery.step,
        ).length >= 2
      ) {
        return {
          success: false,
          summary: `Agent could not produce a safe recovery decision for ${recovery.path}.\n${summarizeAudit(state.audit)}`,
          steps: step,
          audit: state.audit,
          changedFiles: await getChangedFiles(state.workspaceManager, state.workspace, state.audit),
          failureType: "agent",
        };
      }
      return undefined;
    }
    state.audit.push({
      step,
      action: "scope_recovery_decision",
      input: { diagnosis: decision.data.diagnosis, evidence: decision.data.evidence },
      output: JSON.stringify({
        diagnosis: decision.data.diagnosis,
        evidence: decision.data.evidence,
        nextAction: next.action,
      }),
      success: true,
      progress: false,
      changedFiles: [],
      testResults: [],
    });
    parsed = next;
  }

  const validation = agentActionSchema.safeParse(parsed);

  if (!validation.success) {
    logProgress("agent", "response_rejected", {
      taskId: state.task.id,
      step,
      reason: "invalid_action",
    });
    const errorMessage = validation.error.message;

    const invalidKey = `invalid_action:${JSON.stringify(parsed)}`;

    const invalidCount = (state.repeatedInvalidActions.get(invalidKey) ?? 0) + 1;

    state.repeatedInvalidActions.set(invalidKey, invalidCount);

    state.audit.push({
      step,
      action: "invalid_action",
      input: parsed,
      output: errorMessage,
      success: false,
      progress: false,
      changedFiles: [],
      testResults: [],
    });

    state.noProgressSteps += 1;

    if (invalidCount >= MAX_REPEATED_ACTIONS) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      return {
        success: false,
        summary:
          `Agent repeatedly returned the same invalid action (${invalidCount} times).\n` +
          summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: getFailureType(state.audit),
      };
    }

    state.history = trimHistory(`
STEP ${step}
ERROR:
Invalid agent action.

VALIDATION ERROR:
${errorMessage}

The next response must be one valid action matching the schema.
Do not repeat the same invalid JSON structure.
`);

    return undefined;
  }

  return validation.data;
}
