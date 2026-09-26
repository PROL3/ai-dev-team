import { AgentTools } from "../../tools/agent-tools.js";
import type { TesterResult } from "../../domain/tester-result.js";
import type { TesterTestArtifact } from "../../domain/test-authoring.js";

export type TesterRetryContext = Pick<
  TesterResult,
  "passed" | "summary" | "failures" | "suggestedFixes"
>;

export type TesterRequest = {
  task: { id: string; title: string; description: string };
  workspacePath: string;
  changedFiles: string[];
  previousAgentSummary: string;
  previousTesterResult?: TesterRetryContext;
  testerTests?: TesterTestArtifact[];
};

export type TesterTools = Pick<AgentTools, "listFiles" | "readFile" | "runCommand">;

export type TesterOptions = {
  ask?: (prompt: string) => Promise<string>;
  tools?: TesterTools;
};

export type ValidationRun = { command: string; exitCode: number; output: string };

export class TesterExecutionError extends Error {
  constructor(readonly result: TesterResult) {
    super(result.summary);
    this.name = "TesterExecutionError";
  }
}
