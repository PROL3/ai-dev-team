import { z } from "zod";
import { planTaskSchema, projectPlanSchema, validateProjectPlan } from "./plan.js";
import { testerResultSchema } from "./tester-result.js";
import { codeReviewResultSchema } from "./code-review.js";
import { testerTestArtifactSchema } from "./test-authoring.js";

const count = z.number().int().nonnegative();
const counters = z.array(z.tuple([z.string(), count]));
export const agentSessionSchema = z
  .object({
    nextStep: z.number().int().positive(),
    budget: z
      .object({
        softMaxSteps: z.number().int().positive(),
        hardMaxSteps: z.number().int().positive(),
      })
      .strict(),
    history: z.string(),
    audit: z.array(
      z
        .object({
          step: count,
          action: z.string(),
          input: z.unknown(),
          output: z.string(),
          success: z.boolean(),
          progress: z.boolean(),
          changedFiles: z.array(z.string()),
          testResults: z.array(z.string()),
          path: z.string().optional(),
          command: z.string().optional(),
        })
        .strict(),
    ),
    lastActionKey: z.string(),
    repeatedActionCount: count,
    noProgressSteps: count,
    repeatedInvalidActions: counters,
    failedActionAttempts: counters,
    validationRecoveryBlocks: counters,
    successfulWrites: z.array(z.tuple([z.string(), z.string()])),
    observedEvidence: z.array(z.string()),
  })
  .strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;

const feedback = z
  .object({
    passed: z.boolean(),
    summary: z.string(),
    failures: z.array(z.string()),
    suggestedFixes: z.array(z.string()),
  })
  .strict();
const scheduledTaskSchema = planTaskSchema
  .extend({
    status: z.enum(["pending", "running", "integration_conflict", "completed", "failed"]),
    attempts: count,
    maxAttempts: z.number().int().positive(),
    integrationAttempts: count,
    testerAttempts: count,
    testerMaxAttempts: z.number().int().positive(),
    reviewAttempts: count.default(0),
    reviewMaxAttempts: z.number().int().positive().default(4),
    previousReview: codeReviewResultSchema.optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    previousChangedFiles: z.array(z.string()).optional(),
    workspacePath: z.string().optional(),
    branchName: z.string().optional(),
    baseCommit: z.string().optional(),
    commitHash: z.string().optional(),
    previousTesterResult: feedback.optional(),
    integrationError: z.string().optional(),
    conflictFiles: z.array(z.string()),
    failureType: z.enum(["agent", "validation", "integration", "test", "review"]).optional(),
  })
  .strict();
export const agentResultSchema = z
  .object({
    taskId: z.string(),
    owner: z.enum(["backend", "frontend", "tester"]),
    success: z.boolean(),
    output: z.string(),
    error: z.string().optional(),
    changedFiles: z.array(z.string()),
    failureType: z.enum(["agent", "validation", "integration", "test", "review"]).optional(),
  })
  .strict();
