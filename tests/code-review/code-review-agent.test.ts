import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { collectReviewSnapshot } from "../../src/infrastructure/git/review-snapshot.js";
import { runCodeReview } from "../../src/agents/code-review/run-code-review.js";
import { validateReviewResponse } from "../../src/agents/code-review/validation.js";
import { codeReviewResultSchema, type ReviewFinding } from "../../src/domain/code-review.js";

const exec = promisify(execFile);
const response = { summary: "Reviewed current change.", findings: [], limitations: [] };
const finding: ReviewFinding = {
  priority: "P1", category: "correctness", title: "Handle zero divisors",
  file: "src/divide.ts", side: "after", startLine: 2, endLine: 2,
  evidence: "return a / b;", scenario: "Calling divide(1, 0) reaches this expression.",
  impact: "Returns Infinity instead of the required error.", suggestedFix: "Reject zero before dividing.",
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review snapshot with spaces-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Review tests");
  await git("config", "user.email", "tests@example.invalid");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/divide.ts"), "export function divide(a: number, b: number) {\n  if (b === 0) throw new Error('zero');\n  return a / b;\n}\n");
  await fs.writeFile(path.join(root, "src/old name.ts"), "export const old = true;\n");
  await fs.writeFile(path.join(root, "src/contract.ts"), "export const contract = 'reject zero';\n");
  await fs.writeFile(path.join(root, "README.md"), "Existing TypeScript modules.\n");
  await git("add", "-A");
  await git("commit", "-m", "base");
  const baseCommit = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "src/divide.ts"), "export function divide(a: number, b: number) {\n  return a / b;\n}\nimport { contract } from './contract.js';\n");
  await fs.rename(path.join(root, "src/old name.ts"), path.join(root, "src/new name.ts"));
  await git("add", "-A");
  await git("commit", "-m", "change");
  const headCommit = await git("rev-parse", "HEAD");
  const request = {
    task: { id: "divide", title: "Safe divide", description: "Reject zero divisors", owner: "backend" as const, dependencies: [], files: ["src/"] },
    workspacePath: root, baseCommit, headCommit, previousAgentSummary: "Implemented safely",
  };
  return { root, git, request };
}

