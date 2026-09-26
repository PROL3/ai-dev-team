import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgent } from "../../src/agents/implementation/run-agent.js";
import { WorkspaceManager } from "../../src/infrastructure/git/workspace-manager.js";
import { AgentTools } from "../../src/tools/agent-tools.js";

const execFileAsync = promisify(execFile);

type TestTask = {
  id: string;
  title: string;
  description: string;
  owner: "backend" | "frontend" | "tester";
  dependencies: string[];
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    shell: false,
  });
}

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-agent-"));

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "AI Agent Test"]);
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "a.txt"), "a\n", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "b\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);

  return root;
}

function task(id: string, owner: TestTask["owner"] = "backend"): TestTask {
  return {
    id,
    title: "Test agent execution",
    description: "Modify a test file and verify the result.",
    owner,
    dependencies: [],
  };
}

async function withWorkspace<T>(
  callback: (workspace: string, manager: WorkspaceManager) => Promise<T>,
): Promise<T> {
  const root = await createRepository();
  const manager = new WorkspaceManager(root);
  const workspace = await manager.createTaskWorkspace(`test-${Date.now()}-${Math.random()}`);

  try {
    return await callback(workspace.path, manager);
  } finally {
    await manager.removeTaskWorkspace(workspace);
  }
}

function answerQueue(answers: string[], prompts: string[]): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    prompts.push(prompt);
    const answer = answers.shift();

    if (!answer) {
      throw new Error("Test answer queue exhausted");
    }

    return answer;
  };
}

const read = (file: string) => JSON.stringify({ action: "read_file", path: file });
const write = (file: string, content: string) =>
  JSON.stringify({ action: "write_file", path: file, content });
const done = (summary: string) => JSON.stringify({ action: "done", summary });

async function testCompletesBeforeSoftLimit(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("before-soft"), workspace, undefined, {
      ask: answerQueue([write("result.txt", "done\n"), done("implemented")], []),
      budget: { softMaxSteps: 4, hardMaxSteps: 6 },
    });

    assert.equal(result.success, true);
    assert.equal(result.steps, 2);
  });
}

async function testSoftLimitAllowsFinalSteps(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const prompts: string[] = [];
    const result = await runAgent(task("after-soft"), workspace, undefined, {
      ask: answerQueue(
        [read("package.json"), write("result.txt", "done\n"), done("implemented")],
        prompts,
      ),
      budget: { softMaxSteps: 1, hardMaxSteps: 4 },
    });

    assert.equal(result.success, true);
    assert.equal(result.steps, 3);
    assert.equal(prompts[1]?.includes("You have reached the normal step budget"), true);
  });
}

async function testHardLimit(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("hard-limit"), workspace, undefined, {
      ask: answerQueue(["bad-1", "bad-2", "bad-3", "bad-4", "bad-5"], []),
      budget: { softMaxSteps: 2, hardMaxSteps: 5 },
    });

    assert.equal(result.success, false);
    assert.equal(result.steps, 5);
    assert.match(result.summary, /hard execution limit/);
  });
}

async function testRepeatedReadStopsEarly(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("repeat-read"), workspace, undefined, {
      ask: async () => read("package.json"),
      budget: { softMaxSteps: 2, hardMaxSteps: 20 },
    });

    assert.equal(result.success, false);
    assert.equal(result.steps, 4);
    assert.match(result.summary, /repeated the same action/);
  });
}

async function testReadsThenProgresses(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("read-then-write"), workspace, undefined, {
      ask: answerQueue(
        [
          read("package.json"),
          read("a.txt"),
          read("b.txt"),
          write("result.txt", "done\n"),
          done("implemented"),
        ],
        [],
      ),
      budget: { softMaxSteps: 2, hardMaxSteps: 8 },
    });

    assert.equal(result.success, true);
    assert.equal(result.steps, 5);
    assert.ok(result.audit.some((entry) => entry.progress));
  });
}

