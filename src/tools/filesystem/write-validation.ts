import path from "node:path";
import { parseNpmScripts } from "../commands/npm-validation.js";

export class FileWriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileWriteValidationError";
  }
}

/** Validate the payload before touching disk. Never silently strip or rewrite it. */
export function validateFileContent(filePath: string, content: string): void {
  const name = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();
  const sourceFile = [
    ".js",
    ".cjs",
    ".mjs",
    ".jsx",
    ".ts",
    ".tsx",
    ".cts",
    ".mts",
    ".json",
    ".jsonc",
  ].includes(extension);
  if (sourceFile && /^\s*(?:`{3,}|~{3,})/.test(content)) {
    throw new FileWriteValidationError(
      `Content for ${name} starts with a Markdown code fence. Send only raw file contents, without opening/closing fences. Nothing was written; the previous file is unchanged.`,
    );
  }
  // Other JSON-like configuration files may intentionally use JSONC. package.json
  // has strict JSON semantics; reuse the existing object/scripts validator.
  if (name === "package.json") {
    try {
      parseNpmScripts(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FileWriteValidationError(
        `Invalid package.json content: ${message} Send a valid JSON object with valid script strings, not Markdown or prose. Nothing was written; the previous file is unchanged.`,
      );
    }
  }
}
