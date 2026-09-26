import type { AgentRole } from "../../tools/agent-tools.js";
import type { AgentBudget } from "./types.js";

export const ROLE_BUDGETS: Record<AgentRole, AgentBudget> = {
  backend: { softMaxSteps: 24, hardMaxSteps: 40 },
  frontend: { softMaxSteps: 22, hardMaxSteps: 36 },
  tester: { softMaxSteps: 16, hardMaxSteps: 28 },
};

export const MAX_NO_PROGRESS_STEPS = 12;

export const MAX_REPEATED_ACTIONS = 4;

export const MAX_FAILED_ACTION_ATTEMPTS = 3;

export const MAX_HISTORY_CHARS = 30_000;

export function getBudget(role: AgentRole, override?: Partial<AgentBudget>): AgentBudget {
  const defaults = ROLE_BUDGETS[role];

  const softMaxSteps = override?.softMaxSteps ?? defaults.softMaxSteps;
  const hardMaxSteps = override?.hardMaxSteps ?? defaults.hardMaxSteps;

  if (softMaxSteps < 1 || hardMaxSteps < softMaxSteps) {
    throw new Error(
      "Invalid agent execution budget: hardMaxSteps must be " +
        "greater than or equal to softMaxSteps.",
    );
  }

  return {
    softMaxSteps,
    hardMaxSteps,
  };
}