async function testRetryPreservesWorkspace(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const first = await runAgent(task("retry-preserve"), workspace, undefined, {
      ask: answerQueue(
        [write("preserved.txt", "keep me\n"), "not json", "not json", "not json", "not json"],
        [],
      ),
      budget: { softMaxSteps: 2, hardMaxSteps: 8 },
    });

    assert.equal(first.success, false);
    assert.ok(first.changedFiles.includes("preserved.txt"));

    const second = await runAgent(task("retry-preserve"), workspace, undefined, {
      ask: async () => done("continued from existing workspace"),
      budget: { softMaxSteps: 2, hardMaxSteps: 4 },
    });

    assert.equal(second.success, true);
    assert.equal(second.changedFiles.includes("preserved.txt"), true);
    assert.equal(await fs.readFile(path.join(workspace, "preserved.txt"), "utf8"), "keep me\n");
  });
}

async function testAbsoluteWorkspacePathAndWrappedJson(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const absoluteTarget = path.join(workspace, "absolute.txt");
    const result = await runAgent(task("absolute-path"), workspace, undefined, {
      ask: answerQueue(
        [
          `Here is the action:\n${write(absoluteTarget, "safe\n")}\nProceed.`,
          `Result:\n${done("implemented")}`,
        ],
        [],
      ),
      budget: { softMaxSteps: 3, hardMaxSteps: 6 },
    });

    assert.equal(result.success, true);
    assert.equal(await fs.readFile(absoluteTarget, "utf8"), "safe\n");
  });
}

async function testRepeatedFailedActionStopsEarly(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("failed-read"), workspace, undefined, {
      ask: async () => read("missing-file.txt"),
      budget: { softMaxSteps: 2, hardMaxSteps: 20 },
    });

    assert.equal(result.success, false);
    assert.equal(result.steps, 3);
    assert.match(result.summary, /repeated a failed action/);
  });
}

async function testRepeatedDoneStopsEarly(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("repeated-done"), workspace, undefined, {
      ask: async () => done("nothing changed"),
      budget: { softMaxSteps: 2, hardMaxSteps: 20 },
    });

    assert.equal(result.success, false);
    assert.equal(result.steps, 4);
    assert.match(result.summary, /repeatedly returned done/);
  });
}

async function testWriteFileReportsStructuredSuccess(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const tools = new AgentTools({ role: "backend", workspacePath: workspace });
    const result = await tools.writeFile("result.txt", "written\n");

    assert.equal(result.action, "write_file");
    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.contentChanged, true);
    assert.equal(result.verified, true);
    assert.match(result.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), "written\n");
  });
}

async function testTesterCanWriteOnlyExplicitlyPlannedFiles(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const tools = new AgentTools({
      role: "tester",
      workspacePath: workspace,
      allowedPaths: ["src/tests/allowed.test.ts"],
    });

    await tools.writeFile("src/tests/allowed.test.ts", "export {};\n");
    assert.equal(
      await fs.readFile(path.join(workspace, "src/tests/allowed.test.ts"), "utf8"),
      "export {};\n",
    );

    await assert.rejects(
      () => tools.writeFile("src/server.ts", "export {};\n"),
      /outside this task's planned files/,
    );

    const unscopedTools = new AgentTools({ role: "tester", workspacePath: workspace });
    await assert.rejects(
      () => unscopedTools.writeFile("src/tests/unplanned.test.ts", "export {};\n"),
      /read-only unless the task explicitly lists/i,
    );
  });
}

async function testIdenticalWriteIsCorrectedWithoutRewriting(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const prompts: string[] = [];
    const result = await runAgent(task("identical-write"), workspace, undefined, {
      ask: answerQueue(
        [
          write("result.txt", "first version\n"),
          write("result.txt", "first version\n"),
          done("Implemented the result file."),
        ],
        prompts,
      ),
      budget: { softMaxSteps: 4, hardMaxSteps: 6 },
    });

    assert.equal(result.success, true);
    assert.equal(result.steps, 3);
    assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), "first version\n");
    assert.match(result.audit[1]?.output ?? "", /already written successfully/i);
    assert.match(prompts[2] ?? "", /already written successfully/i);
  });
}

