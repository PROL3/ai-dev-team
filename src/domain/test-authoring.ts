import { z } from "zod";
import { createHash } from "node:crypto";
import type { PlanTask } from "./plan.js";
import { taskTestDirectory } from "./task-test-scope.js";
import { ownedPathsOverlap } from "./task-ownership.js";

export const testAuthorResponseSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  content: z.string().trim().min(1).max(16_000),
}).strict();
export type TestAuthorResponse = z.infer<typeof testAuthorResponseSchema>;

export const testerTestArtifactSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1).max(16_000),
  command: z.object({ command: z.literal("node"), args: z.array(z.string()).min(2) }).strict(),
}).strict();
export type TesterTestArtifact = z.infer<typeof testerTestArtifactSchema>;

/** Git may convert LF/CRLF on checkout; that does not change an assertion. */
export function sameTestContent(actual: string, expected: string): boolean {
  return actual.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n");
}

/** Stable task-specific directory, also writable by this task's existing scope. */
export function testerTestDirectory(task: PlanTask, tasks: readonly PlanTask[]): string {
  const assigned = taskTestDirectory(task, tasks);
  if (assigned) return assigned;
  const suffix = createHash("sha256").update(task.id).digest("hex").slice(0, 16);
  for (const owned of task.files ?? []) {
    if (!/[\\/]$/.test(owned)) continue;
    const directory = `${owned.replaceAll("\\", "/").replace(/\/$/, "")}/__tests__/tester-${suffix}`;
    if (!tasks.some((other) => other.id !== task.id &&
      (!other.files?.length || other.files.some((file) => ownedPathsOverlap(file, directory))))) return directory;
  }
  throw new Error("No unshared test directory is available in this task's scope.");
}
