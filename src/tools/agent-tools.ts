import { runCommand } from "./commands/process.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileWriteValidationError, validateFileContent } from "./filesystem/write-validation.js";
import type { AgentToolContext, SafeCommand, CommandResult } from "./types.js";
import {
  MAX_READ_BYTES,
  resolveInsideWorkspace,
  assertCanWrite,
  assertAllowedPath,
  assertWriteSize,
  assertFileSize,
} from "./filesystem/paths.js";

export class AgentTools {
  private readonly context: AgentToolContext;

  constructor(context: AgentToolContext) {
    this.context = {
      ...context,
      workspacePath: path.resolve(context.workspacePath),
    };
  }

  async readFile(relativePath: string): Promise<string> {
    const filePath = await resolveInsideWorkspace(
      this.context.workspacePath,
      relativePath,
      !this.context.exactPaths,
    );

    await assertFileSize(filePath, MAX_READ_BYTES);

    return fs.readFile(filePath, "utf8");
  }

  async writeFile(
    relativePath: string,
    content: string,
  ): Promise<{
    action: "write_file";
    success: true;
    path: string;
    changed: boolean;
    contentChanged: boolean;
    contentHash: string;
    bytes: number;
    verified: boolean;
  }> {
    assertCanWrite(this.context);
    assertAllowedPath(relativePath, this.context.allowedPaths);
    assertWriteSize(content);

    const filePath = await resolveInsideWorkspace(this.context.workspacePath, relativePath);

    const declaredDirectories = [
      ...(this.context.allowedPaths ?? []).filter((entry) => /[\\/]$/.test(entry)),
      ...(this.context.assignedTestDirectory ? [this.context.assignedTestDirectory] : []),
    ].map((entry) => path.resolve(this.context.workspacePath, entry));
    const samePath = (a: string, b: string) =>
      process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (
      /[\\/]$/.test(relativePath) ||
      samePath(filePath, this.context.workspacePath) ||
      declaredDirectories.some((directory) => samePath(directory, filePath))
    ) {
      throw new FileWriteValidationError(
        `${relativePath} is a directory target, not a file. Choose a filename inside it with the project's appropriate extension (for example a .test.cjs or .test.mjs file for Node). write_file creates parent directories automatically. Nothing was written.`,
      );
    }
    validateFileContent(filePath, content);

    // Directory ownership never authorizes following a link into another scope.
    let current = path.resolve(this.context.workspacePath);
    for (const part of path.relative(current, filePath).split(path.sep)) {
      current = path.join(current, part);
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink())
          throw new Error(`Write scope cannot follow a symbolic link: ${relativePath}`);
        if (current === filePath && stats.isDirectory()) {
          throw new FileWriteValidationError(
            `${relativePath} already exists as a directory. Choose a filename inside it; nothing was written.`,
          );
        }
        if (current !== filePath && !stats.isDirectory()) {
          throw new FileWriteValidationError(
            `Cannot write ${relativePath}: parent ${path.relative(this.context.workspacePath, current)} is an existing file, not a directory. Preserve that file and repair the path layout before retrying. Nothing was written.`,
          );
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
    }
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
    });

    try {
      const existingContent = await fs.readFile(filePath, "utf8");

      if (existingContent === content) {
        return {
          action: "write_file",
          success: true,
          path: relativePath,
          changed: false,
          contentChanged: false,
          contentHash: createHash("sha256").update(content).digest("hex"),
          bytes: Buffer.byteLength(content, "utf8"),
          verified: true,
        };
      }
    } catch (error) {
      const code =
        error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;

      if (code !== "ENOENT") {
        throw error;
      }
    }

    await fs.writeFile(filePath, content, "utf8");

    const writtenContent = await fs.readFile(filePath, "utf8");

    if (writtenContent !== content) {
      throw new Error(`Write verification failed: ${relativePath}`);
    }

    return {
      action: "write_file",
      success: true,
      path: relativePath,
      changed: true,
      contentChanged: true,
      contentHash: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content, "utf8"),
      verified: true,
    };
  }

  async listFiles(relativePath = "."): Promise<string[]> {
    const directoryPath = await resolveInsideWorkspace(
      this.context.workspacePath,
      relativePath,
      !this.context.exactPaths,
    );

    const entries = await fs.readdir(directoryPath, {
      withFileTypes: true,
    });

    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  }

  runCommand(command: SafeCommand): Promise<CommandResult> {
    return runCommand(this.context, command);
  }
}

export { WriteScopeError } from "./filesystem/paths.js";
export type { AgentRole, AgentToolContext, CommandResult } from "./types.js";