async function testDifferentSecondWriteIsAllowed(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(task("different-write"), workspace, undefined, {
      ask: answerQueue(
        [
          write("result.txt", "first version\n"),
          write("result.txt", "final version\n"),
          done("Implemented the final result file."),
        ],
        [],
      ),
      budget: { softMaxSteps: 4, hardMaxSteps: 6 },
    });

    assert.equal(result.success, true);
    assert.equal(
      result.audit.filter((entry) => entry.action === "write_file" && entry.progress).length,
      2,
    );
    assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), "final version\n");
  });
}

async function testConsecutiveSamePathWriteIsWarnedWithoutBlockingExecution(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const prompts: string[] = [];
    const result = await runAgent(task("same-path-write-loop"), workspace, undefined, {
      ask: answerQueue(
        [
          write("result.txt", "first version\n"),
          write("result.txt", "second version\n"),
          done("Implemented after stopping the rewrite loop."),
        ],
        prompts,
      ),
      budget: { softMaxSteps: 4, hardMaxSteps: 6 },
    });

    assert.equal(result.success, true);
    assert.equal(
      result.audit.filter(
        (entry) =>
          entry.action === "write_file" && entry.output.includes("already updated this file"),
      ).length,
      1,
    );
    assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), "second version\n");
    assert.match(prompts[2] ?? "", /already updated this file/i);
  });
}

async function testDuplicatePlannedWriteFinishesInsteadOfFailing(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = await runAgent(
      { ...task("duplicate-planned-write"), files: ["result.txt"] },
      workspace,
      undefined,
      {
        ask: answerQueue(
          [write("result.txt", "implemented\n"), write("result.txt", "implemented\n")],
          [],
        ),
        budget: { softMaxSteps: 3, hardMaxSteps: 5 },
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.steps, 2);
    assert.match(result.summary, /Ignored duplicate write request/);
    assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), "implemented\n");
  });
}

async function testRetryContextCallsOutPreviousWriteLoop(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const prompts: string[] = [];
    await fs.writeFile(path.join(workspace, "result.txt"), "existing change\n", "utf8");
    const result = await runAgent(
      task("retry-context"),
      workspace,
      {
        attempt: 4,
        previousChangedFiles: ["result.txt"],
        previousOutput: "The previous attempt repeatedly rewrote result.txt.",
        previousError: "Repeated write_file action for result.txt.",
      },
      {
        ask: answerQueue([done("Completed using the existing change.")], prompts),
        budget: { softMaxSteps: 2, hardMaxSteps: 4 },
      },
    );

    assert.equal(result.success, true);
    assert.match(prompts[0] ?? "", /ATTEMPT NUMBER:\s*4/);
    assert.match(prompts[0] ?? "", /PREVIOUS ATTEMPT CHANGED FILES:\s*result.txt/);
    assert.match(prompts[0] ?? "", /Fix the previous failure instead of repeating it/);
    assert.match(prompts[0] ?? "", /The previous attempt repeatedly rewrote result.txt/);
  });
}

async function main() {
  await testCompletesBeforeSoftLimit();
  await testWriteFileReportsStructuredSuccess();
  await testTesterCanWriteOnlyExplicitlyPlannedFiles();
  await testSoftLimitAllowsFinalSteps();
  await testHardLimit();
  await testRepeatedReadStopsEarly();
  await testReadsThenProgresses();
  await testRetryPreservesWorkspace();
  await testAbsoluteWorkspacePathAndWrappedJson();
  await testRepeatedFailedActionStopsEarly();
  await testRepeatedDoneStopsEarly();
  await testIdenticalWriteIsCorrectedWithoutRewriting();
  await testDifferentSecondWriteIsAllowed();
  await testConsecutiveSamePathWriteIsWarnedWithoutBlockingExecution();
  await testDuplicatePlannedWriteFinishesInsteadOfFailing();
  await testRetryContextCallsOutPreviousWriteLoop();
  console.log("Agent budget tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
