type ProgressFields = Record<string, string | number | boolean | undefined>;

/** Only operational metadata belongs here: never prompts, source or raw output. */
export function logProgress(stage: string, event: string, fields: ProgressFields = {}): void {
  try {
    const bounded = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 240) : value,
      ]),
    );
    console.log(
      `[progress] ${JSON.stringify({ time: new Date().toISOString(), stage, event, ...bounded })}`,
    );
  } catch {
    // Console failures must not change execution/retry behavior.
  }
}

/** Reports elapsed waiting time without interrupting or retrying the operation. */
export async function withProgress<T>(
  stage: string,
  fields: ProgressFields,
  operation: () => Promise<T>,
  options: { heartbeatMs?: number; details?: (result: T) => ProgressFields } = {},
): Promise<T> {
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  logProgress(stage, "started", fields);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const timer =
    heartbeatMs > 0
      ? setInterval(() => {
          logProgress(stage, "waiting", { ...fields, elapsedMs: elapsedMs() });
        }, heartbeatMs)
      : undefined;
  timer?.unref();
  try {
    const result = await operation();
    let details: ProgressFields = {};
    try {
      details = options.details?.(result) ?? {};
    } catch {
      /* Logging is best effort. */
    }
    logProgress(stage, "finished", { ...fields, ...details, elapsedMs: elapsedMs() });
    return result;
  } catch (error) {
    // Error messages may contain model output/source. Existing task logs retain
    // the diagnosis; this channel only identifies the failed operation.
    logProgress(stage, "error", { ...fields, elapsedMs: elapsedMs() });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
  }
}

export function progressCommand(command: string, args: readonly string[]): string {
  // Never echo inline node code, tokens or arbitrary arguments to the progress log.
  if (command === "npm" && ["test", "install", "run"].includes(args[0] ?? "")) {
    const script = args[0] === "run" && /^[\w:.-]+$/.test(args[1] ?? "") ? ` ${args[1]}` : "";
    return `npm ${args[0]}${script}`;
  }
  if (command === "node" && args[0] === "--test") return "node --test";
  return command;
}
