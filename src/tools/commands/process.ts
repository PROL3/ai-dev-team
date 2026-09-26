import type { SafeCommand, CommandResult, AgentToolContext } from "../types.js";
import { assertFileSize, MAX_READ_BYTES } from "../filesystem/paths.js";
import { validateCommand } from "./policy.js";
import {
  assertNpmScriptIsRunnable,
  NpmValidationError,
  parseNpmScripts,
} from "./npm-validation.js";
import { getSafeNpmInstallArgs } from "./dependency-install-policy.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export const MAX_COMMAND_OUTPUT = 512 * 1024;

export const COMMAND_TIMEOUT_MS = 60_000;

export function normalizeOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_COMMAND_OUTPUT) {
    return value;
  }

  return value.slice(0, MAX_COMMAND_OUTPUT) + "\n\n[OUTPUT TRUNCATED]";
}

export async function resolveWindowsNpmCli(command: "npm" | "npx"): Promise<string> {
  const cliName = `${command}-cli.js`;
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    ...(npmExecPath && /[\\/]npm-cli\.js$/i.test(npmExecPath)
      ? [path.join(path.dirname(npmExecPath), cliName)]
      : []),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", cliName),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((directory) => path.isAbsolute(directory))
      .map((directory) => path.join(directory, "node_modules", "npm", "bin", cliName)),
  ];

  for (const candidate of new Set(candidates)) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next installed npm location; never download or install tools.
    }
  }

  throw Object.assign(new Error(`Cannot locate the installed ${command} CLI.`), {
    code: "ENOENT",
  });
}

export function getCommandEnvironment(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  return environment;
}

export async function runCommand(
  context: AgentToolContext,
  command: SafeCommand,
): Promise<CommandResult> {
  validateCommand(command);

  try {
    let npmArgs = command.args;
    if (command.command === "npm") {
      const manifest = path.join(context.workspacePath, "package.json");
      let content: string;
      try {
        await assertFileSize(manifest, MAX_READ_BYTES);
        content = await fs.readFile(manifest, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw new NpmValidationError(
            "No package.json exists in this workspace; refusing to run a parent project's npm script.",
          );
        }
        throw error;
      }
      if (command.args[0] === "install") {
        npmArgs = getSafeNpmInstallArgs(content);
      } else {
        assertNpmScriptIsRunnable(
          parseNpmScripts(content),
          command.args[0] === "test" ? "test" : command.args[1]!,
        );
      }
    }
    // Windows cannot exec a .cmd shim with shell:false (spawn EINVAL).
    // Execute the installed JS CLI directly, keeping arguments out of a shell.
    const useNpmCli =
      process.platform === "win32" && (command.command === "npm" || command.command === "npx");
    const executable = useNpmCli || command.command === "node" ? process.execPath : command.command;
    const args = useNpmCli
      ? [await resolveWindowsNpmCli(command.command as "npm" | "npx"), ...npmArgs]
      : npmArgs;
    const result = await execFileAsync(executable, args, {
      cwd: context.workspacePath,
      env: getCommandEnvironment(),
      windowsHide: true,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT,
    });

    return {
      stdout: normalizeOutput(result.stdout ?? ""),
      stderr: normalizeOutput(result.stderr ?? ""),
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof NpmValidationError) {
      return { stdout: "", stderr: error.message, exitCode: 1, validationError: error.message };
    }
    const typedError = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const message = error instanceof Error ? error.message : String(error);

    const exitCode = typeof typedError.code === "number" ? typedError.code : 1;

    return {
      stdout: normalizeOutput(typeof typedError.stdout === "string" ? typedError.stdout : ""),
      stderr: normalizeOutput(
        typeof typedError.stderr === "string" && typedError.stderr ? typedError.stderr : message,
      ),
      exitCode,
      ...(typeof typedError.code !== "number" || typedError.signal || typedError.killed
        ? {
            executionError: {
              code: typeof typedError.code === "string" ? typedError.code : "COMMAND_INTERRUPTED",
              message,
            },
          }
        : {}),
    };
  }
}
