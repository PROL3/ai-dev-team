import { createHash } from "node:crypto";
import { withProgress } from "../../infrastructure/logging/progress.js";
import {
  MAX_NO_PROGRESS_STEPS,
  MAX_REPEATED_ACTIONS,
  MAX_FAILED_ACTION_ATTEMPTS,
} from "./budget.js";
import { errorToMessage } from "./formatting.js";
import {
  getFailureType,
  actionKey,
  summarizeAudit,
  trimHistory,
  hasWrittenFiles,
  getChangedFiles,
  actionHistory,
} from "./audit.js";
import { scopePath } from "./recovery.js";
import { executeAction } from "./execute-action.js";
import type { AgentRunState, StepProgressFields, StepControl } from "./run-state.js";
import type { AgentAction } from "./protocol.js";

export async function executeStep(
  state: AgentRunState,
  step: number,
  action: AgentAction,
  key: string,
  progressFields: StepProgressFields,
): Promise<StepControl> {
  try {
    const result = await withProgress(
      "agent.tool",
      progressFields,
      () => executeAction(action, state.tools),
      {
        details: (result) => ({
          success: result.success,
          changed: result.progress,
          changedFiles: result.changedFiles.length,
          exitCode: result.exitCode,
        }),
      },
    );

    if (action.action === "write_file") {
      if (state.lastWritePath === action.path) {
        state.consecutiveWritePathCount += 1;
        if (state.consecutiveWritePathCount >= 2 && result.success) {
          const warning =
            "WARNING: You have already updated this file. Do NOT write to it again without testing it or moving to the next step. If you need packages, run 'npm install' via run_command.";
          result.output = `${warning}\n${result.output}`;
        }
      } else {
        state.lastWritePath = action.path;
        state.consecutiveWritePathCount = 1;
      }
    } else {
      state.lastWritePath = "";
      state.consecutiveWritePathCount = 0;
    }

    state.contextDirty =
      !result.success || action.action === "write_file" || action.action === "run_command";

    state.audit.push({
      step,
      action: action.action,
      input: action,
      output: result.output,
      success: result.success,
      ...(action.action === "read_file" || action.action === "write_file"
        ? { path: action.path }
        : action.action === "list_files" && action.path !== undefined
          ? { path: action.path }
          : {}),
      ...(action.action === "run_command"
        ? {
            command: `${action.command} ${action.args.join(" ")}`,
          }
        : {}),
      progress: result.progress,
      changedFiles: result.changedFiles,
      testResults: result.testResults,
    });

    // New inspections are useful progress during diagnosis. Repeated identical
    // observations earn no extra budget, and the hard step limit still applies.
    const evidenceKey = createHash("sha256").update(`${key}:${result.output}`).digest("hex");
    const newInspection =
      result.success &&
      (action.action === "read_file" || action.action === "list_files") &&
      !state.observedEvidence.has(evidenceKey);
    if (newInspection) state.observedEvidence.add(evidenceKey);

    if (result.progress) {
      state.noProgressSteps = 0;
      state.repeatedActionCount = 0;
      state.lastActionKey = "";
      // A changed implementation deserves a fresh validation attempt budget.
      for (const failedKey of state.failedActionAttempts.keys()) {
        if (failedKey.startsWith("run_command:")) state.failedActionAttempts.delete(failedKey);
      }
    } else if (newInspection) {
      state.noProgressSteps = 0;
    } else {
      state.noProgressSteps += 1;
    }

    const samePathWriteWarning =
      action.action === "write_file" &&
      state.lastWritePath === action.path &&
      state.consecutiveWritePathCount >= 2 &&
      result.success;

    if (samePathWriteWarning) {
      state.repeatedActionCount = 0;
      state.lastActionKey = "";
    }

    if (action.action === "write_file" && result.success) {
      state.successfulWrites.set(
        action.path,
        createHash("sha256").update(action.content).digest("hex"),
      );
    }

    if (action.action === "run_command" && result.success) {
      state.failedActionAttempts.delete(key);
      if (action.command === "npm" && action.args.length === 1 && action.args[0] === "install") {
        for (const failedKey of state.failedActionAttempts.keys()) {
          if (failedKey.startsWith("run_command:")) state.failedActionAttempts.delete(failedKey);
        }
      }
    }

    if (!result.success) {
      const failedKey =
        action.action === "write_file" &&
        result.output.includes("outside this task's planned files")
          ? `write_scope:${scopePath(action.path)}`
          : actionKey(action);
      const failedCount = (state.failedActionAttempts.get(failedKey) ?? 0) + 1;
      state.failedActionAttempts.set(failedKey, failedCount);

      if (failedCount >= MAX_FAILED_ACTION_ATTEMPTS) {
        const changedFiles = await getChangedFiles(
          state.workspaceManager,
          state.workspace,
          state.audit,
        );

        return {
          success: false,
          summary:
            `Agent repeated a failed action ${failedCount} times: ${failedKey}.\n` +
            summarizeAudit(state.audit),
          steps: step,
          audit: state.audit,
          changedFiles,
          failureType: getFailureType(state.audit),
        };
      }
    }

    state.history = trimHistory(`
STEP ${step}
ACTION:
${actionHistory(action)}

RESULT:
${result.output}

SUCCESS:
${result.success ? "true" : "false"}

PROGRESS:
${result.progress ? "true" : "false"}

CHANGED FILES:
${result.changedFiles.join(", ") || "none"}

TEST RESULTS:
${result.testResults.join("\n") || "none"}
`);

    /*
     * Repeated same-action protection.
     *
     * A single repeated inspection can be legitimate.
     * Repeating it several times is almost always an agent loop.
     */
    if (state.repeatedActionCount >= MAX_REPEATED_ACTIONS) {
      const changedFilesAfterFailure = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      const reason =
        `Agent repeated the same action ` +
        `${state.repeatedActionCount} times ` +
        `without meaningful progress: ${key}`;

      return {
        success: false,
        summary: `${reason}\n${summarizeAudit(state.audit)}`,
        steps: step,
        audit: state.audit,
        changedFiles: changedFilesAfterFailure,
        failureType: getFailureType(state.audit),
      };
    }

    /*
     * No-progress protection.
     *
     * Before failing, give the model enough room to implement.
     * The prompt dynamically becomes stricter after several
     * exploration-only steps.
     */
    if (state.noProgressSteps >= MAX_NO_PROGRESS_STEPS) {
      const changedFilesAfterFailure = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      const reason = hasWrittenFiles(state.audit)
        ? `Agent made no meaningful progress for ${state.noProgressSteps} steps after changes were made.`
        : `Agent made no meaningful progress for ${state.noProgressSteps} steps and did not implement the task.`;

      return {
        success: false,
        summary: `${reason}\n${summarizeAudit(state.audit)}`,
        steps: step,
        audit: state.audit,
        changedFiles: changedFilesAfterFailure,
        failureType: getFailureType(state.audit),
      };
    }
  } catch (error) {
    /*
     * This should rarely execute because executeAction itself
     * normalizes tool failures, but keep this outer safety net
     * so an unexpected error can never become an undefined
     * `.message` access in the orchestration layer.
     */
    const errorMessage = errorToMessage(error);

    const failedKey = actionKey(action);

    const failedCount = (state.failedActionAttempts.get(failedKey) ?? 0) + 1;

    state.failedActionAttempts.set(failedKey, failedCount);

    state.audit.push({
      step,
      action: action.action,
      input: action,
      output: errorMessage,
      success: false,
      ...(action.action === "read_file" || action.action === "write_file"
        ? { path: action.path }
        : {}),
      ...(action.action === "run_command"
        ? {
            command: `${action.command} ${action.args.join(" ")}`,
          }
        : {}),
      progress: false,
      changedFiles: [],
      testResults: [],
    });

    state.noProgressSteps += 1;

    state.history = trimHistory(`
STEP ${step}
ACTION:
${actionHistory(action)}

ERROR:
${errorMessage}

Do not repeat the exact same failing action blindly.
Use the error information to choose a different valid action.
`);

    if (failedCount >= MAX_FAILED_ACTION_ATTEMPTS) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      return {
        success: false,
        summary:
          `Agent repeated a failed action ` +
          `${failedCount} times: ${failedKey}.\n` +
          summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: getFailureType(state.audit),
      };
    }

    if (state.noProgressSteps >= MAX_NO_PROGRESS_STEPS) {
      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      return {
        success: false,
        summary:
          `Agent made no meaningful progress for ` +
          `${state.noProgressSteps} steps.\n` +
          summarizeAudit(state.audit),
        steps: step,
        audit: state.audit,
        changedFiles,
        failureType: getFailureType(state.audit),
      };
    }
  }
}
