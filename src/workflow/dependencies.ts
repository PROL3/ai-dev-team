import path from "node:path";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { withProgress } from "../infrastructure/logging/progress.js";
import { AgentTools } from "../tools/agent-tools.js";
import type { WorkflowRuntime } from "./runtime.js";

export async function installTesterDependencies(state: WorkflowRuntime): Promise<void> {
  const packageJsonPath = path.join(state.projectRoot, "package.json");
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    // runTester owns the detailed package.json error and will report it.
    return;
  }

  const dependencyNames = ["dependencies", "devDependencies"].flatMap((field) => {
    const value = packageJson[field];
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  });
  const dependenciesInstalled = dependencyNames.every((name) =>
    fsSync.existsSync(path.join(state.projectRoot, "node_modules", ...name.split("/"))),
  );

  if (dependencyNames.length === 0 || dependenciesInstalled) return;

  const tools = new AgentTools({
    role: "tester",
    workspacePath: state.projectRoot,
    exactPaths: true,
  });
  const result = await withProgress(
    "tester.dependencies",
    { workspacePath: state.projectRoot },
    () => tools.runCommand({ command: "npm", args: ["install"] }),
    {
      heartbeatMs: 0,
      details: (installResult) => ({
        exitCode: installResult.exitCode,
        success: installResult.exitCode === 0 && !installResult.executionError,
      }),
    },
  );

  if (result.executionError) {
    throw new Error(
      `Tester dependency installation could not run (${result.executionError.code}): ${result.executionError.message}`,
    );
  }
  if (result.validationError) {
    throw new Error(`Tester dependency installation was rejected: ${result.validationError}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `npm install failed before Tester validation (exit ${result.exitCode}): ${`${result.stdout}\n${result.stderr}`.trim().slice(0, 1_000)}`,
    );
  }
}
