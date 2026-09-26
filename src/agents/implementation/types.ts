import type { AgentTools } from "../../tools/agent-tools.js";
import type { AgentSession } from "../../domain/workflow-state.js";
import type { CodeReviewResult } from "../../domain/code-review.js";

export type AgentBudget = {
  softMaxSteps: number;
  hardMaxSteps: number;
};

export type ToolAuditEntry = {
  step: number;
  action: string;
  input: unknown;
  output: string;
  success: boolean;
  path?: string;
  command?: string;
  progress: boolean;
  changedFiles: string[];
  testResults: string[];
};

export type AgentRunResult = {
  success: boolean;
  summary: string;
  steps: number;
  audit: ToolAuditEntry[];
  changedFiles: string[];
  failureType?: "agent" | "validation";
};

export type AgentRunnerOptions = {
  ask?: (prompt: string) => Promise<string>;
  tools?: Pick<AgentTools, "readFile" | "writeFile" | "listFiles" | "runCommand">;
  budget?: Partial<AgentBudget>;
  softMaxSteps?: number;
  hardMaxSteps?: number;
  resumeSession?: AgentSession;
  onCheckpoint?: (session: AgentSession) => Promise<void>;
};

export type ActionExecutionResult = {
  exitCode?: number;
  output: string;
  success: boolean;
  progress: boolean;
  changedFiles: string[];
  testResults: string[];
};

export type ValidationRecovery = {
  step: number;
  command: string;
  output: string;
  changedFiles: string[];
  referencedTestFiles: string[];
  state: "repair_required" | "rerun_required";
  executionError: boolean;
};

export type AgentFeedback = {
  testerOwnedTests?: string[];
  previousReview?: CodeReviewResult;
  assignedTestDirectory?: string;
  previousOutput?: string;
  previousError?: string;
  previousChangedFiles?: string[];
  attempt?: number;
  previousTesterResult?: {
    passed: boolean;
    summary: string;
    failures: string[];
    suggestedFixes: string[];
  };
};
