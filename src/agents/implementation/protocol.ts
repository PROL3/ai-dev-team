import { z } from "zod";

export const actionProtocol = `Return one JSON object with an action and its required fields:
list_files: action="list_files"; optional path (directory string, defaults to workspace root).
read_file: action="read_file"; path (an existing file from repository observations).
write_file: action="write_file"; path (a file within writable scope); content (complete raw file contents).
run_command: action="run_command"; command (one of npm, npx, node, git); args (array of argument strings, based on actual project tools).
diagnose: action="diagnose"; category (implementation, dependency, configuration, environment, unknown); hypothesis (specific suspected cause); evidence (1-5 actual observations); nextStep (concrete check or edit).
done: action="done"; summary (what was implemented and actually verified).
No example values are file paths. Select paths from the workspace observations; new file paths must be inside the task's write scope.`;

export const diagnosisPlaceholders = new Set([
  "cause",
  "cause supported by evidence",
  "observed fact",
  "observed facts",
  "specific check or fix",
  "hypothesis",
  "evidence",
  "next step",
  "diagnosis",
  "string",
  "todo",
  "tbd",
  "...",
]);

export const diagnosisText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !diagnosisPlaceholders.has(
          value
            .toLowerCase()
            .replace(/[.!?]+$/, "")
            .trim(),
        ) && value !== "...",
      "Placeholder diagnosis is not an observation. Describe the specific failure and cite actual tool output or file contents; use read_file or run_command to gather evidence if needed.",
    );

export const agentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read_file"),
    path: z.string().min(1),
  }),

  z.object({
    action: z.literal("write_file"),
    path: z.string().min(1),
    content: z.string(),
  }),

  z.object({
    action: z.literal("list_files"),
    path: z.string().optional(),
  }),

  z.object({
    action: z.literal("run_command"),
    command: z.enum(["npm", "npx", "node", "git"]),
    args: z.array(z.string()),
  }),

  z.object({
    action: z.literal("done"),
    summary: z.string().min(1),
  }),

  z
    .object({
      action: z.literal("diagnose"),
      category: z.enum(["implementation", "dependency", "configuration", "environment", "unknown"]),
      hypothesis: diagnosisText(1200),
      evidence: z.array(diagnosisText(800)).min(1).max(5),
      nextStep: diagnosisText(1200),
    })
    .strict(),
]);

export type AgentAction = z.infer<typeof agentActionSchema>;

export function cleanModelOutput(output: string): string {
  let cleaned = output.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");

    cleaned = cleaned.replace(/\s*```$/, "");
  }

  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (firstObject >= 0 && lastObject > firstObject) {
    return cleaned.slice(firstObject, lastObject + 1).trim();
  }

  return cleaned.trim();
}

export function repairJsonProtocol(output: string): string {
  let repaired = output.trim();

  repaired = repaired.replace(
    /("(?:content|summary)"\s*:\s*)`([\s\S]*?)`/g,
    (_match, prefix: string, value: string) => `${prefix}${JSON.stringify(value)}`,
  );

  let result = "";
  let inString = false;
  let escaped = false;

  for (const character of repaired) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && inString) {
      result += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      result += character;
      continue;
    }

    if (inString) {
      if (character === "\n") {
        result += "\\n";
        continue;
      }

      if (character === "\r") {
        result += "\\r";
        continue;
      }

      if (character === "\t") {
        result += "\\t";
        continue;
      }
    }

    result += character;
  }

  return result;
}

export const recoveryDecisionSchema = z
  .object({
    diagnosis: diagnosisText(1200),
    evidence: z.array(diagnosisText(800)).min(1).max(5),
    nextAction: agentActionSchema,
  })
  .strict();
