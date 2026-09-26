import type { SafeCommand } from "../types.js";

export function validateCommand(command: SafeCommand): void {
  const { command: executable, args } = command;

  if (executable === "npm" || executable === "npx") {
    if (executable === "npm" && args.length === 1 && args[0] === "install") {
      return;
    }

    const allowedFirstArgs = new Set(["test", "run"]);

    const firstArg = args[0];

    if (!firstArg || !allowedFirstArgs.has(firstArg)) {
      throw new Error(`Command not allowed: ${executable} ${args.join(" ")}`);
    }

    if (firstArg === "run" && (!args[1] || !/^[a-zA-Z0-9:_-]+$/.test(args[1]))) {
      throw new Error("Invalid npm script name");
    }

    return;
  }

  if (executable === "node") {
    if (args.length === 0) {
      throw new Error("node requires a script or file");
    }

    return;
  }

  if (executable === "git") {
    const firstArg = args[0];

    const allowedGitCommands = new Set(["status", "diff", "log", "branch", "rev-parse"]);

    if (!firstArg || !allowedGitCommands.has(firstArg)) {
      throw new Error(`Git command not allowed: git ${args.join(" ")}`);
    }

    return;
  }
}
