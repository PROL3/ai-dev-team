import { WriteScopeError } from "../../tools/agent-tools.js";
import type { AgentAction } from "./protocol.js";
import type { AgentRunnerOptions, ActionExecutionResult } from "./types.js";
import { errorToMessage } from "./formatting.js";

export async function executeAction(
  action: AgentAction,
  tools: NonNullable<AgentRunnerOptions["tools"]>,
): Promise<ActionExecutionResult> {
  switch (action.action) {
    case "diagnose":
      return {
        output: JSON.stringify(action),
        success: true,
        progress: false,
        changedFiles: [],
        testResults: [],
      };
    case "read_file": {
      try {
        const output = await tools.readFile(action.path);

        return {
          output,
          success: true,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      } catch (error) {
        const errorMessage = errorToMessage(error);

        return {
          output:
            `READ_FILE_FAILED: ${action.path}\n` +
            `Reason: ${errorMessage}\n` +
            "Do not retry the same path blindly. " +
            "Use list_files to inspect the actual workspace.",
          success: false,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      }
    }

    case "write_file": {
      try {
        const writeResult = await tools.writeFile(action.path, action.content);

        return {
          output: JSON.stringify({
            action: writeResult.action,
            success: writeResult.success,
            status: writeResult.changed ? "written" : "unchanged",
            path: writeResult.path,
            changed: writeResult.changed,
            contentChanged: writeResult.contentChanged,
            contentHash: writeResult.contentHash,
            bytes: writeResult.bytes,
            verified: writeResult.verified,
            message: writeResult.changed
              ? "File was written and read back successfully."
              : "File already contained the requested content; no write was needed.",
            next:
              "Do not repeat this write. Read the file if you need to inspect " +
              "it, run targeted validation, or return done when the task is complete.",
          }),
          success: true,
          progress: writeResult.changed,
          changedFiles: writeResult.changed ? [action.path] : [],
          testResults: [],
        };
      } catch (error) {
        const errorMessage = errorToMessage(error);

        return {
          output:
            error instanceof WriteScopeError
              ? `WRITE_FILE_FAILED: ${error.message}`
              : `WRITE_FILE_FAILED: ${action.path}\nReason: ${errorMessage}`,
          success: false,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      }
    }

    case "list_files": {
      try {
        const files = await tools.listFiles(action.path ?? ".");

        return {
          output: JSON.stringify(files),
          success: true,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      } catch (error) {
        const errorMessage = errorToMessage(error);

        return {
          output:
            `LIST_FILES_FAILED: ${action.path ?? "."}\n` +
            `Reason: ${errorMessage}\n` +
            "Choose another valid workspace-relative path.",
          success: false,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      }
    }

    case "run_command": {
      try {
        const result = await tools.runCommand({
          command: action.command,
          args: action.args,
        });

        const testResult =
          `${action.command} ${action.args.join(" ")} ` + `(exit ${result.exitCode})`;

        return {
          output: JSON.stringify(result),
          success: result.exitCode === 0,
          exitCode: result.exitCode,

          /*
           * Running a command is not itself a meaningful file change.
           * This prevents successful test commands from resetting the
           * no-progress counter while the agent still has not implemented.
           */
          progress: false,

          changedFiles: [],
          testResults: [testResult],
        };
      } catch (error) {
        const errorMessage = errorToMessage(error);

        return {
          output:
            `RUN_COMMAND_FAILED: ${action.command} ${action.args.join(" ")}\n` +
            `Reason: ${errorMessage}`,
          success: false,
          progress: false,
          changedFiles: [],
          testResults: [],
        };
      }
    }

    case "done":
      return {
        output: action.summary,
        success: true,
        progress: true,
        changedFiles: [],
        testResults: [],
      };
  }
}
