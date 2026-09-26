import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authorTests, readAuthorSource, testExecutionProfile } from "../../src/agents/tester/author-tests.js";
import { testerTestDirectory, sameTestContent } from "../../src/domain/test-authoring.js";
import { AgentTools } from "../../src/tools/agent-tools.js";
import { runTester } from "../../src/agents/tester/run-tester.js";

test("author receives actual source and can return test content only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "test-author-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "value.js"), "export const value = 42;");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_TEST_TOKEN=do-not-send");
  const request = {
    task: { id: "feature", title: "Feature", description: "Return 42", owner: "backend" as const, dependencies: [], files: ["value.js"] },
    workspacePath: root, changedFiles: ["value.js", ".env"],
    testPath: "tests/feature.test.mjs", framework: "node" as const, previousTests: [],
  };
  const result = await authorTests(request, { ask: async (prompt) => {
    assert.match(prompt, /export const value = 42/);
    assert.match(prompt, /empty, invalid, boundary/);
    assert.doesNotMatch(prompt, /PRIVATE_TEST_TOKEN|do-not-send/);
    return JSON.stringify({ summary: "Test the real value", content: "import 'node:test';" });
  } });
  assert.equal(result.content, "import 'node:test';");
  assert.deepEqual((await fs.readdir(root)).sort(), [".env", "package.json", "value.js"]);
  await assert.rejects(authorTests(request, { ask: async () => JSON.stringify({ ...result, path: "value.js" }) }));
  await assert.rejects(readAuthorSource(root, "../outside.js"));
  await assert.rejects(readAuthorSource(root, ".env"));
});

test("test location avoids another owner's scope and profile uses installed project frameworks", () => {
  assert.equal(sameTestContent("assert.equal(value,42);\r\n", "assert.equal(value,42);\n"), true);
  assert.equal(sameTestContent("assert.equal(value,0);\r\n", "assert.equal(value,42);\n"), false);
  const task = { id: "api", title: "API", description: "API", owner: "backend" as const, dependencies: [], files: ["src/"] };
  const other = { ...task, id: "shared-tests", files: ["tests/"] };
  assert.match(testerTestDirectory(task, [task, other]), /^src\/__tests__\/tester-/);
  assert.throws(() => testerTestDirectory({ ...task, files: ["src/api.js"] }, [{ ...task, files: ["src/api.js"] }, other]));
  for (const framework of ["jest", "vitest"] as const) {
    const profile = testExecutionProfile(JSON.stringify({ devDependencies: { [framework]: "installed" }, scripts: { test: framework } }), "tests/feature", 2);
    assert.equal(profile.framework, framework);
    assert.equal(profile.command.command, "node");
    assert.ok(profile.command.args.includes(profile.path));
  }
  const node = testExecutionProfile('{"devDependencies":{"tsx":"installed"}}', "tests/feature", 1);
  assert.deepEqual(node.command.args, ["--import", "tsx", "--test", node.path]);
  assert.throws(() => testExecutionProfile("null", "tests/feature", 1), /JSON object/);
});

test("Tester explicitly runs authored tests even when npm's script does not discover them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "authored-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"node existing.cjs"}}');
  await fs.writeFile(path.join(root, "existing.cjs"), "console.log('existing validation');");
  const file = "independent.test.mjs";
  const content = "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('regression',()=>assert.equal(0,42));";
  await fs.writeFile(path.join(root, file), content);
  const result = await runTester({
    task: { id: "feature", title: "Feature", description: "Return 42" }, workspacePath: root,
    changedFiles: [file], previousAgentSummary: "Implemented",
    testerTests: [{ path: file, content, command: { command: "node", args: ["--test", file] } }],
  }, { ask: async () => assert.fail("A failing test must bypass model interpretation") });
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /42/);
  assert.deepEqual(result.testsRun, [`node --test ${file}`]);
  const tools = new AgentTools({ role: "tester", workspacePath: root, allowedPaths: [file] });
  await assert.rejects(tools.writeFile("existing.cjs", "overwritten"), /NOT in your allowed/);
});
