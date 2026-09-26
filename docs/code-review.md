# Code Review agent

Every new default workflow now runs:

```text
Coder → Tester → Reviewer → Complete
  ↑       ↓         ↓
  └── test failure ─┘ blocking review
       Every repair goes through Tester again.
```

Tester writes independent tests in the task worktree before code and tests are
integrated together. Tester then executes functional validation on the integrated
project. Review runs only after a PASS for that exact integrated commit. A rejected change is already on the target
project's `main`; the workflow retains it for repair. It does not roll back commits
or promise pre-merge protection. Dependent tasks remain blocked until both Review
and Tester pass. Independent tasks retain the existing dispatch rules.

## Responsibilities and code locations

| Module | Responsibility |
| --- | --- |
| `src/domain/code-review.ts` | Strict finding/result schemas, priorities and deterministic approval policy |
| `src/agents/code-review/prompt.ts` | The complete review prompt and ordered review method |
| `src/agents/code-review/types.ts` | Review requests and model injection contract |
| `src/agents/code-review/validation.ts` | Verify locations, diff overlap, exact excerpts and duplicate findings |
| `src/agents/code-review/run-code-review.ts` | Collect evidence, request one model response, derive the result |
| `src/infrastructure/git/review-snapshot.ts` | Bounded reads of committed files, diffs, imports and nearby tests |
| `src/workflow/code-review.ts` | Completion gate, feedback, bounded retries and checkpoints |

The reviewer identifies quality, security and project-standard defects. The Coder
owns production fixes; Tester authors independent tests and owns functional
validation. See [the loop and test ownership](tester-review-loop.md).
The reviewer uses the project's actual tree, root documentation/configuration,
nearby package manifests, direct relative imports, matching tests and the Planner's
architecture contract. It does not impose this orchestrator's layout on the target.

## Prompt method

The prompt specifies six ordered passes:

1. Establish task scope, ownership, requirements and the actual changes.
2. Trace module boundaries, contracts, inputs/outputs and resource ownership.
3. Consider relevant edge cases before deciding: empty/invalid/boundary inputs,
   deletion, permissions, injection, async failures, cancellation, races, partial
   writes, cleanup, retries, idempotency and resume.
4. Inspect test coverage and error paths without claiming to have executed tests.
5. Challenge each finding against existing guards and current evidence; discard
   duplicates, fixed issues, unrelated pre-existing defects and stylistic preferences.
6. Return actionable findings and explicit limitations in strict JSON.

Each finding includes priority, category, title, file, before/after side, a short
line range, an exact source excerpt, triggering scenario, impact and suggested fix.
Line ranges are one-based, inclusive, at most ten lines, and must overlap a changed
range on the cited side. Removed code can be cited on the `before` side.

The model returns only `summary`, `findings` and `limitations`. It cannot declare
its own approval, inspected-file list or Git revisions. The runner supplies these.
Source/summary text is marked as untrusted data in the prompt; the model has no
write or command tools. Location checks verify evidence provenance, not the truth
of the model's reasoning about a defect.

## Decision and retry policy

| Evidence | Result | Workflow behavior |
| --- | --- | --- |
| P0 critical / P1 major / P2 concrete limited-impact defect | `changes_requested` | Return structured feedback to implementation within its remaining budget |
| P3 advisory only, or no supported defect, with sufficient evidence | `approved` | Complete the already-tested task |
| Incomplete inspection or missing relevant context without a blocking finding | `inconclusive` | Retry review within the runner budget; never silently approve |
| Invalid JSON/schema/location/evidence or provider/Git failure | Execution failure | Retry review without spending an implementation attempt |

There are at most two reviewer executions per validation entry and four total
review attempts per task by default. Implementation retains its existing two-attempt
budget. An interrupted in-flight attempt resumes without consuming a new attempt.
Ordinary resume does not renew budgets. Explicit `--retry-failed` grants one more
implementation attempt and up to two more reviewer executions.

Retries compare the task's cumulative changes from its original review base,
restricted to paths actually changed by that task's integrations. These paths
are saved even when a provider fails or a file cannot be read. A cosmetic fix in
another file cannot hide an earlier unresolved defect, and sibling-task changes
are not added to the reviewed diff. Prior findings are rechecked against current
code, never automatically repeated. Paths accumulate even when an earlier attempt
failed Tester and never reached Review. Reintegrating a repair invalidates both
Tester and Review approval. The repair must pass Tester before Review can run.

## Evidence limits and edge cases

Reads use immutable Git objects, not dirty working files. Rename detection is
disabled: a rename is reviewed as deletion plus addition, including filenames
with spaces. Git external diff drivers and text conversion are disabled, and Git
commands use argument arrays without a shell. Filesystem symlinks are not followed.

The snapshot supports UTF-8 text. It excludes conventional secret paths (`.env*`,
credential files, private keys, package credentials), dependency/build directories,
Git links/submodules and binary/non-UTF-8 files. This is a filename-based exclusion
policy, not a general secret detector. An excluded **changed** file makes coverage
incomplete; it is never silently counted as reviewed. Empty changes also cannot
produce an approval. Secret contents and Git stderr are not embedded in diagnostics.

Inspection is bounded to 40 changed files, 24 KB per source file, 180,000 characters
of source/diff context, 20 related files and 600 displayed tree paths. Git commands
have a 15-second timeout and a 2 MB output cap. Exceeding source/diff limits records
a limitation rather than truncating code into a misleading approval. Large changes
or generated lockfiles may therefore require a smaller task or an explicitly
configured alternative reviewer. The tree listing is a navigation aid, not proof
that every caller in the repository has been inspected. Relative import discovery
is heuristic; unavailable semantic context must be reported as a limitation.

## Configuration and resume

The default CLI workflow enables review automatically. Library integrations that
provide a custom `executeAgent` opt in with `enableCodeReview: true` or by supplying
`executeCodeReview`, preserving legacy callers' offline behavior. Explicit
`enableCodeReview: false` disables review. Enabling review while disabling Tester
is rejected; injected review executors also require a Tester executor or enabled Tester.

```ts
const workflow = new Orchestrator(plan, {
  projectRoot,
  checkpointPath,
  enableCodeReview: true,
});
await workflow.runUntilComplete();
```

Custom `executeCodeReview(request)` implementations are trusted executors. Their
results still undergo schema, priority/status and revision checks; use
`runCodeReview(request, { ask })` to retain the built-in source-evidence checks.
Supply custom executors again on resume; functions are not serialized.

Checkpoints retain `tested`/`reviewing`/`reviewed` phases, approval revisions, original
review base, cumulative paths, attempts, findings and feedback. Resuming interrupted
Review reuses Tester PASS for the same commit without rerunning implementation or
tests. A saved
approval is reusable only for the same review base and integrated commit. Completed
tasks require approval evidence when review is enabled. Older version-1 checkpoints
without review fields load with review disabled. Unfinished older review-before-test
runs discard premature review approval and run Tester before Review. Completed tasks
retain their evidence. Legacy review-only configurations with Tester disabled cannot
resume under the new invariant. Stage enablement cannot change during resume.

## Verification

```sh
npm run build
npx tsx --test tests/code-review/*.test.ts tests/workflow/workflow-code-review.test.ts
npm test
```

Tests use scripted model responses, real temporary Git repositories and injected
workflow executors. They verify evidence boundaries, deleted/renamed files, secret
and link exclusions, invalid findings, incomplete reviews, cumulative repairs,
retry limits, dependency gating, checkpoint compatibility and interruption recovery.
They do not establish the review quality of a live model provider.
