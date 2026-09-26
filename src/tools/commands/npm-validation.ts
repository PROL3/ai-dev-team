/** Project configuration failures are implementation feedback, not runner faults. */
export class NpmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmValidationError";
  }
}

export function parseNpmScripts(content: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new NpmValidationError("package.json contains invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NpmValidationError("package.json must contain an object.");
  }
  if (!("scripts" in value) || value.scripts === undefined) return {};
  if (!value.scripts || typeof value.scripts !== "object" || Array.isArray(value.scripts)) {
    throw new NpmValidationError("package.json scripts must be an object.");
  }
  const scripts: Record<string, string> = {};
  for (const [name, script] of Object.entries(value.scripts)) {
    if (typeof script !== "string" || script.trim() === "") {
      throw new NpmValidationError(`package.json script "${name}" must be a nonempty command.`);
    }
    Object.defineProperty(scripts, name, { value: script, enumerable: true });
  }
  return scripts;
}

/**
 * Detect statically visible npm script cycles, including lifecycle hooks.
 * This is a preflight check, not a general shell interpreter: dynamically
 * generated commands remain subject to the normal process timeout.
 */
export function assertNpmScriptIsRunnable(scripts: Record<string, string>, script: string): void {
  if (!Object.hasOwn(scripts, script)) {
    throw new NpmValidationError(`package.json does not declare the "${script}" script.`);
  }

  const active: string[] = [];
  const checked = new Set<string>();

  function visit(name: string, hooks: boolean): void {
    const key = `${hooks ? "lifecycle" : "script"}:${name}`;
    if (active.includes(name)) {
      throw new NpmValidationError(
        `Recursive npm script detected: ${[...active, name].join(" -> ")}. ` +
          `Replace the recursive invocation in package.json with a real validation command.`,
      );
    }
    if (checked.has(key) || !Object.hasOwn(scripts, name)) return;
    active.push(name);
    if (hooks) visit(`pre${name}`, false);

    // Match executable positions, not e.g. echo "npm test" or a quoted JS string.
    const command = scripts[name]!;
    const calls =
      /(?:^|&&|\|\||[;|\n]|\$\(|\()\s*(?:call\s+)?(?:npm(?:\.cmd)?|"npm(?:\.cmd)?"|'npm(?:\.cmd)?')\s+(?:(?:run|run-script)\s+(?:"([\w:-]+)"|'([\w:-]+)'|([\w:-]+))|(test|t|tst|start|stop|restart))(?![\w:-])/g;
    for (const match of command.matchAll(calls)) {
      const target = match[1] ?? match[2] ?? match[3] ?? match[4]!;
      visit(target === "t" || target === "tst" ? "test" : target, true);
    }

    if (hooks) visit(`post${name}`, false);
    active.pop();
    checked.add(key);
  }

  visit(script, true);
}
