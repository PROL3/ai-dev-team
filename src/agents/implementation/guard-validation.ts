import { logProgress } from "../../infrastructure/logging/progress.js";
import { MAX_NO_PROGRESS_STEPS, MAX_FAILED_ACTION_ATTEMPTS } from "./budget.js";
import { summarizeAudit, trimHistory, getChangedFiles, actionHistory } from "./audit.js";
import { getValidationRecovery } from "./recovery.js";
import type { AgentRunState, StepProgressFields, StepControl } from "./run-state.js";
import type { AgentAction } from "./protocol.js";

export async function guardValidation(
  state: AgentRunState,
  step: number,
  action: AgentAction,
  key: string,
  progressFields: StepProgressFields,
): Promise<StepControl> {
  const validationRecovery =
    action.action === "run_command"
      ? getValidationRecovery(state.audit, `${action.command} ${action.args.join(" ")}`)
      : undefined;
  // Runner errors can be transient. Allow one retry, then require investigation/repair.
  const canRetryExecution =
    validationRecovery?.executionError && (state.failedActionAttempts.get(key) ?? 0) < 2;
  if (
    validationRecovery?.state === "repair_required" &&
    action.action === "run_command" &&
    !canRetryExecution
  ) {
    logProgress("agent.action", "blocked", {
      ...progressFields,
      reason: "unchanged_failing_command",
    });
    const output =
      `VALIDATION_RECOVERY_REQUIRED: ${validationRecovery.command} failed. ` +
      "Repeating it without a corrective change will add no evidence. " +
      "Read relevant files, record a diagnosis, run a different diagnostic command, " +
      "or install approved missing dependencies. Correct the cause, then retry.";

    state.audit.push({
      step,
      action: "validation_recovery_blocked",
      input: action,
      output,
      success: false,
      command: `${action.command} ${action.args.join(" ")}`,
      progress: false,
      changedFiles: [],
      testResults: [],
    });

    const blockKey = `${validationRecovery.step}:${key}`;
    const blockedCount = (state.validationRecoveryBlocks.get(blockKey) ?? 0) + 1;
    state.validationRecoveryBlocks.set(blockKey, blockedCount);
    state.noProgressSteps += 1;
    state.history = trimHistory(`
STEP ${step}
ACTION:
${actionHistory(action)}

ERROR:
${output}

NEXT ACTION:
Inspect the reported test (${validationRecovery.referencedTestFiles.join(", ") || "discover it with list_files"}) and affected files (${validationRecovery.changedFiles.join(", ") || "discover them"}). Choose a targeted check or a fix supported by evidence.
`);

    if (
      blockedCount >= MAX_FAILED_ACTION_ATTEMPTS ||
      state.noProgressSteps >= MAX_NO_PROGRESS_STEPS
    ) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );
      return {
        success: false,
        summary:
          "Agent ignored mandatory validation recovery and repeatedly attempted " +
          `to repeat an unchanged failing command: ${key}.\n` +
          summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: "validation",
      };
    }

    return "continue";
  }
}
