import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSafeNpmInstallArgs,
  resolveDependencyInstallPolicy,
  SAFE_NPM_INSTALL_ARGS,
} from "../../src/tools/commands/dependency-install-policy.js";
import { AgentTools } from "../../src/tools/agent-tools.js";

const manifest = JSON.stringify({
  dependencies: { express: "^4.21.2" },
  devDependencies: { typescript: "5.8.3" },
});

test("dependency installation is denied by default", () => {
  assert.equal(resolveDependencyInstallPolicy({}), "deny");
  assert.throws(() => getSafeNpmInstallArgs(manifest, {}), /Dependency installation is disabled/);
});

test("allow installs only an explicit direct-dependency allowlist", () => {
  const environment = {
    DEPENDENCY_INSTALL_POLICY: "allow",
    DEPENDENCY_ALLOWLIST: "express, typescript",
  };
  assert.deepEqual(getSafeNpmInstallArgs(manifest, environment), SAFE_NPM_INSTALL_ARGS);
  assert.throws(
    () =>
      getSafeNpmInstallArgs(manifest, {
        DEPENDENCY_INSTALL_POLICY: "allow",
        DEPENDENCY_ALLOWLIST: "express",
      }),
    /Dependencies not present.*typescript/,
  );
});

test("always-trust permits only direct registry-semver dependencies", () => {
  assert.deepEqual(
    getSafeNpmInstallArgs(manifest, { DEPENDENCY_INSTALL_POLICY: "always-trust" }),
    SAFE_NPM_INSTALL_ARGS,
  );
  assert.throws(
    () =>
      getSafeNpmInstallArgs(JSON.stringify({ dependencies: { exploit: "file:../exploit" } }), {
        DEPENDENCY_INSTALL_POLICY: "always-trust",
      }),
    /ordinary registry semver/,
  );
});

test("unknown install policy and empty manifests fail closed", () => {
  assert.throws(
    () => resolveDependencyInstallPolicy({ DEPENDENCY_INSTALL_POLICY: "yes" }),
    /must be deny/,
  );
  assert.throws(
    () => getSafeNpmInstallArgs("{}", { DEPENDENCY_INSTALL_POLICY: "always-trust" }),
    /no direct dependencies/,
  );
});

test("an agent cannot add packages or flags to npm install", async () => {
  const tools = new AgentTools({ role: "backend", workspacePath: process.cwd() });
  await assert.rejects(
    () => tools.runCommand({ command: "npm", args: ["install", "express"] }),
    /Command not allowed/,
  );
  await assert.rejects(
    () => tools.runCommand({ command: "npm", args: ["install", "--ignore-scripts"] }),
    /Command not allowed/,
  );
});
