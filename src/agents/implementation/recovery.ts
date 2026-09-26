import path from "node:path";
import type { ToolAuditEntry, ValidationRecovery } from "./types.js";
import { excerpt } from "./formatting.js";

export function getUnresolvedCommandFailure(
  audit: ToolAuditEntry[],
  command?: string,
): ToolAuditEntry | undefined {
  const seen = new Set<string>();
  for (const entry of [...audit].reverse()) {
    if (entry.action !== "run_command") continue;
    if (command !== undefined && entry.command !== command) continue;
    const key = entry.command ?? JSON.stringify(entry.input);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!entry.success) return entry;
  }
  return undefined;
}

export function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function getReferencedTestFiles(output: string): string[] {
  // Command audit entries contain JSON; decode it before matching Windows paths.
  try {
    const result: unknown = JSON.parse(output);
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      output = [record.stdout, record.stderr].filter((part) => typeof part === "string").join("\n");
    }
  } catch {
    /* Tool exceptions may be plain text. */
  }
  const files = new Set<string>();
  const pattern =
    /(?:test\s+at|at)\s+((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json))/gi;

  for (const match of output.matchAll(pattern)) {
    const candidate = normalizeWorkspacePath(match[1]!);
    if (candidate.split("/").includes("..") || path.isAbsolute(candidate)) continue;
    files.add(candidate);
  }

  return [...files];
}

export function getValidationRecovery(
  audit: ToolAuditEntry[],
  command?: string,
): ValidationRecovery | undefined {
  const failure = getUnresolvedCommandFailure(audit, command);
  if (!failure) return undefined;

  const failureIndex = audit.lastIndexOf(failure);
  const repairMade = audit
    .slice(failureIndex + 1)
    .some(
      (entry) =>
        entry.success &&
        ((entry.action === "write_file" && entry.progress) ||
          (entry.action === "run_command" && entry.command === "npm install")),
    );
  const priorChangedFiles = audit.slice(0, failureIndex + 1).flatMap((entry) => entry.changedFiles);

  let executionError = false;
  try {
    const result: unknown = JSON.parse(failure.output);
    executionError = !!result && typeof result === "object" && "executionError" in result;
  } catch {
    /* Unknown failures require investigation. */
  }

  return {
    step: failure.step,
    command: failure.command ?? "the failed validation command",
    output: excerpt(failure.output, 6000),
    changedFiles: [...new Set(priorChangedFiles)],
    referencedTestFiles: getReferencedTestFiles(failure.output),
    state: repairMade ? "rerun_required" : "repair_required",
    executionError,
  };
}

export const scopePath = (value: string) =>
  path.posix.normalize(value.replaceAll("\\", "/")).toLowerCase();

export function scopeFailures(audit: ToolAuditEntry[]): ToolAuditEntry[] {
  return audit.filter(
    (entry) =>
      entry.action === "write_file" &&
      !entry.success &&
      entry.path &&
      entry.output.startsWith("WRITE_FILE_FAILED:") &&
      entry.output.includes("outside this task's planned files"),
  );
}

export function scopeRecovery(audit: ToolAuditEntry[]): ToolAuditEntry | undefined {
  const failures = scopeFailures(audit);
  const latest = failures.at(-1);
  if (
    !latest ||
    failures.filter((entry) => scopePath(entry.path!) === scopePath(latest.path!)).length < 2
  )
    return undefined;
  const resolved = audit.some(
    (entry) => entry.action === "scope_recovery_decision" && entry.step > latest.step,
  );
  return resolved ? undefined : latest;
}
