# Save and resume a workflow

CLI workflows now save automatically after planning, before/after task stages,
after each implementation result (including parallel agents), and at each agent
step boundary. Existing library callers remain non-persistent unless they pass
`checkpointPath`.

Start a new run:

```powershell
npm start -- "C:\Users\liav\Documents\fs-project\test-self-agent" "Build the application"
```

Continue that run after an interruption:

```powershell
npm start -- "C:\Users\liav\Documents\fs-project\test-self-agent" --resume
```

To explicitly grant failed tasks one more implementation attempt:

```powershell
npm start -- "C:\Users\liav\Documents\fs-project\test-self-agent" --resume --retry-failed
```

This preserves attempt history and failure feedback, grants one more implementation
and Tester attempt and up to two more Code Review executions, and skips completed
tasks. It does not resolve merge conflicts or bypass
checks for a changed/dirty main checkout. Ordinary `--resume` never renews budgets.
If a failed task's directory still exists but its `.git` file is missing, this
option creates a new recovery branch/worktree at the saved commit and copies the
remaining files, preserving deletions. The original directory is left untouched.
`node_modules` is not copied; dependencies may need installation under the existing
approval policy. Missing source directories, links, existing damaged Git metadata,
and missing saved commits require manual recovery. Recovery paths appear in logs.
No real model request is made until verification and checkpoint restoration succeed.

The existing full-dispatch entrypoint supports the same option:

```powershell
npm start -- "C:\Users\liav\Documents\fs-project\test-self-agent" --resume
```

`--resume` loads the saved plan without calling Planner again. Do not supply a new
request with this option. A new run refuses to overwrite an existing checkpoint.

## Saved state

The file is stored alongside the project, outside its Git checkout:
`<project-parent>/.ai-dev-runs/<project-name>/checkpoint.json`.

It contains the versioned plan, run ID, project identity, tasks and DAG statuses,
retry counters, worktree/branch/commit identities, completed agent results, Code
Review findings/approval revisions and cumulative paths, Tester feedback and the
active agent's tool history, diagnosis and remaining step budget.
It does not serialize process environment variables or provider configuration.
Tool history can contain inspected file contents, so treat the checkpoint as
project data, including any sensitive content the agent inspected.

Writes are serialized and use a temporary file, file synchronization and atomic
replacement. An invalid or failed save leaves the previous checkpoint intact.
A process lock prevents two runs using the same checkpoint; a well-formed lock
from an exited local process is reclaimed automatically. Unknown/foreign or
unreadable locks require inspection rather than automatic deletion.

## Resume behavior

| Saved stage | Continuation |
| --- | --- |
| Completed task | Skip; preserve its validation and dependency completion |
| Implementation interrupted | Same worktree and task attempt, saved tool evidence and remaining budget |
| Implementation result saved | Author scoped tests if enabled, then integrate without invoking Coder again |
| Test authoring interrupted | Resume the saved draft/attempt budget; replay identical bytes without overwriting other files |
| Integration interrupted | Inspect actual Git state; continue integration or recognize the completed merge |
| Integrated / Tester interrupted | Run functional validation; Reviewer cannot run until Tester passes |
| Tester passed / Code Review interrupted | Reuse PASS for the same integrated commit and continue Review |
| Code Review approved | Complete the task using the saved Tester and Reviewer evidence |
| Permanently failed / integration conflict | Preserve the failure and counters; report the unresolved condition |

Before continuing, the runtime verifies repository identity, checked-out branches,
worktree HEADs, completed commit ancestry and unfinished Git operations. Unexpected
main changes, missing worktrees, dirty main or ambiguous integration state stop
resume with an actionable error. Source files and branches are never reset or
deleted to force recovery.

There is no exactly-once guarantee for a command active at the instant of process
termination. Its side effects may exist before the next checkpoint was written.
The resumed agent is instructed to inspect actual files; interrupted validation may
run again. Git's completed-merge window is reconciled using the main commit's two
parents and task branch HEAD. A cut-off LLM response is requested again, not restored
token-by-token. A power/OS failure also depends on the underlying filesystem's
durability guarantees.

Only runs created with this version have resumable checkpoints. Old worktrees alone
cannot reconstruct the original plan or successful validation. Resume does not reset
exhausted retries or turn a permanently failed workflow into a fresh attempt.

## Library use

```ts
const checkpointPath = defaultCheckpointPath(projectRoot);
const workflow = new Orchestrator(plan, { projectRoot, checkpointPath });
await workflow.runUntilComplete();

const resumed = await Orchestrator.resume(projectRoot);
await resumed.runUntilComplete();
```

Custom executors must be supplied again when resuming; functions are not serialized.
For step-level checkpoints they should honor `context.resumeSession` and call
`context.onCheckpoint`, as the standard `executeTask` already does. Otherwise their
interrupted implementation restarts in its preserved worktree. Do not change Tester
or Code Review/test-authoring enablement when resuming. Older checkpoints without
review/authoring fields continue with those stages disabled. Unfinished older
review-before-test runs invalidate premature review approval and switch to the
Tester-first sequence. Checkpointed workflows use `runUntilComplete()` to own the
lock; the older manual scheduling API remains available for non-persistent callers.
