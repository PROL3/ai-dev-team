import type { TesterResult } from "../../domain/tester-result.js";

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseTesterJson(raw: string): string {
  let cleaned = raw.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");
    cleaned = cleaned.replace(/\s*```$/i, "");
  }

  if (!cleaned.startsWith("{")) {
    throw new Error("Tester response is not a raw JSON object.");
  }

  const lastBrace = cleaned.lastIndexOf("}");
  if (lastBrace <= 0 || lastBrace !== cleaned.length - 1) {
    throw new Error("Tester response includes trailing non-JSON content.");
  }

  return cleaned;
}

export function validationCommands(
  scripts: Record<string, string>,
): Array<{ label: string; args: string[] }> {
  const selected: Array<{ label: string; args: string[] }> = [];
  // Prefer an available narrow static check, then existing unit/full tests.
  for (const script of ["typecheck", "check", "lint"]) {
    if (scripts[script]) {
      selected.push({ label: `npm run ${script}`, args: ["run", script] });
      break;
    }
  }
  if (scripts["test:unit"])
    selected.push({ label: "npm run test:unit", args: ["run", "test:unit"] });
  else if (scripts.test) selected.push({ label: "npm test", args: ["test"] });
  if (selected.length === 0 && scripts.build)
    selected.push({ label: "npm run build", args: ["run", "build"] });
  return selected;
}

export function invalidResult(summary: string, changedFiles: string[]): TesterResult {
  return {
    passed: false,
    summary,
    testsRun: [],
    failures: [summary],
    warnings: [],
    changedFiles,
    suggestedFixes: ["Return a valid JSON object matching the tester result schema."],
  };
}
