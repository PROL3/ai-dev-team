import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskWorkspace } from "./workspace-manager.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      shell: false,
      maxBuffer: 2 * 1024 * 1024,
    });

    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    throw new Error(
      `Git command failed: git ${args.join(" ")}\n` +
        `${typed.stdout ?? ""}\n` +
        `${typed.stderr ?? typed.message ?? ""}`,
    );
  }
}

export class GitIntegrationManager {
  private readonly projectRoot: string;
  private integrationTail: Promise<void> = Promise.resolve();

  constructor(projectRoot = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  async getStatus(workspace: TaskWorkspace): Promise<string> {
    return runGit(["status", "--short"], workspace.path);
  }

  async commitTask(workspace: TaskWorkspace, taskId: string): Promise<string> {
    const status = await this.getStatus(workspace);

    if (!status.trim()) {
      const branchCommit = await runGit(["rev-parse", "HEAD"], workspace.path);
      return branchCommit;
    }

    await runGit(["add", "-A"], workspace.path);

    const commitMessage = `ai: complete ${taskId}`;

    try {
      await runGit(["commit", "-m", commitMessage], workspace.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to commit|working tree clean/i.test(message)) {
        return runGit(["rev-parse", "HEAD"], workspace.path);
      }
      throw error;
    }

    return runGit(["rev-parse", "HEAD"], workspace.path);
  }

  async mergeTask(workspace: TaskWorkspace): Promise<void> {
    await runGit(
      ["merge", "--no-ff", workspace.branchName, "-m", `Merge ${workspace.branchName}`],
      this.projectRoot,
    );
  }

  async getCurrentMainCommit(): Promise<string> {
    return runGit(["rev-parse", "HEAD"], this.projectRoot);
  }

  async getMainStatus(): Promise<string> {
    return runGit(["status", "--porcelain"], this.projectRoot);
  }

  async getConflictFiles(cwd = this.projectRoot): Promise<string[]> {
    const output = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);

    return output
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  }

  async abortMerge(): Promise<void> {
    await runGit(["merge", "--abort"], this.projectRoot);
  }

  async abortRebase(workspace: TaskWorkspace): Promise<void> {
    await runGit(["rebase", "--abort"], workspace.path);
  }

  async synchronizeTaskBranch(workspace: TaskWorkspace): Promise<{
    success: boolean;
    commitHash: string;
    conflictFiles: string[];
    error?: string;
    cleanupError?: string;
  }> {
    try {
      await runGit(["rebase", "main"], workspace.path);

      return {
        success: true,
        commitHash: await runGit(["rev-parse", "HEAD"], workspace.path),
        conflictFiles: [],
      };
    } catch (error) {
      const conflictFiles = await this.getConflictFiles(workspace.path);
      let cleanupError: string | undefined;

      try {
        await this.abortRebase(workspace);
      } catch (abortError) {
        cleanupError = abortError instanceof Error ? abortError.message : String(abortError);
      }

      return {
        success: false,
        commitHash: await runGit(["rev-parse", "HEAD"], workspace.path),
        conflictFiles,
        error: error instanceof Error ? error.message : String(error),
        ...(cleanupError ? { cleanupError } : {}),
      };
    }
  }

  async integrateTask(
    workspace: TaskWorkspace,
    taskId: string,
  ): Promise<{
    success: boolean;
    commitHash: string;
    mainCommit: string;
    conflictFiles: string[];
    error?: string;
    cleanupError?: string;
  }> {
    return this.runExclusive(async () => {
      let mainStatus: string;

      try {
        mainStatus = await this.getMainStatus();
      } catch (error) {
        return {
          success: false,
          commitHash: "",
          mainCommit: await this.getCurrentMainCommit(),
          conflictFiles: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (mainStatus.trim()) {
        return {
          success: false,
          commitHash: "",
          mainCommit: await this.getCurrentMainCommit(),
          conflictFiles: [],
          error:
            "Main repository has uncommitted changes. " +
            "Commit or stash them before running task integration.\n" +
            `Changed paths:\n${mainStatus}`,
        };
      }

      const commitHash = await this.commitTask(workspace, taskId);
      const synchronization = await this.synchronizeTaskBranch(workspace);

      if (!synchronization.success) {
        return {
          success: false,
          commitHash,
          mainCommit: await this.getCurrentMainCommit(),
          conflictFiles: synchronization.conflictFiles,
          ...(synchronization.error ? { error: synchronization.error } : {}),
          ...(synchronization.cleanupError ? { cleanupError: synchronization.cleanupError } : {}),
        };
      }

      try {
        await this.mergeTask(workspace);

        return {
          success: true,
          commitHash: synchronization.commitHash,
          mainCommit: await this.getCurrentMainCommit(),
          conflictFiles: [],
        };
      } catch (error) {
        const conflictFiles = await this.getConflictFiles();
        let cleanupError: string | undefined;

        if (conflictFiles.length > 0) {
          try {
            await this.abortMerge();
          } catch (abortError) {
            cleanupError = abortError instanceof Error ? abortError.message : String(abortError);
          }
        }

        return {
          success: false,
          commitHash: synchronization.commitHash,
          mainCommit: await this.getCurrentMainCommit(),
          conflictFiles,
          error: error instanceof Error ? error.message : String(error),
          ...(cleanupError ? { cleanupError } : {}),
        };
      }
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.integrationTail;
    let release!: () => void;

    this.integrationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}
