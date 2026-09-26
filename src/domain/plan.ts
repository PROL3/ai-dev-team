import { z } from "zod";

export const architectureContractSchema = z.object({
  runtime: z.string().min(1),
  storage: z.string().min(1),
  apiBasePath: z.string().min(1),
  frontend: z.string().min(1),
  fileLayout: z.array(z.string().min(1)).min(1),
  testCommand: z.string().min(1),
});

export const planTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),

  owner: z.enum(["backend", "frontend", "tester"]),

  dependencies: z.array(z.string()),
  files: z.array(z.string().min(1)).optional(),
  architecture: architectureContractSchema.optional(),
});

export const projectPlanSchema = z.object({
  goal: z.string().min(1),
  architecture: architectureContractSchema.optional(),
  tasks: z.array(planTaskSchema),
});

export type ArchitectureContract = z.infer<typeof architectureContractSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type ProjectPlan = z.infer<typeof projectPlanSchema>;

/**
 * Validates the logical dependency graph of a project plan.
 *
 * This runs after Zod validates the structure itself.
 */
export function validateProjectPlan(plan: ProjectPlan): ProjectPlan {
  const taskIds = new Set<string>();

  // 1. Check duplicate task IDs
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate task ID detected: ${task.id}`);
    }

    taskIds.add(task.id);
  }

  // 2. Check dependencies
  for (const task of plan.tasks) {
    for (const dependencyId of task.dependencies) {
      // Dependency must exist
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependencyId}`);
      }

      // Task cannot depend on itself
      if (dependencyId === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
    }
  }

  // 3. Detect circular dependencies
  detectCycles(plan);

  return plan;
}

/**
 * Ensures agent-generated implementation plans establish one shared contract
 * before any specialized task can begin. This is intentionally invoked by the
 * planner, rather than generic graph validation, so small unit-test plans can
 * still validate their dependency behavior independently.
 */
export function validateFoundationTask(plan: ProjectPlan): ProjectPlan {
  validateFoundationRoot(plan);

  for (const task of plan.tasks.slice(1)) {
    if (!task.dependencies.includes("foundation")) {
      throw new Error(`Task ${task.id} must directly depend on the foundation task`);
    }
  }

  return plan;
}

/** Checks the foundation itself without requiring edges we can safely supply. */
function validateFoundationRoot(plan: ProjectPlan): void {
  if (!plan.architecture) {
    throw new Error("Implementation plan must include a shared architecture contract");
  }

  const foundation = plan.tasks[0];

  if (!foundation) {
    throw new Error("Implementation plan must include a foundation task");
  }

  if (
    foundation.id !== "foundation" ||
    foundation.owner !== "backend" ||
    foundation.dependencies.length !== 0
  ) {
    throw new Error(
      'The first task must be a backend foundation task with id "foundation" and no dependencies',
    );
  }
}

/**
 * Complete the mandatory foundation edges in a schema-checked planner result.
 * Preserve task order and every existing edge; never invent tasks or remove
 * invalid references. Both the supplied graph and the final graph must be valid.
 * This is intentionally separate from validation used by generic DAG callers.
 */
export function normalizeFoundationDependencies(plan: ProjectPlan): ProjectPlan {
  validateFoundationRoot(plan);
  validateProjectPlan(plan);

  let changed = false;
  const tasks = plan.tasks.map((task, index) => {
    if (index === 0) return task;

    const dependencies = [...new Set(task.dependencies)];
    if (!dependencies.includes("foundation")) dependencies.unshift("foundation");

    if (
      dependencies.length === task.dependencies.length &&
      dependencies.every((dependency, index) => dependency === task.dependencies[index])
    ) {
      return task;
    }

    changed = true;
    return { ...task, dependencies };
  });

  const normalized = changed ? { ...plan, tasks } : plan;
  return validateFoundationTask(validateProjectPlan(normalized));
}

/**
 * Detects cycles in the task dependency graph.
 */
function detectCycles(plan: ProjectPlan): void {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string): void {
    // Already completely processed
    if (visited.has(taskId)) {
      return;
    }

    // We reached a node that is currently being explored.
    // Therefore we found a cycle.
    if (visiting.has(taskId)) {
      throw new Error(`Circular dependency detected involving task ${taskId}`);
    }

    const task = tasks.get(taskId);

    if (!task) {
      return;
    }

    visiting.add(taskId);

    for (const dependencyId of task.dependencies) {
      visit(dependencyId);
    }

    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of plan.tasks) {
    visit(task.id);
  }
}
