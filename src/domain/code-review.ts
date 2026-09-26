import { z } from "zod";

export const reviewFindingSchema = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.enum(["correctness", "security", "architecture", "reliability", "tests"]),
  title: z.string().trim().min(1).max(160),
  file: z.string().min(1).max(500),
  side: z.enum(["before", "after"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  evidence: z.string().trim().min(1).max(2_000),
  scenario: z.string().trim().min(1).max(2_000),
  impact: z.string().trim().min(1).max(2_000),
  suggestedFix: z.string().trim().min(1).max(2_000),
}).strict().refine((finding) =>
  finding.endLine >= finding.startLine && finding.endLine - finding.startLine < 10,
  { message: "Findings must cite a range of 1–10 lines." },
);

/** The model supplies evidence, never its own approval decision or file inventory. */
export const codeReviewResponseSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  findings: z.array(reviewFindingSchema).max(30),
  limitations: z.array(z.string().trim().min(1).max(1_000)).max(30),
}).strict();

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type CodeReviewResponse = z.infer<typeof codeReviewResponseSchema>;

export function reviewStatus(findings: readonly ReviewFinding[], limitations: readonly string[]) {
  if (findings.some((finding) => finding.priority !== "P3")) return "changes_requested" as const;
  return limitations.length ? "inconclusive" as const : "approved" as const;
}

export const codeReviewResultSchema = codeReviewResponseSchema.extend({
  status: z.enum(["approved", "changes_requested", "inconclusive"]),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  reviewedFiles: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (result.status !== reviewStatus(result.findings, result.limitations)) {
    context.addIssue({ code: "custom", message: "Review status contradicts its findings or limitations." });
  }
  if (result.status === "approved" && result.reviewedFiles.length === 0) {
    context.addIssue({ code: "custom", message: "Approval requires inspected changes." });
  }
  for (const finding of result.findings) {
    if (!result.reviewedFiles.includes(finding.file)) {
      context.addIssue({ code: "custom", message: "Finding refers to an unreviewed file." });
    }
  }
});

export type CodeReviewResult = z.infer<typeof codeReviewResultSchema>;
