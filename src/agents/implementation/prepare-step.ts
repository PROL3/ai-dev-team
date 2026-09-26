import { withProgress } from "../../infrastructure/logging/progress.js";
import { collectAgentContext, formatAgentContext } from "./workspace-context.js";
import { actionProtocol } from "./protocol.js";
import {
  trimHistory,
  hasWrittenFiles,
  hasInspectedWorkspace,
  hasFailedReadOrList,
  buildWorkingMemory,
} from "./audit.js";
import { getValidationRecovery, scopeFailures, scopeRecovery } from "./recovery.js";
import { excerpt } from "./formatting.js";
import { buildAgentPrompt } from "./prompt.js";
import type { AgentRunState } from "./run-state.js";

export async function prepareStep(state: AgentRunState, step: number) {
  // Await outside model/tool catches: disk failures must stop the workflow,
  // not be mistaken for a model or implementation failure.
  await state.options.onCheckpoint?.({
    nextStep: step,
    budget: state.budget,
    history: state.history,
    audit: state.audit.map((entry) =>
      entry.action === "llm_error" ? { ...entry, input: "[prompt omitted]" } : entry,
    ),
    lastActionKey: state.lastActionKey,
    repeatedActionCount: state.repeatedActionCount,
    noProgressSteps: state.noProgressSteps,
    repeatedInvalidActions: [...state.repeatedInvalidActions],
    failedActionAttempts: [...state.failedActionAttempts],
    validationRecoveryBlocks: [...state.validationRecoveryBlocks],
    successfulWrites: [...state.successfulWrites],
    observedEvidence: [...state.observedEvidence],
  });
  // Observe before deciding, including on resume. Preparation consumes no model
  // step and never resets retry counters or grants additional permissions.
  if (state.contextDirty) {
    state.workspaceContext = await withProgress(
      "agent.context",
      { taskId: state.task.id, step },
      () =>
        collectAgentContext(
          state.workspacePath,
          state.task,
          state.context?.assignedTestDirectory,
          state.audit.flatMap((entry) => (entry.path ? [entry.path] : [])).slice(-8),
        ),
      {
        details: (snapshot) => ({
          entries: snapshot.entries.length,
          files: snapshot.files.length,
          warnings: snapshot.warnings.length,
          truncated: snapshot.truncated,
        }),
      },
    );
    state.contextDirty = false;
  }
  if (step > state.budget.softMaxSteps) {
    state.softLimitReached = true;
  }

  const validationRecoveryForPrompt = getValidationRecovery(state.audit);
  const executionState = {
    step,
    repeatedActionCount: state.repeatedActionCount,
    noProgressSteps: state.noProgressSteps,
    wroteFiles: hasWrittenFiles(state.audit),
    inspectedWorkspace: state.workspaceContext?.rootReadable || hasInspectedWorkspace(state.audit),
    failedReadOrList: hasFailedReadOrList(state.audit),
    successfulWrites: [...state.successfulWrites].map(([path, contentHash]) => ({
      path,
      contentHash,
    })),
    ...(validationRecoveryForPrompt ? { validationRecovery: validationRecoveryForPrompt } : {}),
  };

  const recovery = scopeRecovery(state.audit);
  const normalPrompt = buildAgentPrompt(
    state.task,
    state.task.owner,
    state.workspacePath,
    trimHistory(
      `${buildWorkingMemory(state.audit)}\nLATEST TOOL FEEDBACK:\n${excerpt(state.history, 6000)}`,
    ) +
      (state.resumed && step === state.resumed.nextStep
        ? "\nRESUMED RUN: the process was interrupted. An action after the last checkpoint may have taken effect. Inspect actual files before repeating writes or commands. Preserve prior progress and the remaining step budget."
        : ""),
    state.budget,
    state.softLimitReached,
    executionState,
    state.context,
    state.workspaceContext,
  );
  // Replace the long general action prompt during recovery, not another warning
  // buried inside it. All selected actions still pass normal tool validation.
  const prompt = recovery
    ? `RECOVERY DECISION REQUIRED
You are the ${state.task.owner} implementation agent, not the Planner or Tester.
Task: ${state.task.id}: ${state.task.title}
Requirement: ${state.task.description}
Architecture: ${JSON.stringify(state.task.architecture ?? {})}
Workspace: ${state.workspacePath}
Writable planned paths: ${JSON.stringify(state.task.files ?? [])}
Additional test directory: ${state.context?.assignedTestDirectory ?? "none"}
Previous tester feedback: ${JSON.stringify(state.context?.previousTesterResult ?? null)}
Blocked paths: ${JSON.stringify([...new Set(scopeFailures(state.audit).map((entry) => entry.path))])}
The rejected write was NOT executed. Do not repeat it or expand your own permissions.
Actual tool evidence:
${buildWorkingMemory(state.audit)}
${state.workspaceContext ? formatAgentContext(state.workspaceContext) : ""}
Choose one next action that advances the requirement. If a test was already created in the authorized directory, inspect that actual file and package.json, then repair its code or script and run it. Do not create another duplicate test. Use the project's installed runner; a Node test needs explicit imports and HTTP tests need a real server URL.
If no authorized test exists, inspect the source/setup and create one only under an authorized path. Do not invent existing files or claim success.
Return ONLY a JSON object with exactly three fields: diagnosis (a specific cause supported by the tool output), evidence (1-5 actual observations), and nextAction (one action object below). Copied placeholder text is rejected.
Use the same action fields for nextAction:
${actionProtocol}
No done or diagnose action is allowed in this recovery decision. Choose an actual investigative or corrective action. This does not increase your remaining step budget.`
    : normalPrompt;

  return { prompt, recovery };
}
