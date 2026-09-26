import path from "node:path";
import type { PlanTask, ProjectPlan } from "./plan.js";

export function normalizeOwnedPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, "").toLowerCase();
}
export function ownedPathsOverlap(left: string, right: string): boolean {
  const a = normalizeOwnedPath(left),
    b = normalizeOwnedPath(right);
  return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function tasksOverlap(left: PlanTask, right: PlanTask): boolean {
  // Legacy tasks with no explicit scope cannot safely run alongside another task.
  return (
    !left.files?.length ||
    !right.files?.length ||
    left.files.some((a) => right.files!.some((b) => ownedPathsOverlap(a, b)))
  );
}

/** Preserve existing graph direction, adding ordering only for shared ownership. */
export function orderSharedOwnership(plan: ProjectPlan): ProjectPlan {
  const tasks = plan.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
  function dependsOn(task: PlanTask, id: string, visited = new Set<string>()): boolean {
    if (visited.has(task.id)) return false;
    visited.add(task.id);
    return task.dependencies.some(
      (dependency) =>
        dependency === id ||
        tasks.some((parent) => parent.id === dependency && dependsOn(parent, id, visited)),
    );
  }
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const left = tasks[i]!,
        right = tasks[j]!;
      if (!left.files?.length || !right.files?.length || !tasksOverlap(left, right)) continue;
      if (!dependsOn(left, right.id) && !dependsOn(right, left.id))
        right.dependencies.push(left.id);
    }
  }
  return { ...plan, tasks };
}
