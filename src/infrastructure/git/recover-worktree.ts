import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkpointGit } from "./checkpoint-git.js";
import { CheckpointError } from "../persistence/workflow-store.js";

/** Recover files, never Git metadata. The original directory is kept untouched. */
export async function recoverWorktree(
  projectRoot: string,
  source: string,
  revision: string,
): Promise<{ workspacePath: string; branchName: string }> {
  const parent = path.resolve(projectRoot, "..", ".ai-dev-worktrees", path.basename(projectRoot));
  if (
    path.dirname(path.resolve(source)) !== parent ||
    (await fs.realpath(source)) !== path.resolve(source)
  ) {
    throw new CheckpointError(`Unsafe recovery source: ${source}`);
  }
  try {
    await fs.lstat(path.join(source, ".git"));
    throw new CheckpointError(`Existing Git metadata must be repaired manually: ${source}`);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  const commit = await checkpointGit(projectRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  // Refuse links instead of copying references outside the saved workspace.
  async function inspect(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      if (entry.name === ".git" || entry.isSymbolicLink())
        throw new CheckpointError(`Unsafe recovery entry: ${path.join(directory, entry.name)}`);
      if (entry.isDirectory()) await inspect(path.join(directory, entry.name));
    }
  }
  await inspect(source);
  const suffix = randomUUID();
  const workspacePath = path.join(parent, `recovered-${suffix}`);
  const branchName = `codex/recovery/${suffix}`;
  // No checkout + read-tree preserves deletions as well as changed/untracked files.
  await checkpointGit(projectRoot, [
    "worktree",
    "add",
    "--no-checkout",
    "-b",
    branchName,
    workspacePath,
    commit,
  ]);
  await checkpointGit(workspacePath, ["read-tree", "HEAD"]);
  try {
    for (const entry of await fs.readdir(source)) {
      if (entry === "node_modules") continue;
      await fs.cp(path.join(source, entry), path.join(workspacePath, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (candidate) => {
          if (path.basename(candidate) === "node_modules") return false;
          if (path.basename(candidate) === ".git" || (await fs.lstat(candidate)).isSymbolicLink()) {
            throw new CheckpointError(`Unsafe recovery entry: ${candidate}`);
          }
          return true;
        },
      });
    }
  } catch (error) {
    throw new CheckpointError(
      `Recovery copy failed; original files remain at ${source}, partial copy at ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { workspacePath, branchName };
}
