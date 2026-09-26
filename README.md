# AI Dev Team

App that turns a request into a dependency-ordered plan, implements
tasks in isolated Git worktrees, has a Tester author and run functional tests,
and sends passing changes to a dedicated Code Review agent. A failed test or
blocking review returns to the Coder; every repair must pass the Tester again.
Runs can save checkpoints and resume after interruption.

## Getting started

Use Node.js 24 or later, npm, and Git. Run commands from this repository's root.

```sh
npm ci
```

Copy `.env.example` to `.env` if you do not already have one, then configure the
provider and credentials you use. Provider selection and fallback behavior are
described in [the architecture guide](docs/architecture.md#llm-providers).

Start a workflow against a **separate target project directory**:

```sh
npm start -- "../my-application" "Build a small task management application"
```

The target checkout uses the `main` branch. Workflow execution creates task
branches/worktrees and commits/integrates generated changes in that target
project. Continue a saved workflow with:

```sh
npm start -- "../my-application" --resume
```

See [save and resume](docs/resume.md) for checkpoint locations, retrying failed
tasks, and recovery rules.

## Repository layout

```text
src/
  index.ts                  CLI entrypoint
  cli/                      Command-line argument parsing
  domain/                   Plans, schemas, task scheduling and ownership rules
  agents/
    planner/                Planning prompt, response parsing and repair attempts
    implementation/         Agent loop, tools protocol, evidence and recovery
    code-review/            Diff-based review, evidence validation and structured findings
    tester/                 Independent test authoring and functional validation
  workflow/                 Dispatch, integration, validation, checkpoints and resume
  tools/
    agent-tools.ts          Agent-facing tool facade
    filesystem/             Workspace paths, write scope and content validation
    commands/               Process execution, npm checks and dependency policy
  infrastructure/
    git/                    Worktrees, commits, integration and checkout verification
    llm/                    Model clients, provider selection and fallback
    persistence/            Checkpoint storage and locking
    logging/                Bounded operational progress logs
tests/                      Offline regression tests grouped by subsystem
docs/                       Architecture, testing and workflow behavior guides
```

For a first read, follow `src/index.ts` → `src/workflow/orchestrator.ts` →
`src/workflow/execution.ts` → `src/workflow/dispatch.ts`. Then follow
`src/agents/implementation/run-agent.ts` for the agent's decision loop.
The [architecture guide](docs/architecture.md) maps the individual stages and
explains where to put new code.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check application code and regression tests; emits no files |
| `npm test` | Run all offline regression tests; no model requests |
| `npm run test:agent-failure` | Run scripted agent failure/recovery checks |
| `npm run test:orchestration` | Run Git orchestration checks in temporary repositories |

See [testing](docs/testing.md) for focused tests.

## Behavior guides

- [Directory ownership and workspace observations](docs/simple-agents.md)
- [Task-owned test files and scope recovery](docs/task-test-scope.md)
- [Code Review method, findings, retries and evidence limits](docs/code-review.md)
- [Coder → Tester → Reviewer loop and test ownership](docs/tester-review-loop.md)
- [Save and resume](docs/resume.md)
- [Reliability design history and future work](docs/reliability-plan.md)

Runtime worktrees and checkpoints are project data, not application source.
Keep `.env`, dependency directories, and generated worktrees out of source control.
