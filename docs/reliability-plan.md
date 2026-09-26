# Reliable agent execution: design and implementation plan

This document preserves the design history. The current module layout is in
[architecture.md](architecture.md). Offline tests now live in `tests/`, and live
`npm test` runs only the offline regressions.

The objective is recovery from expected failures with preserved evidence, bounded
cost and truthful validation. A model cannot be guaranteed to solve every task.
Success means reducing avoidable failures and reporting a specific actionable
blocker when automated recovery is exhausted.

## Existing architecture to retain

User request → Planner → validated DAG → isolated implementation worktrees →
serialized integration → dedicated Tester → completion or structured retry.

Keep the existing LLM gateway and provider selection, task ownership, Git
integration queue, separate implementation/integration/tester counters and
post-integration validation. The changes below are incremental integration points,
not replacements for these components.

## Findings from the code

1. `agent-runner.ts` replaced `history` with just the latest result. After reading
   a file the next prompt could lose the earlier command failure and contract.
2. Its prompt pushed writes immediately after inspection and characterized every
   retry with changed files as a repeated-write failure, regardless of the cause.
3. The unfinished recovery guard blocked every command until a source write.
   That prevented useful diagnostics and dependency installation.
4. Command failure counts accumulated even after actual corrective writes.
5. Nested Node test commands inherited `NODE_TEST_CONTEXT`; Node could skip the
   requested tests with exit zero. This was reproduced during recovery testing.
6. Worktrees and the integrated project have independent dependency installations.
   `node_modules` is not transferred by Git. No environment preparation stage is
   currently present in the orchestrator.
7. The planner contract names a test invocation and broad architecture, but has
   no structured per-task acceptance criteria. Its example foundation file list
   omits tests even though its instructions require executable foundation checks.
8. `npm test` mixes offline regression tests with manual/live-provider entrypoints.
   It is not currently a reliable unattended regression command.

## Implemented in this change

- Bounded working memory from real tool results: recent observations, observed
  paths, latest diagnostic decision and unresolved failure evidence. Large outputs
  retain both beginning and end, with an explicit truncation marker.
- Optional typed `diagnose` action: suspected category, hypothesis, observed
  evidence and the next concrete check. A hypothesis is not proof and does not
  mark a failure resolved or authorize new tools.
- Diagnostic commands stay available. The guard blocks the exact unchanged failed
  command; a content-changing write or successful approved dependency installation
  allows verification. Runner-reported execution errors permit one unchanged retry.
- Reading new evidence counts toward investigation progress. Repeating identical
  observations, diagnoses or writes does not grant unlimited execution.
- Fresh validation attempt counts after actual corrective writes; hard execution
  budgets, loop guards, tool policy and the post-integration Tester remain active.
- No completion while an executed command has an unresolved failure. Another
  successful diagnostic command does not erase it.
- Child command processes no longer inherit Node's internal test-runner marker.
- Offline regression coverage for HTTP 404 recovery, evidence retention, dependency
  recovery, transient/persistent runner errors, no-op edits and loop termination.

These tests use scripted model responses to test the controller deterministically.
They do not establish a live model's autonomous success rate. A file change is a
repair attempt, not proof it fixed the defect; only validation supplies that proof.

## Next implementation stages, in priority order

### 1. Reproducible workspace preparation

Add a shared preparation service called before implementation validation and before
the Tester validates the integrated checkout. Discover the actual manifest, lockfile,
package manager and installed toolchain. Cache successful preparation against the
manifest/lockfile digest, runtime version and workspace path.

Use the existing dependency trust policy. Prefer a lockfile-based installation when
supported; do not install while policy denies it. Distinguish an approval requirement,
registry/network failure and missing dependency from an application assertion failure.
Do not ask an implementation agent to rewrite working source for environment errors.
Serialize preparation for a shared checkout and never mutate a tested source revision.

Acceptance: a fresh worktree and the integrated checkout both run the same existing
dependency-based tests; denied installation produces actionable feedback; source and
dependency configuration remain unchanged during Tester validation.

### 2. Executable task contracts

Add backward-compatible acceptance criteria to planner task metadata: expected
behavior, inputs/outputs, validation scope and files the task may change. For example:
`GET /health returns 200 and { ok: true }` only if health is a requested contract.
Foundation validation must not require features assigned to later DAG tasks.
Ensure planned write scope includes tests and setup artifacts the task must create.

Acceptance: the implementation agent and Tester receive the same contract; legacy
plans still run; tests do not invent requirements absent from the task.

### 3. Evidence-based recovery routing

Promote current runner/tool evidence into structured recovery metadata, retaining
the existing top-level failure types for compatibility. Record command, exit status,
suspected category, concrete evidence, files inspected and repairs attempted.
Route environment failures to preparation, code failures to implementation, test
protocol failures to Tester-only retries, and merge conflicts to integration.

Allow a bounded, explicit replan request when evidence shows the task cannot be
completed inside its planned files or contract. The orchestrator must validate file
ownership and dependencies before accepting the request; a model must not silently
bypass scope restrictions. Persist the recovery summary across implementation retries.

Acceptance: successive attempts do not repeat the same unsuccessful approach without
new evidence, and failure reports identify which automated recovery was exhausted.

### 4. Resume and checkpoint support

Implemented in the subsequent save/resume change; see [resume.md](resume.md) for
usage, verified stage recovery and limits around in-flight commands. The paragraph
below records the original design objective.

Persist task state, plan version, validated commit, worktree identity and recovery
summary using atomic writes. Verify actual Git state before resuming. Explicitly
distinguish restarting the same run from creating a new project request, because
existing worktrees are currently reused by task ID. Do not delete existing worktrees
or overwrite branches automatically.

Acceptance: interruption during implementation, integration or testing can be resumed
without losing prior progress or replaying a completed stage against the wrong commit.

### 5. Measure reliability before changing models or budgets

Separate `test:unit`/offline workflow tests from live-model scripts. Add a fixed
evaluation set using disposable repositories: wrong route, missing module, invalid
script, Windows paths, malformed JSON, stale worktree and merge conflict.

Measure completion rate, recovery rate, repeated actions, command count, tokens and
elapsed time for each configured provider. Compare prompt/controller changes on the
same cases. A stronger fallback or larger budget should be an explicit configuration
decision backed by measured benefit, rather than a hidden provider change.

## Additional ideas

- A compact user-visible diagnostic timeline: observation → hypothesis → action →
  validation result. Display evidence and decisions, not a model's private reasoning.
- A small repository profile shared with Planner, implementers and Tester so each
  receives discovered tooling instead of inferring it independently.
- A final project-level acceptance run after the DAG finishes, complementing each
  task's post-integration validation.
- An uncertainty-driven inspection budget within the hard task budget: inspecting
  a new relevant file is useful work; repeating unchanged evidence is not.

Do not weaken tests, remove hard limits, silently broaden package trust, or declare
completion simply because a model claims it has finished.
