export type AgentRole = "backend" | "frontend" | "tester";

export type AgentToolContext = {
  role: AgentRole;
  workspacePath: string;
  allowedPaths?: string[];
  exactPaths?: boolean;
  assignedTestDirectory?: string;
};

export type SafeCommand =
  | {
      command: "npm";
      args: string[];
    }
  | {
      command: "npx";
      args: string[];
    }
  | {
      command: "node";
      args: string[];
    }
  | {
      command: "git";
      args: string[];
    };

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The validation process could not run reliably; this is not a test failure. */
  executionError?: { code: string; message: string };
  /** The command was rejected before starting due to invalid project scripts. */
  validationError?: string;
};
