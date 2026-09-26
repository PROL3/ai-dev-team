import { buildTesterPrompt } from "./prompt.js";
import { askLLM } from "../../infrastructure/llm/gateway.js";
import { logProgress, withProgress } from "../../infrastructure/logging/progress.js";
import { AgentTools } from "../../tools/agent-tools.js";
import { testerResultSchema, type TesterResult } from "../../domain/tester-result.js";
import { assertNpmScriptIsRunnable, parseNpmScripts } from "../../tools/commands/npm-validation.js";
import { sameTestContent } from "../../domain/test-authoring.js";
import {
  type TesterRequest,
  type TesterOptions,
  type ValidationRun,
  TesterExecutionError,
} from "./types.js";
import {
  messageFromError,
  parseTesterJson,
  validationCommands,
  invalidResult,
} from "./validation.js";

export async function runTester(
  request: TesterRequest,
  options: TesterOptions = {},
): Promise<TesterResult> {
  const tools =
    options.tools ??
    new AgentTools({
      role: "tester",
      workspacePath: request.workspacePath,
      exactPaths: true,
    });
  const ask = options.ask ?? askLLM;
  const warnings: string[] = [];
  const inspectedFiles: string[] = [];
  const fileContents: Array<{ path: string; content: string }> = [];
  let remainingContent = 24_000;
  const validation: ValidationRun[] = [];
  let rootFiles: string[];
  let packageJson = "";

  const failure = (summary: string, suggestedFixes: string[]): TesterResult => ({
    passed: false,
    summary,
    failures: [summary],
    suggestedFixes,
    testsRun: validation.map((entry) => entry.command),
    changedFiles: request.changedFiles,
    warnings: [...warnings],
  });

  try {
    rootFiles = await withProgress("tester.inspect", { taskId: request.task.id }, () =>
      tools.listFiles("."),
    );
  } catch (error) {
    throw new TesterExecutionError(
      failure(`Tester could not inspect workspace: ${messageFromError(error)}`, [
        "Restore access to the integrated workspace and retry validation.",
      ]),
    );
  }

  const listings = new Map<string, string[]>([[".", rootFiles]]);
  for (const file of request.changedFiles) {
    try {
      const segments = file.replaceAll("\\", "/").split("/");
      if (
        segments.some(
          (segment) => !segment || segment === "." || segment === ".." || segment.includes(":"),
        )
      ) {
        throw new Error("Changed path is not a workspace-relative file path.");
      }
      let directory = ".";
      for (const [index, segment] of segments.entries()) {
        let entries = listings.get(directory);
        if (!entries) {
          entries = await tools.listFiles(directory);
          listings.set(directory, entries);
        }
        const isDirectory = index < segments.length - 1;
        if (!entries.includes(isDirectory ? `${segment}/` : segment)) {
          throw new Error(
            "Path is absent from the integrated workspace (possibly deleted or renamed).",
          );
        }
        directory = directory === "." ? segment : `${directory}/${segment}`;
      }
      const content = await tools.readFile(file);
      inspectedFiles.push(file);
      const excerpt = content.slice(0, Math.min(6_000, remainingContent));
      fileContents.push({ path: file, content: excerpt });
      remainingContent -= excerpt.length;
      if (excerpt.length < content.length) warnings.push(`Content truncated for ${file}.`);
    } catch (error) {
      warnings.push(`Changed file could not be inspected (${file}): ${messageFromError(error)}`);
    }
  }

  if (rootFiles.includes("package.json")) {
    try {
      packageJson = await tools.readFile("package.json");
      inspectedFiles.push("package.json");
      if (!fileContents.some((entry) => entry.path === "package.json")) {
        fileContents.push({
          path: "package.json",
          content: packageJson.slice(0, 6_000),
        });
      }
    } catch (error) {
      throw new TesterExecutionError(
        failure(`Tester could not read package.json: ${messageFromError(error)}`, [
          "Restore read access to package.json and retry validation.",
        ]),
      );
    }
  } else {
    return failure(
      "No package.json exists in the integrated workspace; no supported npm validation is available.",
      ["Provide the project's package.json and an executable validation script."],
    );
  }

  let scripts: Record<string, string>;
  try {
    scripts = parseNpmScripts(packageJson);
  } catch (error) {
    return failure(messageFromError(error), [
      "Fix package.json so it declares valid executable scripts.",
    ]);
  }
  const supplemental = (request.testerTests ?? []).map((test) => ({
    label: `node ${test.command.args.join(" ")}`,
    command: test.command.command,
    args: test.command.args,
  }));
  for (const test of request.testerTests ?? []) {
    try {
      if (!sameTestContent(await tools.readFile(test.path), test.content)) {
        return failure(`Tester-owned assertions were modified: ${test.path}`, ["Restore the independent tests and fix the production behavior."]);
      }
    } catch {
      return failure(`Tester-owned test is unavailable: ${test.path}`, ["Restore the saved test file before validation."]);
    }
  }
  const commands = [
    ...supplemental,
    ...validationCommands(scripts).map((command) => ({ ...command, command: "npm" as const })),
  ];
  logProgress("tester", "validation_selected", {
    taskId: request.task.id,
    inspectedFiles: inspectedFiles.length,
    commands: commands.length,
  });
  if (commands.length === 0) {
    return failure(
      "No supported validation scripts are declared in package.json; validation has not run.",
      [
        "Add a real test, test:unit, typecheck, check, lint, or build script appropriate to this task.",
      ],
    );
  }
  for (const command of commands) {
    try {
      if (command.command === "npm") {
        assertNpmScriptIsRunnable(scripts, command.args[0] === "test" ? "test" : command.args[1]!);
      }
    } catch (error) {
      return failure(messageFromError(error), [
        "Replace the recursive npm script with an actual test runner or validation command. Do not set test to npm test.",
      ]);
    }
    let result;
    try {
      result = await withProgress(
        "tester.command",
        { taskId: request.task.id, command: command.label },
        () => tools.runCommand({ command: command.command, args: command.args }),
        {
          details: (result) => ({
            exitCode: result.exitCode,
            success: result.exitCode === 0 && !result.executionError && !result.validationError,
          }),
        },
      );
    } catch (error) {
      throw new TesterExecutionError({
        ...invalidResult(
          `Could not execute ${command.label}: ${messageFromError(error)}`,
          request.changedFiles,
        ),
        testsRun: validation.map((entry) => entry.command),
        warnings,
        suggestedFixes: [
          "Restore validation tool execution and retry the Tester; application changes are not indicated.",
        ],
      });
    }
    if (result.executionError) {
      throw new TesterExecutionError({
        ...invalidResult(
          `Could not execute ${command.label} (${result.executionError.code}): ${result.executionError.message.slice(0, 1_000)}`,
          request.changedFiles,
        ),
        testsRun: validation.map((entry) => entry.command),
        warnings,
        suggestedFixes: [
          "Restore validation tool execution and retry the Tester; application changes are not indicated.",
        ],
      });
    }
    if (result.validationError) {
      return failure(result.validationError, [
        "Fix the project's validation script, then rerun it.",
      ]);
    }
    validation.push({
      command: command.label,
      exitCode: result.exitCode,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 4_000),
    });
    if (result.exitCode !== 0) {
      // Tool evidence is authoritative. Do not ask an LLM to reinterpret or
      // mix a command failure with stale failures from an earlier attempt.
      return failure(
        `${command.label} failed (exit ${result.exitCode}): ${validation.at(-1)!.output.slice(0, 1_500)}`,
        [`Fix the reported failure from ${command.label} and rerun it.`],
      );
    }
    if (/^# tests 0\s*$/m.test(result.stdout) ||
        (command.command === "node" && /^# pass 0\s*$/m.test(result.stdout))) {
      return failure(`${command.label} completed but discovered zero tests.`, [
        "Add or select tests for the implemented requirement and run them.",
      ]);
    }
  }

  const prompt = buildTesterPrompt(request, {
    inspectedFiles,
    fileContents,
    rootFiles,
    validation,
    warnings,
  });

  let parsed: unknown;
  try {
    const rawReply = await withProgress("tester.llm", { taskId: request.task.id }, () =>
      ask(prompt),
    );
    parsed = JSON.parse(parseTesterJson(rawReply));
  } catch (error) {
    throw new TesterExecutionError(
      failure("Tester could not return valid JSON.", [
        "Retry the tester review with a valid JSON response; do not rewrite application code for a review protocol error.",
      ]),
    );
  }
  const result = testerResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new TesterExecutionError(
      failure("Tester returned an invalid result schema.", [
        "Retry the tester review with all required fields and no extra fields.",
      ]),
    );
  }

  const failures = [...result.data.failures];
  const suggestedFixes = [...result.data.suggestedFixes];
  if (!result.data.passed && failures.length === 0) failures.push(result.data.summary);
  const passed = result.data.passed && failures.length === 0;
  return {
    ...result.data,
    passed,
    summary: !passed && result.data.passed ? failures[0]! : result.data.summary,
    testsRun: validation.map((entry) => entry.command),
    changedFiles: request.changedFiles,
    warnings: [...new Set([...warnings, ...result.data.warnings])],
    failures: [...new Set(failures)],
    suggestedFixes: [...new Set(suggestedFixes)],
  };
}

export { TesterExecutionError } from "./types.js";
export type { TesterRetryContext, TesterRequest, TesterTools, TesterOptions } from "./types.js";
export { testerResultSchema, type TesterResult } from "../../domain/tester-result.js";
