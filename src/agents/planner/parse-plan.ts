import { orderSharedOwnership } from "../../domain/task-ownership.js";
import {
  projectPlanSchema,
  normalizeFoundationDependencies,
  validateProjectPlan,
  type ProjectPlan,
} from "../../domain/plan.js";

export function parsePlan(rawResult: string): ProjectPlan {
  let cleanedResult = rawResult.trim();

  // Preserve support for models that wrap JSON in Markdown fences.
  if (cleanedResult.startsWith("```")) {
    cleanedResult = cleanedResult.replace(/^```(?:json)?\s*/i, "");
    cleanedResult = cleanedResult.replace(/\s*```$/i, "");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleanedResult);
  } catch {
    throw new Error("Planner returned invalid JSON. Return one complete JSON object.");
  }

  const result = projectPlanSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`);
    throw new Error(`Planner returned invalid plan: ${issues.join("; ")}`);
  }

  const normalized = normalizeFoundationDependencies(result.data);
  if (normalized !== result.data) {
    console.log(
      `[planner-log] ${JSON.stringify({
        status: "normalized",
        addedFoundationDependencies: result.data.tasks
          .filter((task) => task.id !== "foundation" && !task.dependencies.includes("foundation"))
          .map((task) => task.id),
        deduplicatedDependencies: result.data.tasks
          .filter((task) => new Set(task.dependencies).size !== task.dependencies.length)
          .map((task) => task.id),
      })}`,
    );
  }
  return validateProjectPlan(orderSharedOwnership(normalized));
}
