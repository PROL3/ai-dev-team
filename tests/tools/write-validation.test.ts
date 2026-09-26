import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTools } from "../../src/tools/agent-tools.js";
import { FileWriteValidationError } from "../../src/tools/filesystem/write-validation.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "write-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("invalid package payloads never replace the previous valid manifest", async (t) => {
  const root = await fixture(t);
  const original = '{"name":"preserve-me","scripts":{"test":"node --test"}}';
  await fs.writeFile(path.join(root, "package.json"), original);
  const tools = new AgentTools({ role: "backend", workspacePath: root });
  for (const content of [
    '```json\n{"name":"broken"}\n```',
    '{"name":',
    "[]",
    "null",
    '"not an object"',
    '{"scripts":[]}',
    '{"scripts":{"test":42}}',
    '{"scripts":{"test":" "}}',
  ]) {
    await assert.rejects(tools.writeFile("package.json", content), (error: unknown) => {
      assert.ok(error instanceof FileWriteValidationError);
      assert.match(error.message, /Nothing was written/);
      return true;
    });
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), original);
  }
});

test("valid raw package content is saved exactly and identical writes remain unchanged", async (t) => {
  const root = await fixture(t);
  const tools = new AgentTools({ role: "backend", workspacePath: root });
  const content = '{\n  "name": "example", "scripts": { "test": "node --test" }\n}\n';
  const written = await tools.writeFile("package.json", content);
  assert.equal(written.contentChanged, true);
  assert.equal(written.verified, true);
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), content);
  const unchanged = await tools.writeFile("package.json", content);
  assert.equal(unchanged.contentChanged, false);
  assert.equal(unchanged.contentHash, written.contentHash);
  // Script cycles remain the existing command validation layer's responsibility.
  assert.equal(
    (await tools.writeFile("package.json", '{"scripts":{"test":"npm test"}}')).success,
    true,
  );
});

test("rejected new files do not even create their parent directories", async (t) => {
  const root = await fixture(t);
  const tools = new AgentTools({ role: "backend", workspacePath: root });
  await assert.rejects(
    tools.writeFile("backend/nested/package.json", "not JSON"),
    /Invalid package.json content/,
  );
  await assert.rejects(fs.stat(path.join(root, "backend")), { code: "ENOENT" });
});

test("source code fences are rejected but Markdown documents and embedded fences are preserved", async (t) => {
  const root = await fixture(t);
  const tools = new AgentTools({ role: "backend", workspacePath: root });
  for (const extension of ["js", "cjs", "mjs", "jsx", "ts", "tsx", "cts", "mts", "json", "jsonc"]) {
    const file = `source.${extension}`;
    await fs.writeFile(path.join(root, file), "preserve this content");
    await assert.rejects(
      tools.writeFile(file, " \n```javascript\nexport const ready = true;\n```"),
      /Markdown code fence/,
    );
    await assert.rejects(
      tools.writeFile(file, "~~~javascript\nexport const ready = true;\n~~~"),
      /Markdown code fence/,
    );
    assert.equal(await fs.readFile(path.join(root, file), "utf8"), "preserve this content");
  }
  for (const [file, content] of [
    ["README.md", "```js\nconst ready = true;\n```"],
    ["example.js", 'const documentation = "```json";\n'],
    ["tsconfig.json", '{\n// valid JSONC config\n"compilerOptions": {}\n}'],
  ] as const) {
    assert.equal((await tools.writeFile(file, content)).success, true);
    assert.equal(await fs.readFile(path.join(root, file), "utf8"), content);
  }
});

test("assigned test directory cannot become a regular file, including normalized paths", async (t) => {
  const root = await fixture(t);
  const directory = "tests/agent/foundation";
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: ["package.json", directory],
    assignedTestDirectory: directory,
  });
  for (const target of [
    directory,
    `./${directory}`,
    `${directory}/.`,
    `${directory}/`,
    `tests/agent/unused/../foundation`,
  ]) {
    await assert.rejects(tools.writeFile(target, "test content"), /directory target, not a file/);
    await assert.rejects(fs.stat(path.join(root, directory)), { code: "ENOENT" });
  }
  if (process.platform === "win32") {
    await assert.rejects(
      tools.writeFile(directory.replaceAll("/", "\\"), "test content"),
      /directory target, not a file/,
    );
  }
  const child = `${directory}/foundation.test.cjs`;
  assert.equal((await tools.writeFile(child, "require('node:test');")).success, true);
  assert.equal((await fs.stat(path.join(root, directory))).isDirectory(), true);
  await assert.rejects(tools.writeFile("tests/another-task.test.cjs", "no"), /outside this task/);
});

test("planned directories retain recursive writes but reject a write to the directory itself", async (t) => {
  const root = await fixture(t);
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: ["backend/"],
  });
  await assert.rejects(tools.writeFile("backend", "wrong"), /directory target, not a file/);
  assert.equal(
    (await tools.writeFile("backend/lib/service.cjs", "exports.ready = true;")).success,
    true,
  );
  await assert.rejects(tools.writeFile("backend/lib", "wrong"), /already exists as a directory/);
  assert.equal(
    await fs.readFile(path.join(root, "backend/lib/service.cjs"), "utf8"),
    "exports.ready = true;",
  );
});

test("existing corrupt file at an assigned directory is reported precisely and never overwritten", async (t) => {
  const root = await fixture(t);
  const directory = "tests/agent/foundation";
  const original = "```javascript\ncorrupt old generated file\n```";
  await fs.mkdir(path.join(root, "tests/agent"), { recursive: true });
  await fs.writeFile(path.join(root, directory), original);
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    allowedPaths: [directory],
    assignedTestDirectory: directory,
  });
  await assert.rejects(tools.writeFile(directory, "replacement"), /directory target, not a file/);
  await assert.rejects(
    tools.writeFile(`${directory}/test.cjs`, "require('node:test');"),
    /parent .* is an existing file, not a directory/,
  );
  assert.equal(await fs.readFile(path.join(root, directory), "utf8"), original);
});

test("directory checks also work for unrestricted legacy tasks and keep tester read-only", async (t) => {
  const root = await fixture(t);
  const directory = "task-tests";
  const tools = new AgentTools({
    role: "backend",
    workspacePath: root,
    assignedTestDirectory: directory,
  });
  await assert.rejects(
    tools.writeFile(path.join(root, directory), "wrong"),
    /directory target, not a file/,
  );
  await assert.rejects(tools.writeFile(".", "wrong"), /directory target, not a file/);
  await assert.rejects(tools.writeFile("new-directory/", "wrong"), /directory target, not a file/);
  assert.equal((await tools.writeFile("legacy.txt", "valid legacy write")).success, true);
  const tester = new AgentTools({ role: "tester", workspacePath: root });
  await assert.rejects(tester.writeFile("package.json", "{}"), /read-only/);
});