test("review uses committed before/after evidence, deletion/rename paths, imports and contracts", async (t) => {
  const { root, git, request } = await fixture(t);
  // Dirty filesystem content must never enter an immutable review.
  await fs.writeFile(path.join(root, "src/divide.ts"), "uncommitted secret content");
  const beforeStatus = await git("status", "--porcelain");
  const snapshot = await collectReviewSnapshot(root, request.baseCommit, request.headCommit);
  assert.deepEqual(snapshot.changedFiles, ["src/divide.ts", "src/new name.ts", "src/old name.ts"]);
  assert.equal(snapshot.files.find((file) => file.path === "src/old name.ts")!.after, "");
  assert.equal(snapshot.files.find((file) => file.path === "src/new name.ts")!.before, "");
  assert.ok(snapshot.contextFiles.some((file) => file.path === "src/contract.ts"));
  let calls = 0;
  const result = await runCodeReview(request, { ask: async (prompt) => {
    calls++;
    assert.match(prompt, /Edge cases BEFORE conclusions/);
    assert.match(prompt, /UNTRUSTED DATA/);
    assert.match(prompt, /reject zero/);
    assert.doesNotMatch(prompt, /uncommitted secret content/);
    return JSON.stringify({ ...response, findings: [{ ...finding, side: "before", startLine: 2, endLine: 2, evidence: "if (b === 0) throw new Error('zero');" }] });
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, "changes_requested");
  assert.equal(result.headCommit, request.headCommit);
  assert.equal(await git("status", "--porcelain"), beforeStatus);
});

test("protocol rejects invented locations, evidence, duplicate findings and extra approval fields", async (t) => {
  const { root, request } = await fixture(t);
  const snapshot = await collectReviewSnapshot(root, request.baseCommit, request.headCommit);
  const removedGuard = { ...finding, side: "before" as const, evidence: "if (b === 0) throw new Error('zero');" };
  assert.equal(validateReviewResponse(JSON.stringify({ ...response, findings: [removedGuard] }), snapshot).findings.length, 1);
  for (const invalid of [
    { ...removedGuard, file: "outside.ts" }, { ...removedGuard, startLine: 999, endLine: 999 },
    { ...removedGuard, evidence: "invented code" }, { ...removedGuard, startLine: 1, endLine: 1, evidence: "export" },
  ]) assert.throws(() => validateReviewResponse(JSON.stringify({ ...response, findings: [invalid] }), snapshot));
  assert.throws(() => validateReviewResponse(JSON.stringify({ ...response, findings: [removedGuard, removedGuard] }), snapshot));
  assert.throws(() => validateReviewResponse(JSON.stringify({ ...response, passed: true }), snapshot));
  assert.throws(() => validateReviewResponse("```json\n{}\n```", snapshot));
  assert.throws(() => validateReviewResponse("{} trailing", snapshot));
});

test("no findings approves; advisory findings do not block; limitations prevent approval", async (t) => {
  const { request } = await fixture(t);
  const approve = await runCodeReview(request, { ask: async () => JSON.stringify(response) });
  assert.equal(approve.status, "approved");
  const partial = await runCodeReview(request, { ask: async () => JSON.stringify({ ...response, limitations: ["Caller behavior not supplied"] }) });
  assert.equal(partial.status, "inconclusive");
  const advisory = await runCodeReview(request, { ask: async () => JSON.stringify({ ...response, findings: [
    { ...finding, priority: "P3", side: "before", evidence: "if (b === 0) throw new Error('zero');" },
  ] }) });
  assert.equal(advisory.status, "approved");
  assert.equal(codeReviewResultSchema.safeParse({ ...partial, status: "approved" }).success, false);
  assert.equal(codeReviewResultSchema.safeParse({ ...approve, reviewedFiles: [] }).success, false);
});

test("secrets, binary, oversized files and Git symlinks cannot silently pass or leak into prompts", async (t) => {
  const { root, git, request } = await fixture(t);
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_TEST_TOKEN=do-not-send");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 255, 3]));
  await fs.writeFile(path.join(root, "large.ts"), "x".repeat(25_000));
  await git("add", "-A");
  // A Git link works even on Windows hosts lacking permission to create OS symlinks.
  const linkBlob = await git("hash-object", "-w", "--", "README.md");
  await git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},link.ts`);
  await git("commit", "-m", "unreviewable files");
  const result = await runCodeReview({ ...request, headCommit: await git("rev-parse", "HEAD") }, { ask: async (prompt) => {
    assert.doesNotMatch(prompt, /PRIVATE_TEST_TOKEN|do-not-send/);
    return JSON.stringify(response);
  } });
  assert.equal(result.status, "inconclusive");
  for (const file of [".env", "binary.bin", "large.ts", "link.ts"]) {
    assert.ok(result.limitations.some((limitation) => limitation.includes(file)));
    assert.ok(!result.reviewedFiles.includes(file));
  }
});

test("empty diffs do not invoke the model; revision arguments cannot be options or moving refs", async (t) => {
  const { root, request } = await fixture(t);
  const result = await runCodeReview({ ...request, headCommit: request.baseCommit }, { ask: async () => assert.fail("No evidence to review") });
  assert.equal(result.status, "inconclusive");
  for (const invalid of ["HEAD", "--help", "main", "a".repeat(40)]) {
    await assert.rejects(collectReviewSnapshot(root, invalid, request.headCommit));
  }
});

test("cumulative review rechecks unfixed earlier changes without including a sibling's changes", async (t) => {
  const { root, git, request } = await fixture(t);
  await fs.writeFile(path.join(root, "sibling.ts"), "export const sibling = true;\n");
  await git("add", "-A");
  await git("commit", "-m", "unrelated sibling task");
  const integrationBase = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "repair.ts"), "export const repair = 'does not fix divide';\n");
  await git("add", "-A");
  await git("commit", "-m", "ineffective fix in a different file");
  const result = await runCodeReview({
    ...request, headCommit: await git("rev-parse", "HEAD"), integrationBase,
    reviewPaths: ["src/divide.ts", "src/new name.ts", "src/old name.ts"],
  }, { ask: async (prompt) => {
    assert.match(prompt, /does not fix divide/);
    return JSON.stringify({ ...response, findings: [{ ...finding, side: "before", evidence: "if (b === 0) throw new Error('zero');" }] });
  } });
  assert.equal(result.status, "changes_requested");
  assert.ok(result.reviewedFiles.includes("src/divide.ts"));
  assert.ok(result.reviewedFiles.includes("repair.ts"));
  assert.ok(!result.reviewedFiles.includes("sibling.ts"));
});

test("text diffs ignore binary attributes/external drivers and include TSX import context", async (t) => {
  const { root, git } = await fixture(t);
  await fs.writeFile(path.join(root, ".gitattributes"), "*.ts -diff\n");
  await fs.writeFile(path.join(root, "src/view.tsx"), "export const View = '<main>Ready</main>';\n");
  await git("add", "-A");
  await git("commit", "-m", "context and binary attributes");
  const baseCommit = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "src/divide.ts"), "export const view = import('./view');\n");
  await git("add", "-A");
  await git("commit", "-m", "use view");
  await git("config", "diff.external", "nonexistent-review-driver");
  const snapshot = await collectReviewSnapshot(root, baseCommit, await git("rev-parse", "HEAD"));
  assert.deepEqual(snapshot.limitations, []);
  assert.ok(snapshot.files[0]!.ranges.some((range) => range.side === "after"));
  assert.ok(snapshot.contextFiles.some((file) => file.path === "src/view.tsx"));
});