export const taskCheckpointSchema = z
  .object({
    task: scheduledTaskSchema,
    phase: z.enum([
      "settled",
      "implementing",
      "agent_finished",
      "authoring_tests",
      "integrating",
      "integrated",
      "reviewing",
      "reviewed",
      "testing",
      "tested",
    ]),
    result: agentResultSchema.optional(),
    session: agentSessionSchema.optional(),
    previousError: z.string().optional(),
    testerResult: testerResultSchema.optional(),
    testerCommit: z.string().optional(),
    reviewResult: codeReviewResultSchema.optional(),
    workspaceHead: z.string().optional(),
    integrationBase: z.string().optional(),
    integrationCommit: z.string().optional(),
    reviewBase: z.string().optional(),
    reviewPaths: z.array(z.string()).optional(),
    testerTests: z.array(testerTestArtifactSchema).optional(),
    testDraft: testerTestArtifactSchema.optional(),
    testsPreparedAttempt: count.optional(),
    testAuthorAttempts: count.max(2).optional(),
  })
  .strict();
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;
export const workflowStateSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    projectRoot: z.string().min(1),
    mainCommit: z.string().min(1),
    enableTester: z.boolean(),
    enableCodeReview: z.boolean().default(false),
    enableTestAuthoring: z.boolean().default(false),
    validationOrder: z.literal("test-then-review").optional(),
    plan: projectPlanSchema,
    tasks: z.array(taskCheckpointSchema),
  })
  .strict()
  .superRefine((state, context) => {
    try {
      validateProjectPlan(state.plan);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (state.tasks.length !== state.plan.tasks.length) {
      context.addIssue({ code: "custom", message: "Checkpoint task count does not match plan." });
    }
    for (const [index, record] of state.tasks.entries()) {
      const planned = state.plan.tasks[index];
      if (
        !planned ||
        record.task.id !== planned.id ||
        record.task.owner !== planned.owner ||
        record.task.title !== planned.title ||
        record.task.description !== planned.description ||
        JSON.stringify(record.task.dependencies) !== JSON.stringify(planned.dependencies) ||
        JSON.stringify(record.task.files) !== JSON.stringify(planned.files)
      ) {
        context.addIssue({
          code: "custom",
          message: "Checkpoint tasks do not match the saved plan.",
        });
      }
      if (
        record.result &&
        (record.result.taskId !== record.task.id || record.result.owner !== record.task.owner)
      ) {
        context.addIssue({
          code: "custom",
          message: "Saved agent result belongs to another task.",
        });
      }
      if (
        ["agent_finished", "authoring_tests", "integrating", "integrated", "reviewing", "reviewed", "testing", "tested"].includes(record.phase) &&
        !record.result
      ) {
        context.addIssue({ code: "custom", message: "Checkpoint stage requires an agent result." });
      }
      if (record.phase !== "settled" && record.task.status !== "running") {
        context.addIssue({
          code: "custom",
          message: "Active checkpoint stage requires a running task.",
        });
      }
      if (record.task.status === "running" && record.phase === "settled") {
        context.addIssue({ code: "custom", message: "Running task has no checkpoint stage." });
      }
      if (
        record.task.attempts > record.task.maxAttempts ||
        record.task.testerAttempts > record.task.testerMaxAttempts ||
        record.task.reviewAttempts > record.task.reviewMaxAttempts
      ) {
        context.addIssue({
          code: "custom",
          message: "Checkpoint retry counters exceed their limits.",
        });
      }
      if (
        record.session &&
        (record.session.nextStep > record.session.budget.hardMaxSteps + 1 ||
          record.session.budget.softMaxSteps > record.session.budget.hardMaxSteps)
      ) {
        context.addIssue({ code: "custom", message: "Checkpoint agent budget is inconsistent." });
      }
      if (
        ["authoring_tests", "integrating", "integrated", "reviewing", "reviewed", "testing", "tested"].includes(record.phase) &&
        !record.result?.success
      ) {
        context.addIssue({
          code: "custom",
          message: "Integration/testing stage requires successful implementation.",
        });
      }
      if (
        record.task.status === "completed" &&
        (!record.task.commitHash ||
          (state.enableTester &&
            (!record.testerResult?.passed ||
              record.testerResult.failures.length > 0 ||
              record.testerResult.testsRun.length === 0)))
      ) {
        context.addIssue({
          code: "custom",
          message: "Completed task is missing integration/validation evidence.",
        });
      }
      if (
        (record.task.status === "running" || record.task.status === "completed") &&
        record.task.dependencies.some(
          (id) =>
            state.tasks.find((candidate) => candidate.task.id === id)?.task.status !== "completed",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Active/completed task has incomplete dependencies.",
        });
      }
      if (record.phase === "integrating" && !record.integrationBase) {
        context.addIssue({
          code: "custom",
          message: "Integration checkpoint lacks its original main commit.",
        });
      }
      if (record.phase === "authoring_tests" && !state.enableTestAuthoring) {
        context.addIssue({ code: "custom", message: "Authoring stage requires enabled test authoring." });
      }
      if (state.enableTestAuthoring &&
          (record.task.status === "completed" ||
           ["integrating", "integrated", "testing", "tested", "reviewing", "reviewed"].includes(record.phase)) &&
          (record.testsPreparedAttempt !== record.task.attempts || !record.testerTests?.length)) {
        context.addIssue({ code: "custom", message: "Stage requires prepared Tester tests for this implementation attempt." });
      }
      if (state.enableCodeReview &&
          (record.task.status === "completed" || record.phase === "reviewed" ||
           (!state.validationOrder && record.phase === "testing")) &&
          (record.reviewResult?.status !== "approved" ||
           record.reviewResult.baseCommit !== record.reviewBase ||
           record.reviewResult.headCommit !== record.integrationCommit)) {
        context.addIssue({ code: "custom", message: "Task lacks approval for its integrated revision." });
      }
      if (state.validationOrder && state.enableTester &&
          (record.task.status === "completed" || ["tested", "reviewing", "reviewed"].includes(record.phase)) &&
          (!record.testerResult?.passed || record.testerResult.failures.length > 0 ||
           record.testerResult.testsRun.length === 0 || !record.testerCommit ||
           record.testerCommit !== record.integrationCommit)) {
        context.addIssue({ code: "custom", message: "Stage requires Tester PASS for its integrated revision." });
      }
      if (["reviewing", "reviewed"].includes(record.phase) &&
          (!state.enableCodeReview || !record.reviewBase || !record.integrationBase || !record.integrationCommit)) {
        context.addIssue({ code: "custom", message: "Review stage requires enabled review and integrated revisions." });
      }
    }
  });
export type WorkflowState = z.infer<typeof workflowStateSchema>;
