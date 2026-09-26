import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const MAX_FILE_BYTES = 24_000;
const MAX_CONTEXT_CHARS = 180_000;
const MAX_CHANGED_FILES = 40;
type TreeEntry = { mode: string; oid: string; size: number };
export type ReviewFile = {
  path: string;
  before: string;
  after: string;
  diff: string;
  ranges: Array<{ side: "before" | "after"; start: number; end: number }>;
};
export type ReviewSnapshot = {
  baseCommit: string;
  headCommit: string;
  paths: string[];
  changedFiles: string[];
  files: ReviewFile[];
  contextFiles: Array<{ path: string; content: string }>;
  limitations: string[];
};

async function git(root: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd: root, shell: false, windowsHide: true, timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

// Do not read secrets, generated output or links, even if Git tracks them.
function excluded(file: string): boolean {
  return file.split("/").some((part) =>
    /^(?:\.git|node_modules|dist|build|coverage|vendor|\.next|\.ai-dev-worktrees)$/i.test(part) ||
    /^\.env(?:\.|$)/i.test(part) ||
    /^(?:\.npmrc|\.pypirc|\.yarnrc(?:\..*)?|id_rsa|id_ed25519|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part),
  ) || /\.(?:pem|key|p12|pfx)$/i.test(file);
}

async function tree(root: string, commit: string): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  for (const record of (await git(root, ["ls-tree", "-rlz", commit])).split("\0")) {
    if (!record) continue;
    const match = /^(\d+) \S+ ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Could not parse committed tree.");
    entries.set(match[4]!, { mode: match[1]!, oid: match[2]!, size: Number(match[3]) });
  }
  return entries;
}

async function blob(root: string, entry: TreeEntry | undefined): Promise<string> {
  if (!entry) return ""; // Added/deleted file, not a failed read.
  if (!/^100(?:644|755)$/.test(entry.mode)) throw new Error("Link or submodule excluded");
  if (!Number.isFinite(entry.size) || entry.size > MAX_FILE_BYTES) throw new Error("File exceeds review size limit");
  const content = await git(root, ["cat-file", "blob", entry.oid]);
  if (content.includes("\0") || content.includes("\uFFFD")) throw new Error("Binary or non-UTF-8 file excluded");
  return content;
}

function diffRanges(diff: string): ReviewFile["ranges"] {
  const ranges: ReviewFile["ranges"] = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (const [side, offset] of [["before", 1], ["after", 3]] as const) {
      const start = Number(match[offset]);
      const count = Number(match[offset + 1] ?? 1);
      if (count > 0) ranges.push({ side, start, end: start + count - 1 });
    }
  }
  return ranges;
}

export async function listReviewChangedFiles(root: string, baseCommit: string, headCommit: string): Promise<string[]> {
  if (![baseCommit, headCommit].every((commit) => /^[a-f0-9]{40,64}$/.test(commit))) {
    throw new Error("Review requires full immutable commit IDs.");
  }
  return (await git(root, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, headCommit, "--",
  ])).split("\0").filter(Boolean);
}

/** Reads immutable Git objects only. Never executes project code or follows filesystem links. */
export async function collectReviewSnapshot(
  root: string, baseCommit: string, headCommit: string,
  scope?: { integrationBase: string; previousFiles: string[] },
): Promise<ReviewSnapshot> {
  for (const commit of [baseCommit, headCommit, ...(scope ? [scope.integrationBase] : [])]) {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Review requires full immutable commit IDs.");
    await git(root, ["cat-file", "-e", `${commit}^{commit}`]);
  }
  await git(root, ["merge-base", "--is-ancestor", baseCommit, headCommit]);
  const [beforeTree, afterTree] = await Promise.all([tree(root, baseCommit), tree(root, headCommit)]);
  let changedFiles = await listReviewChangedFiles(root, baseCommit, headCommit);
  if (scope) {
    await git(root, ["merge-base", "--is-ancestor", scope.integrationBase, headCommit]);
    const currentPaths = await listReviewChangedFiles(root, scope.integrationBase, headCommit);
    const taskPaths = new Set([...currentPaths, ...scope.previousFiles]);
    // Recheck earlier task changes after a fix without absorbing independent sibling tasks.
    changedFiles = changedFiles.filter((file) => taskPaths.has(file));
  }
  const snapshot: ReviewSnapshot = {
    baseCommit, headCommit, paths: [...afterTree.keys()].filter((file) => !excluded(file)).slice(0, 600),
    changedFiles, files: [], contextFiles: [], limitations: [],
  };
  if (!changedFiles.length) snapshot.limitations.push("No committed changes to review.");
  if (changedFiles.length > MAX_CHANGED_FILES) snapshot.limitations.push("Changed-file count exceeds review limit.");
  let remaining = MAX_CONTEXT_CHARS;
  for (const file of changedFiles.slice(0, MAX_CHANGED_FILES)) {
    try {
      if (excluded(file)) throw new Error("Sensitive or generated path excluded");
      const [before, after] = await Promise.all([blob(root, beforeTree.get(file)), blob(root, afterTree.get(file))]);
      const diff = await git(root, [
        "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--text", "--unified=0",
        baseCommit, headCommit, "--", `:(literal)${file}`,
      ]);
      const size = before.length + after.length + diff.length;
      if (size > remaining) throw new Error("Total review context limit reached");
      remaining -= size;
      snapshot.files.push({ path: file, before, after, diff, ranges: diffRanges(diff) });
    } catch (error) {
      // Never include Git stderr here: a failed command may contain repository data.
      const reason = error instanceof Error && !('stderr' in error) ? error.message : "Git inspection failed";
      snapshot.limitations.push(`${file}: ${reason}`);
    }
  }

  // Existing contracts, local imports and nearby tests give architectural context.
  const candidates = new Set(["package.json", "tsconfig.json", "README.md", "docs/architecture.md"]);
  for (const file of snapshot.files) {
    for (const match of file.after.matchAll(/(?:from\s*|(?:import|require)\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]!));
      const variants = [stem, stem.replace(/\.([cm]?)js$/, ".$1ts"), stem.replace(/\.jsx$/, ".tsx")];
      for (const extension of ["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"]) {
        variants.push(`${stem}.${extension}`, `${stem}/index.${extension}`);
      }
      for (const name of variants) {
        if (afterTree.has(name)) { candidates.add(name); break; }
      }
    }
    const stem = path.posix.basename(file.path).replace(/\.[^.]+$/, "");
    for (const name of afterTree.keys()) {
      if (path.posix.basename(name).startsWith(`${stem}.`) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) candidates.add(name);
    }
    const dir = path.posix.dirname(file.path);
    candidates.add(`${dir}/package.json`);
  }
  const selected = [...candidates].filter((file) => afterTree.has(file) && !changedFiles.includes(file) && !excluded(file));
  if (selected.length > 20) snapshot.limitations.push("Related context file count exceeds review limit.");
  for (const file of selected.slice(0, 20)) {
    try {
      const content = await blob(root, afterTree.get(file));
      if (content.length > remaining) throw new Error("Context budget exhausted");
      remaining -= content.length;
      snapshot.contextFiles.push({ path: file, content });
    } catch {
      snapshot.limitations.push(`Related context unavailable: ${file}`);
    }
  }
  return snapshot;
}
