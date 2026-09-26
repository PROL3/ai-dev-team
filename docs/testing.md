# Testing

## Offline regression suite

```sh
npm run build
npm test
```

`build` runs TypeScript with `--noEmit` over `src/`, `tests/` and `scripts/`.
`test` discovers `tests/**/*.test.ts`, including new nested test files. Tests use
scripted model responses or injected executors. They exercise real filesystem,
Node child-process and Git behavior in temporary directories without making model
requests. Git and npm must be available on the machine.

| Directory | Coverage |
| --- | --- |
| `tests/agents/` | Agent budgets, context, write scope, retry/recovery and task execution |
| `tests/planner/` | Plan validation, dependency ordering and malformed-plan recovery |
| `tests/tester/` | Test authoring scope, explicit test execution, validation evidence and tester-only retries |
| `tests/code-review/` | Committed diff evidence, finding validation, incomplete coverage and cumulative repairs |
| `tests/workflow/` | Git integration, conflicts, hardening, checkpoints and resume |
| `tests/tools/` | Dependency installation policy and file-write validation |
| `tests/llm/` | Provider selection, without provider requests |
| `tests/logging/` | Progress-log behavior |

Run a focused group or one file from the repository root:

```sh
npx tsx --test tests/planner/*.test.ts
npx tsx --test tests/agents/agent-write-recovery.test.ts
npx tsx --test tests/tester/test-authoring.test.ts tests/workflow/workflow-tester-review-loop.test.ts tests/workflow/workflow-code-review.test.ts
```

Some retained regression files use an assertion-based `main()` function; Node's
test runner treats each such file as one test. The rest use individual `node:test`
cases. Do not interpret the reported count as the total number of assertions.

Interactive and live-provider examples were removed from the repository. Use
`npm start -- "../target" "Your request"` for a real workflow and keep all
deterministic checks under `tests/`.

## Refactor verification

Before reorganization, the offline suite reported 111 passing tests and one
failure: a retry test supplied attempt `4` but asserted `2`. The initial type check
also found an optional `files` access in a test. The refactor corrects those two
test expectations/type guards without changing production behavior.

After reorganization and import cleanup, all 112 tests pass. Type checking also
passes with `--noUnusedLocals --noUnusedParameters`. A structural comparison
confirmed unchanged model instruction text, checkpoint schemas, dependency
lockfile, 93 extracted declarations and the bodies of all 20 workflow methods
after substituting their explicit runtime argument. Relative imports resolve,
and the application has no cycles between runtime module imports.

When changing structure, keep the same regression scenarios and compare against
the baseline. Checkpoint/resume tests are especially important: saved runs must
retain their plan, stages, tool evidence and remaining budgets after code moves.
