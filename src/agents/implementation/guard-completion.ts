import { logProgress } from "../../infrastructure/logging/progress.js";
import { MAX_REPEATED_ACTIONS } from "./budget.js";
import { summarizeAudit, trimHistory, getChangedFiles } from "./audit.js";
import { getUnresolvedCommandFailure } from "./recovery.js";
import type { AgentRunState, StepProgressFields, StepControl } from "./run-state.js";
import type { AgentAction } from "./protocol.js";

export async function guardCompletion(
  state: AgentRunState,
  step: number,
  action: AgentAction,
  progressFields: StepProgressFields,
): Promise<StepControl> {
  /*
   * DONE is handled before executeAction.
   * The agent must have actually changed files.
   */
  if (action.action === "done") {
    const changedFiles = await getChangedFiles(
      state.workspaceManager,
      state.workspace,
      state.audit,
    );

    if (changedFiles.length === 0) {
      logProgress("agent.action", "blocked", { ...progressFields, reason: "no_changed_files" });
      const error = "Agent attempted to finish the task " + "without modifying any files.";

      state.audit.push({
        step,
        action: "done",
        input: action,
        output: error,
        success: false,
        progress: false,
        changedFiles: [],
        testResults: [],
      });

      state.noProgressSteps += 1;

      if (state.repeatedActionCount >= MAX_REPEATED_ACTIONS) {
        return {
          success: false,
          summary:
            `Agent repeatedly returned done without modifying files ` +
            `(${state.repeatedActionCount} times).\n` +
            summarizeAudit(state.audit),
          steps: step,
          audit: state.audit,
          changedFiles,
          failureType: "agent",
        };
      }

      state.history = trimHistory(`
STEP ${step}

ERROR:
${error}

You are NOT allowed to return action="done" yet.

You have not changed any project files.

NEXT ACTION:
1. Inspect the actual repository structure if needed.
2. Choose the real files relevant to the task.
3. Implement the task using write_file.
4. Run an appropriate validation command.
5. Verify the changed files.
6. Only then return action="done".
`);

      return "continue";
    }

    /*
     * If the agent has a failed validation as its latest meaningful
     * validation step, explicitly tell it to fix before finishing.
     */
    const latestFailedCommand = getUnresolvedCommandFailure(state.audit);

    if (latestFailedCommand) {
      logProgress("agent.action", "blocked", {
        ...progressFields,
        reason: "unresolved_validation_failure",
      });
      state.audit.push({
        step,
        action: "done",
        input: action,
        output: "Agent attempted to finish while the latest validation " + "command was failing.",
        success: false,
        progress: false,
        changedFiles,
        testResults: [],
      });

      state.noProgressSteps += 1;

      state.history = trimHistory(`
STEP ${step}

ERROR:
The latest validation command failed.

VALIDATION FAILURE:
${latestFailedCommand.output}

Do NOT return action="done" yet.

Fix the implementation, rerun the relevant validation,
and only return done after the implementation is in a
valid state.
`);

      return "continue";
    }

    state.audit.push({
      step,
      action: "done",
      input: action,
      output: action.summary,
      success: true,
      progress: true,
      changedFiles,
      testResults: [],
    });

    return {
      success: true,
      summary: action.summary,
      steps: step,
      audit: state.audit,
      changedFiles,
    };
  }
}
