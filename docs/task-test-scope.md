# Task-owned test files

The orchestrator supplies the saved plan to implementation execution. Backend and
frontend tasks with explicit file lists receive an additional deterministic
`tests/agent/<task-slug>-<task-id-hash>/` write scope. This does not mutate the plan,
checkpoint schema, source-file permissions, or the dedicated Tester's read-only role.
The path is stable across retries and resume.

No grant is issued when another planned task owns an overlapping path (including
a broad `tests` directory), or another task has unrestricted file scope. Future
and completed tasks count as owners, not just currently running tasks. Separate
task directories allow parallel execution without sharing test files. Calls without
the full plan retain their previous permissions.

The prompt explains that the directory is authorized for creation, requires source
and framework inspection, and redirects blocked generic test writes to this scope.
Tests must be run by their exact paths. Shared package test scripts must not be
replaced with a single task's test, or pointed at a file before it exists and has
been validated. These behavior instructions are not a guarantee of model compliance.
The actual write scope is enforced by tools, including traversal and link checks
for the additional directory. As before, permitted command execution is not an OS
sandbox for arbitrary code contained in project scripts.

This change does not automatically approve a conflicting path or install a test
framework. If no safe test scope can be granted, the agent must report the missing
scope; human approval/planning changes are still required. The dedicated Tester
continues to validate the integrated project after successful integration.

## Recovery from ignored scope errors

Write failures retain their actual error text in working memory. Denied paths and
the latest scope error remain pinned even after later successful writes. Generated
source is not echoed as the next tool instruction; the agent must inspect the real
file instead of copying its previous write from history.

After two scope failures for the same normalized path, the runner switches from
the general action prompt to a compact recovery decision protocol. The response
must contain a diagnosis, observed evidence and one investigative/corrective action.
The runner rejects completion, diagnosis-only actions and previously denied writes
at this stage. Selected actions still pass ordinary tool permissions and command
validation; the protocol does not grant permissions or reset retry/step limits.
Two invalid recovery decisions stop the attempt with an explicit recovery failure.
Recovery state is derived from the persisted audit and survives resume.

This is a bounded recovery opportunity, not a guarantee that a model will reason
correctly. The diagnosis is model-provided, not independent validation. Tests use
scripted model responses plus actual Node test execution, without provider calls.
