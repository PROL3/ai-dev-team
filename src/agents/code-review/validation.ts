import { codeReviewResponseSchema, type CodeReviewResponse } from "../../domain/code-review.js";
import type { ReviewSnapshot } from "../../infrastructure/git/review-snapshot.js";

export function validateReviewResponse(raw: string, snapshot: ReviewSnapshot): CodeReviewResponse {
  // Parse the whole response: trailing prose, fences and unknown fields are protocol errors.
  const response = codeReviewResponseSchema.parse(JSON.parse(raw));
  const unique = new Set<string>();
  for (const finding of response.findings) {
    const file = snapshot.files.find((file) => file.path === finding.file);
    if (!file) throw new Error("Finding cites an uninspected changed file.");
    const lines = file[finding.side].split("\n");
    if (finding.endLine > lines.length || !file.ranges.some((range) =>
      range.side === finding.side && range.start <= finding.endLine && range.end >= finding.startLine,
    )) throw new Error("Finding is outside the inspected diff.");
    const excerpt = lines.slice(finding.startLine - 1, finding.endLine).join("\n");
    if (!excerpt.includes(finding.evidence)) throw new Error("Finding evidence does not match cited source lines.");
    const key = `${finding.file}:${finding.side}:${finding.startLine}:${finding.endLine}:${finding.title}`;
    if (unique.has(key)) throw new Error("Duplicate finding.");
    unique.add(key);
  }
  return response;
}
