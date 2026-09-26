import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolContext } from "../types.js";

export const MAX_READ_BYTES = 1024 * 1024;

export const MAX_WRITE_BYTES = 1024 * 1024;

export async function resolveInsideWorkspace(
  workspacePath: string,
  requestedPath: string,
  allowSrcFallback = false,
): Promise<string> {
  if (!requestedPath || requestedPath.trim() === "") {
    throw new Error("Path cannot be empty");
  }

  const workspace = path.resolve(workspacePath);
  const target = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspace, requestedPath);

  if (allowSrcFallback && !path.isAbsolute(requestedPath) && !(await pathExists(target))) {
    const srcTarget = path.resolve(workspace, "src", requestedPath);

    if (await pathExists(srcTarget)) {
      return srcTarget;
    }
  }

  const relative = path.relative(workspace, target);

  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return target;
  }

  throw new Error(`Path escapes workspace: ${requestedPath}`);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function assertCanWrite(context: AgentToolContext): void {
  if (context.role === "tester" && !context.allowedPaths?.length) {
    throw new Error(
      "Tester agent is read-only unless the task explicitly lists its writable test files",
    );
  }
}

export function normalizeRelativePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, "");
}

export class WriteScopeError extends Error {
  constructor(requestedPath: string, allowedPaths: readonly string[]) {
    super(
      `${requestedPath} is NOT in your allowed files list (${allowedPaths.join(", ")}). ` +
        "Write path is outside this task's planned files. " +
        "Do NOT attempt to write or fix this file. Focus only on your assigned files. " +
        "Do not use another tool or an alternative path to bypass this restriction.",
    );
    this.name = "WriteScopeError";
  }
}

export function assertAllowedPath(requestedPath: string, allowedPaths?: string[]): void {
  if (!allowedPaths || allowedPaths.length === 0) {
    return;
  }

  const requested = normalizeRelativePath(requestedPath);
  const allowed = allowedPaths.map(normalizeRelativePath);
  const isAllowed = allowed.some(
    (candidate) => candidate === requested || requested.startsWith(`${candidate}/`),
  );

  if (!isAllowed) {
    throw new WriteScopeError(requestedPath, allowedPaths);
  }
}

export function assertWriteSize(content: string): void {
  const size = Buffer.byteLength(content, "utf8");

  if (size > MAX_WRITE_BYTES) {
    throw new Error(`File is too large to write. Maximum size is ${MAX_WRITE_BYTES} bytes.`);
  }
}

export async function assertFileSize(filePath: string, maxBytes: number): Promise<void> {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${filePath}`);
  }

  if (stats.size > maxBytes) {
    throw new Error(`File is too large to read. Maximum size is ${maxBytes} bytes.`);
  }
}
