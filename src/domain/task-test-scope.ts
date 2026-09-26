import { createHash } from "node:crypto";
import type { PlanTask } from "./plan.js";
import { ownedPathsOverlap } from "./task-ownership.js";

/** Derived from the entire plan, not a path chosen by the model. Stable on resume. */
export function taskTestDirectory(task: PlanTask, tasks: readonly PlanTask[]): string | undefined {
  if (
    task.owner === "tester" ||
    !task.files?.length ||
    !tasks.some((other) => other.id === task.id)
  )
    return undefined;
  const slug = task.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  const digest = createHash("sha256").update(task.id).digest("hex");
  const directory = `tests/agent/${slug}-${digest}`;
  // Any other planned owner (including future/completed tasks) takes precedence.
  if (
    tasks.some(
      (other) =>
        other.id !== task.id &&
        (!other.files?.length || other.files.some((file) => ownedPathsOverlap(file, directory))),
    )
  )
    return undefined;
  return directory;
}
