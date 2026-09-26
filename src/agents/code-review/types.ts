import type { PlanTask } from "../../domain/plan.js";
import type { CodeReviewResult } from "../../domain/code-review.js";

export type CodeReviewRequest = {
  task: PlanTask;
  workspacePath: string;
  baseCommit: string;
  headCommit: string;
  /** Main immediately before this integration; baseCommit retains the task's first review base. */
  integrationBase?: string;
  /** Git-observed task paths retained even when a previous review could not inspect them. */
  reviewPaths?: string[];
  previousAgentSummary: string;
  validation?: { commit: string; summary: string; testsRun: string[] };
  previousReview?: CodeReviewResult;
};

export type CodeReviewOptions = { ask?: (prompt: string) => Promise<string> };
