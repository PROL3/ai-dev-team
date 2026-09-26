import { NpmValidationError } from "./npm-validation.js";

export type DependencyInstallPolicy = "deny" | "allow" | "always-trust";

type PackageJson = Record<string, unknown>;

type DirectDependency = {
  name: string;
  spec: string;
};

const REGISTRY_URL = "https://registry.npmjs.org";

/**
 * The model may request only `npm install`. These arguments are supplied by
 * the runner, not by the model, so it cannot add a custom registry, package,
 * lifecycle flag, or arbitrary npm option.
 */
export const SAFE_NPM_INSTALL_ARGS = [
  "install",
  "--package-lock=false",
  "--ignore-scripts",
  "--no-audit",
  "--fund=false",
  `--registry=${REGISTRY_URL}`,
] as const;

function parsePackageJson(content: string): PackageJson {
  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch {
    throw new NpmValidationError("package.json contains invalid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NpmValidationError("package.json must contain an object.");
  }

  return value as PackageJson;
}

function isSafePackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

/**
 * Deliberately accept ordinary semver ranges but reject sources that can run
 * arbitrary code or fetch from a non-registry location (file, git, URL, etc.).
 */
function isRegistrySemverSpec(value: string): boolean {
  return /^(?:[~^]|(?:>=|<=|>|<)\s*)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+(?:\|\||-|x|X|\*)\s+(?:[~^]|(?:>=|<=|>|<)\s*)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*$/.test(
    value,
  );
}

export function parseDirectDependencies(content: string): DirectDependency[] {
  const packageJson = parsePackageJson(content);
  const dependencies = new Map<string, string>();

  for (const field of ["dependencies", "devDependencies"] as const) {
    const group = packageJson[field];
    if (group === undefined) continue;

    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new NpmValidationError(`package.json ${field} must be an object.`);
    }

    for (const [name, spec] of Object.entries(group)) {
      if (!isSafePackageName(name)) {
        throw new NpmValidationError(`package.json has an invalid dependency name: ${name}.`);
      }
      if (typeof spec !== "string" || !isRegistrySemverSpec(spec.trim())) {
        throw new NpmValidationError(
          `Dependency ${name} must use an ordinary registry semver version; ` +
            "file, git, URL, alias, workspace, and tag specs are not allowed.",
        );
      }

      const previous = dependencies.get(name);
      if (previous && previous !== spec) {
        throw new NpmValidationError(
          `Dependency ${name} has conflicting versions in dependencies and devDependencies.`,
        );
      }
      dependencies.set(name, spec);
    }
  }

  return [...dependencies].map(([name, spec]) => ({ name, spec }));
}

export function resolveDependencyInstallPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): DependencyInstallPolicy {
  const value = environment.DEPENDENCY_INSTALL_POLICY?.trim().toLowerCase();

  if (!value || value === "deny") return "deny";
  if (value === "allow" || value === "always-trust") return value;

  throw new NpmValidationError("DEPENDENCY_INSTALL_POLICY must be deny, allow, or always-trust.");
}

function getAllowlist(environment: NodeJS.ProcessEnv): Set<string> {
  const entries = (environment.DEPENDENCY_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new NpmValidationError(
      "DEPENDENCY_INSTALL_POLICY=allow requires DEPENDENCY_ALLOWLIST with direct package names.",
    );
  }

  for (const name of entries) {
    if (!isSafePackageName(name)) {
      throw new NpmValidationError(`DEPENDENCY_ALLOWLIST has an invalid package name: ${name}.`);
    }
  }

  return new Set(entries);
}

/** Validates whether this workspace's declared dependencies may be installed. */
export function getSafeNpmInstallArgs(
  packageJsonContent: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const policy = resolveDependencyInstallPolicy(environment);
  if (policy === "deny") {
    throw new NpmValidationError(
      "Dependency installation is disabled. Set DEPENDENCY_INSTALL_POLICY=allow " +
        "with DEPENDENCY_ALLOWLIST, or explicitly set always-trust.",
    );
  }

  const dependencies = parseDirectDependencies(packageJsonContent);
  if (dependencies.length === 0) {
    throw new NpmValidationError("package.json declares no direct dependencies to install.");
  }

  if (policy === "allow") {
    const allowlist = getAllowlist(environment);
    const rejected = dependencies
      .filter(({ name }) => !allowlist.has(name))
      .map(({ name }) => name);
    if (rejected.length > 0) {
      throw new NpmValidationError(
        `Dependencies not present in DEPENDENCY_ALLOWLIST: ${rejected.join(", ")}.`,
      );
    }
  }

  return [...SAFE_NPM_INSTALL_ARGS];
}

export function dependencyInstallPromptGuidance(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const policy = resolveDependencyInstallPolicy(environment);
    if (policy === "deny") {
      return "Dependency installation is disabled for this run. Do not request npm install; use existing dependencies or Node built-ins.";
    }
    if (policy === "allow") {
      return 'Dependency installation is enabled only for direct package.json dependencies in DEPENDENCY_ALLOWLIST. Request only npm with args ["install"] after writing a valid package.json.';
    }
    return 'Dependency installation trusts direct registry-semver dependencies declared in this workspace\'s package.json. Request only npm with args ["install"] after writing a valid package.json.';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Dependency installation is disabled because its policy is invalid: ${message}`;
  }
}
