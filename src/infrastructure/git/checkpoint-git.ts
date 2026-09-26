import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { CheckpointError } from "../persistence/workflow-store.js";

const exec = promisify(execFile);

export async function checkpointGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await exec("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new CheckpointError(
      `Cannot verify Git state at ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function verifyCheckout(
  root: string,
  branch: string,
  commonDirectory?: string,
): Promise<string> {
  const actualRoot = await checkpointGit(root, ["rev-parse", "--show-toplevel"]);
  if ((await fs.realpath(actualRoot)) !== (await fs.realpath(root)))
    throw new CheckpointError(`Workspace is no longer a repository root: ${root}`);
  if ((await checkpointGit(root, ["symbolic-ref", "--short", "HEAD"])) !== branch) {
    throw new CheckpointError(`Workspace branch changed: ${root}. Expected ${branch}.`);
  }
  const common = await fs.realpath(
    path.resolve(root, await checkpointGit(root, ["rev-parse", "--git-common-dir"])),
  );
  if (commonDirectory && common !== commonDirectory)
    throw new CheckpointError(`Workspace belongs to another repository: ${root}`);
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
    const markerPath = path.resolve(
      root,
      await checkpointGit(root, ["rev-parse", "--git-path", marker]),
    );
    try {
      await fs.access(markerPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    throw new CheckpointError(
      `An unfinished Git operation exists at ${root}. Resolve it before resume.`,
    );
  }
  return common;
}
