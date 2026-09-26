# Simple directory-owned agents

Each implementation task has one outcome and an explicit write scope in `files`.
List a directory (for example `backend/` or `public/`) to allow the agent to create
and edit any files/subdirectories beneath it. List shared root files individually.
Creating a directory outside this scope does not grant ownership of it.

The Planner now requests a small plan: working foundation/setup, then cohesive
backend and frontend tasks using the agreed module/API contract. Directory scopes
replace exhaustive lists of every file an agent might need. Foundation owns shared
configuration. Required shared edits are ordered by dependencies.

The runtime normalizes overlapping scopes (including case, separators and dot
segments) and never dispatches overlapping scopes together. New Planner output
receives dependency edges for shared paths, preserving existing dependency
direction. Truly separate directories still run in parallel. Legacy tasks without
a defined scope run exclusively because their write footprint is unknown.

The implementation prompt contains the goal, ownership, contract, tool protocol,
current evidence and a short inspect/implement/check workflow. Existing hard
budgets, structured recovery, dependency approval, worktrees, serial integration,
post-integration Tester and resume remain in place. The write tool refuses to
follow directory/file links; command execution is still not an OS security sandbox.

Old checkpoints keep their saved plans and scopes; resume does not silently expand
their permissions or rerun Planner. Directory ownership applies when the plan lists
directories. Directory-owned tasks can keep tests in their own folder. The existing
additional test grant remains available for compatibility with saved agent sessions.
No automatic migration or deletion of existing project files is performed.

## Observe before deciding

The existing implementation loop now prepares a bounded, read-only workspace
snapshot before its first model call: observed paths, missing planned files,
owned source excerpts, package scripts/module type/declared dependencies, and
the assigned test directory's actual state. Existing Node tests and supported
package scripts are surfaced as *unexecuted candidates*, never as passing tests.
Nested package scripts retain their working directory; task scope still determines
which checks are relevant. No dependencies are installed during preparation.

The loop follows observe -> decide -> execute -> observe again. Successful writes,
commands and failed tool calls refresh the snapshot before the next decision.
On resume it is rebuilt from disk, rather than trusting a stale saved snapshot.
Current failures and actual tool results remain in the existing checkpointed audit;
preparation does not spend model steps, reset retry counters or expand permissions.
Progress metadata is logged under `agent.context`, without dumping source content.

Automatic inspection skips links, common secret files, dependencies and build
artifacts, and bounds directory enumeration, path counts and file reads. Partial
observations are explicitly marked: the model can request more with existing tools.
It does not treat repository contents as new instructions. This is a context stage
inside the existing runner, not a replacement DAG, Planner, LLM gateway or Tester.
Tool prompts describe field types instead of showing actions with imaginary paths.

Regressions in `tests/agents/agent-context.test.ts` cover fresh preparation, repair
within one attempt, context refresh, resume, malformed manifests, blocked directory
layouts, nested projects, bounded reads, and secret/link exclusions. Scripted model
responses verify the mechanism; they do not guarantee a provider's decisions.

## Validation before file writes

`write_file` rejects Markdown code fences at the start of JavaScript, TypeScript
and JSON/JSONC payloads. `package.json` must also be a strict JSON object with
valid script strings. Rejection happens before creating parent directories or
replacing the previous file. Valid content is stored exactly as provided, without
silently stripping fences or rewriting the model's output. Markdown documentation
and JSONC configuration files retain their existing behavior.

An explicitly declared directory (`backend/`, for example) or the assigned test
directory cannot be written as a regular file. The agent must choose a filename
inside it; parent directories are created automatically. Existing directories and
files that obstruct a parent directory receive specific errors. Existing damaged
files are preserved, not automatically renamed, deleted or migrated on resume.

Diagnosis fields reject literal prompt placeholders such as `cause` and
`observed fact`. The same rule applies to scope-recovery decisions. Existing
retry/step budgets still apply; invalid diagnoses do not count as successful
actions. This checks the response format, not the truth of a model's diagnosis.

These guards prevent the reported formatting and path-layout failures. They do
not prove arbitrary source code is syntactically or functionally correct; actual
validation and the post-integration Tester remain necessary. Command execution
has its existing permissions and is not covered by `write_file` preflight checks.

Focused regressions (scripted model responses, real file and Node test execution):

```powershell
npx tsx --test tests/tools/write-validation.test.ts tests/agents/agent-write-recovery.test.ts
```
