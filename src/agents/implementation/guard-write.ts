import { createHash } from "node:crypto";
import { logProgress } from "../../infrastructure/logging/progress.js";
import { MAX_REPEATED_ACTIONS } from "./budget.js";
import {
  summarizeAudit,
  trimHistory,
  getChangedFiles,
  actionHistory,
  hasCompletedPlannedWrites,
} from "./audit.js";
import { getUnresolvedCommandFailure } from "./recovery.js";
import type { AgentRunState, StepProgressFields, StepControl } from "./run-state.js";
import type { AgentAction } from "./protocol.js";

export async function guardWrite(
  state: AgentRunState,
  step: number,
  action: AgentAction,
  progressFields: StepProgressFields,
): Promise<StepControl> {
  if (action.action === "write_file") {
    const contentHash = createHash("sha256").update(action.content).digest("hex");

    if (state.successfulWrites.get(action.path) === contentHash) {
      logProgress("agent.action", "skipped", {
        ...progressFields,
        reason: "content_already_written",
      });
      const output =
        `${action.path} was already written successfully with the same content ` +
        `(${contentHash.slice(0, 12)}). Do not repeat this write. ` +
        "Inspect the file, run relevant validation, or finish the task.";

      state.audit.push({
        step,
        action: "write_file",
        input: action,
        output,
        success: true,
        path: action.path,
        progress: false,
        changedFiles: [],
        testResults: [],
      });

      state.noProgressSteps += 1;
      state.history = trimHistory(`
STEP ${step}
ACTION:
${actionHistory(action)}

RESULT:
${output}

SUCCESS:
true

PROGRESS:
false
`);

      if (state.lastWritePath === action.path && state.consecutiveWritePathCount >= 2) {
        state.repeatedActionCount = 0;
        state.lastActionKey = "";
        state.lastWritePath = action.path;
      }

      if (state.repeatedActionCount >= MAX_REPEATED_ACTIONS) {
        const changedFiles = await getChangedFiles(
          state.workspaceManager,
          state.workspace,
          state.audit,
        );

        return {
          success: false,
          summary:
            `Agent repeatedly requested an already successful write ` +
            `(${state.repeatedActionCount} times): ${action.path}.\n` +
            summarizeAudit(state.audit),
          steps: step,
          audit: state.audit,
          changedFiles,
          failureType: "agent",
        };
      }

      const changedFiles = await getChangedFiles(
        state.workspaceManager,
        state.workspace,
        state.audit,
      );

      /*
       * Some local models ignore corrective tool feedback and emit the
       * same write forever. When every planned write is already present
       * and verified, the duplicate is confirmation rather than unfinished
       * work. Finish safely instead of turning a successful task into a
       * retry loop. Tasks without explicit planned files still require the
       * model to return done.
       */
      if (
        hasCompletedPlannedWrites(state.task, changedFiles) &&
        !getUnresolvedCommandFailure(state.audit)
      ) {
        const summary =
          `Completed verified planned file changes: ${changedFiles.join(", ")}. ` +
          `Ignored duplicate write request for ${action.path}.`;

        state.audit.push({
          step,
          action: "done",
          input: { action: "done", summary },
          output: summary,
          success: true,
          progress: true,
          changedFiles,
          testResults: [],
        });

        return {
          success: true,
          summary,
          steps: step,
          audit: state.audit,
          changedFiles,
        };
      }

      return "continue";
    }
  }
}
