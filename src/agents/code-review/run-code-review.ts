import { codeReviewResultSchema, reviewStatus, type CodeReviewResult } from "../../domain/code-review.js";
import { collectReviewSnapshot } from "../../infrastructure/git/review-snapshot.js";
import { askLLM } from "../../infrastructure/llm/gateway.js";
import { withProgress } from "../../infrastructure/logging/progress.js";
import { buildCodeReviewPrompt } from "./prompt.js";
import { validateReviewResponse } from "./validation.js";
import type { CodeReviewRequest, CodeReviewOptions } from "./types.js";

export async function runCodeReview(request: CodeReviewRequest, options: CodeReviewOptions = {}): Promise<CodeReviewResult> {
  const snapshot = await collectReviewSnapshot(request.workspacePath, request.baseCommit, request.headCommit,
    request.integrationBase ? {
      integrationBase: request.integrationBase,
      previousFiles: request.reviewPaths ?? request.previousReview?.reviewedFiles ?? [],
    } : undefined);
  const response = snapshot.files.length
    ? validateReviewResponse(await withProgress("code_review.llm", { taskId: request.task.id }, () =>
        (options.ask ?? askLLM)(buildCodeReviewPrompt(request, snapshot))), snapshot)
    : { summary: "No inspectable changes; review is incomplete.", findings: [], limitations: [] };
  const limitations = [...new Set([...snapshot.limitations, ...response.limitations])].slice(0, 30);
  return codeReviewResultSchema.parse({
    ...response,
    status: reviewStatus(response.findings, limitations),
    limitations,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    reviewedFiles: snapshot.files.map((file) => file.path),
  });
}

export type { CodeReviewRequest, CodeReviewOptions } from "./types.js";
