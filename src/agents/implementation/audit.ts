import { excerpt } from "./formatting.js";
import {
  WorkspaceManager,
  type TaskWorkspace,
} from "../../infrastructure/git/workspace-manager.js";
import type { PlanTask } from "../../domain/plan.js";
import { MAX_HISTORY_CHARS } from "./budget.js";
import { agentActionSchema, type AgentAction } from "./protocol.js";
import type { ToolAuditEntry } from "./types.js";
import { scopeFailures } from "./recovery.js";

export function latestValidDiagnosis(audit: ToolAuditEntry[]): ToolAuditEntry | undefined {
  return [...audit]
    .reverse()
    .find(
      (entry) =>
        entry.action === "diagnose" &&
        entry.success &&
        agentActionSchema.safeParse(entry.input).success,
    );
}

export function getFailureType(audit: ToolAuditEntry[]): "agent" | "validation" {
  return audit.some((entry) => entry.action === "run_command" && !entry.success)
    ? "validation"
    : "agent";
}

export function actionKey(action: AgentAction): string {
  if (action.action === "read_file") {
    return `read_file:${action.path}`;
  }

  if (action.action === "list_files") {
    return `list_files:${action.path ?? "."}`;
  }

  if (action.action === "run_command") {
    return `run_command:${action.command} ${action.args.join(" ")}`;
  }

  if (action.action === "write_file") {
    return `write_file:${action.path}:${action.content}`;
  }

  if (action.action === "diagnose") return `diagnose:${JSON.stringify(action)}`;

  return "done";
}

export function summarizeAudit(audit: ToolAuditEntry[]): string {
  const lastActions = audit.slice(-8).map((entry) => {
    const target = entry.path ?? entry.command ?? "";

    return `${entry.action}${target ? ` ${target}` : ""}`;
  });

  const changedFiles = [...new Set(audit.flatMap((entry) => entry.changedFiles))];

  const lastError = [...audit].reverse().find((entry) => !entry.success)?.output;

  return [
    `Agent failed after ${audit.length} steps.`,
    `Last actions: ${lastActions.join(" -> ") || "none"}`,
    `Changed files: ${changedFiles.join(", ") || "none"}`,
    `Last error: ${excerpt(lastError ?? "none", 4000)}`,
    `Latest diagnosis: ${excerpt(latestValidDiagnosis(audit)?.output ?? "none", 1600)}`,
  ].join("\n");
}

export function trimHistory(history: string): string {
  if (history.length <= MAX_HISTORY_CHARS) {
    return history;
  }

  return "[Earlier history truncated]\n\n" + history.slice(-MAX_HISTORY_CHARS);
}

export function hasWrittenFiles(audit: ToolAuditEntry[]): boolean {
  return audit.some(
    (entry) => entry.action === "write_file" && entry.success && entry.changedFiles.length > 0,
  );
}

export function hasInspectedWorkspace(audit: ToolAuditEntry[]): boolean {
  return audit.some(
    (entry) => (entry.action === "list_files" || entry.action === "read_file") && entry.success,
  );
}

export function hasFailedReadOrList(audit: ToolAuditEntry[]): boolean {
  const latest = [...audit]
    .reverse()
    .find((entry) => entry.action === "read_file" || entry.action === "list_files");
  return latest !== undefined && !latest.success;
}

export async function getChangedFiles(
  workspaceManager: WorkspaceManager,
  workspace: TaskWorkspace,
  audit: ToolAuditEntry[],
): Promise<string[]> {
  const verifiedWrites = audit.flatMap((entry) => entry.changedFiles);

  try {
    return [
      ...new Set([...(await workspaceManager.getChangedFiles(workspace)), ...verifiedWrites]),
    ];
  } catch {
    return [...new Set(verifiedWrites)];
  }
}

export function actionHistory(action: AgentAction): string {
  // Generated source is already on disk and in the audit. Replaying it as the
  // next instruction promotes copying stale writes and crowds out failure evidence.
  return JSON.stringify(
    action.action === "write_file"
      ? {
          action: action.action,
          path: action.path,
          content: "[omitted; inspect the actual file]",
          bytes: Buffer.byteLength(action.content),
        }
      : action,
  );
}

export function buildWorkingMemory(audit: ToolAuditEntry[]): string {
  const entries = audit.filter((entry) => entry.action !== "llm_error").slice(-8);
  const recent = entries
    .map((entry) => {
      const output =
        entry.action === "write_file" && entry.success
          ? `Verified content change: ${entry.progress}`
          : excerpt(entry.output, entry.action === "read_file" ? 4500 : 2000);
      return `STEP ${entry.step}: ${entry.action} ${entry.path ?? entry.command ?? ""}\nSuccess: ${entry.success}\n${output}`;
    })
    .join("\n\n");
  const paths = [
    ...new Set(audit.filter((entry) => entry.success && entry.path).map((entry) => entry.path!)),
  ].slice(-40);
  const diagnosis = latestValidDiagnosis(audit);
  return (
    `Paths observed in prior agent tool calls (see snapshot for automatic inspection): ${paths.join(", ") || "none"}\n` +
    `Blocked write paths (persist across subsequent successful actions): ${[...new Set(scopeFailures(audit).map((entry) => entry.path))].join(", ") || "none"}\n` +
    `Latest scope failure: ${excerpt(scopeFailures(audit).at(-1)?.output ?? "none", 1800)}\n` +
    `Latest diagnosis (hypothesis, not verified fact): ${diagnosis?.output ?? "none"}\n` +
    excerpt(recent, 20000)
  );
}

export function hasCompletedPlannedWrites(task: PlanTask, changedFiles: string[]): boolean {
  if (!task.files || task.files.length === 0) {
    return false;
  }

  const normalize = (value: string): string =>
    value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");

  const normalizedChanges = changedFiles.map(normalize);

  return task.files.every((plannedFile) => {
    const planned = normalize(plannedFile);

    return normalizedChanges.some(
      (changedFile) => changedFile === planned || changedFile.startsWith(`${planned}/`),
    );
  });
}
