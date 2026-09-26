import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type TaskWorkspace = {
  taskId: string;
  branchName: string;
  path: string;
  baseCommit: string;
};

function sanitizeTaskId(taskId: string): string {
  const sanitized = taskId
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!sanitized) {
    throw new Error(`Task ID "${taskId}" cannot be converted to a safe workspace name`);
  }

  return sanitized.slice(0, 80);
}

async function runGit(args: string[], cwd: string, trim = true): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return trim ? stdout.trim() : stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Git command failed: git ${args.join(" ")}\n${message}`);
  }
}

async function getGitRoot(projectRoot: string): Promise<string | undefined> {
  try {
    return path.resolve(await runGit(["rev-parse", "--show-toplevel"], projectRoot));
  } catch {
    return undefined;
  }
}

export class WorkspaceManager {
  private readonly projectRoot: string;
  private readonly worktreeRoot: string;

  constructor(projectRoot = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);

    const repositoryName = path.basename(this.projectRoot);

    // Keep worktrees OUTSIDE the main repository.
    this.worktreeRoot = path.resolve(this.projectRoot, "..", ".ai-dev-worktrees", repositoryName);
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.projectRoot, { recursive: true });

    if ((await getGitRoot(this.projectRoot)) !== this.projectRoot) {
      await runGit(["init", "-b", "main"], this.projectRoot);
      await runGit(["config", "user.email", "ai-dev-team@localhost"], this.projectRoot);
      await runGit(["config", "user.name", "AI Dev Team"], this.projectRoot);
      await runGit(["commit", "--allow-empty", "-m", "Initialize project"], this.projectRoot);
    }

    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], this.projectRoot);

    const normalizedGitRoot = path.resolve(gitRoot);

    if (normalizedGitRoot !== this.projectRoot) {
      throw new Error(
        `Workspace root does not match Git root.\n` +
          `Expected: ${this.projectRoot}\n` +
          `Git root: ${normalizedGitRoot}`,
      );
    }

    await fs.mkdir(this.worktreeRoot, {
      recursive: true,
    });
  }

  async getBaseCommit(): Promise<string> {
    return runGit(["rev-parse", "HEAD"], this.projectRoot);
  }

  async createTaskWorkspace(taskId: string): Promise<TaskWorkspace> {
    await this.initialize();

    const safeTaskId = sanitizeTaskId(taskId);

    const branchName = `ai/task/${safeTaskId}`;

    const workspacePath = path.join(this.worktreeRoot, safeTaskId);

    const baseCommit = await this.getBaseCommit();

    // Retry protection:
    // if the workspace already exists, reuse it.
    try {
      const stat = await fs.stat(workspacePath);

      if (stat.isDirectory()) {
        return {
          taskId,
          branchName,
          path: workspacePath,
          baseCommit: await runGit(["rev-parse", branchName], this.projectRoot),
        };
      }
    } catch {
      // Directory does not exist.
    }

    // Do not silently overwrite an existing branch.
    const branches = await runGit(["branch", "--list", branchName], this.projectRoot);

    if (branches.trim()) {
      throw new Error(
        `Git branch "${branchName}" already exists, ` +
          `but its workspace is missing.\n` +
          `Refusing to overwrite it automatically.`,
      );
    }

    await runGit(
      ["worktree", "add", "-b", branchName, workspacePath, baseCommit],
      this.projectRoot,
    );

    return {
      taskId,
      branchName,
      path: workspacePath,
      baseCommit,
    };
  }

  async removeTaskWorkspace(workspace: TaskWorkspace): Promise<void> {
    await runGit(["worktree", "remove", "--force", workspace.path], this.projectRoot);

    await runGit(["branch", "-D", workspace.branchName], this.projectRoot);
  }

  async getWorkspaceStatus(workspace: TaskWorkspace): Promise<string> {
    return runGit(["status", "--short"], workspace.path);
  }

  async getWorkspaceDiff(workspace: TaskWorkspace): Promise<string> {
    return runGit(["diff", "--"], workspace.path);
  }

  async getChangedFiles(workspace: TaskWorkspace): Promise<string[]> {
    // Porcelain status columns contain meaningful leading spaces. NUL records
    // preserve whitespace, Unicode, and renames without Git's path quoting.
    const output = await runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      workspace.path,
      false,
    );
    const records = output.split("\0");
    const files: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const file = record.slice(3);
      if (file) files.push(file);
      // With -z the destination comes first, followed by the old rename path.
      if (/[RC]/.test(record.slice(0, 2))) {
        const previousPath = records[++index];
        if (previousPath) files.push(previousPath);
      }
    }
    return [...new Set(files)];
  }

  async getBranchCommit(branchName: string): Promise<string> {
    return runGit(["rev-parse", branchName], this.projectRoot);
  }
}
