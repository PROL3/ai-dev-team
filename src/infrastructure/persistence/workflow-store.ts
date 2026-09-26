import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { workflowStateSchema, type WorkflowState } from "../../domain/workflow-state.js";

export class CheckpointError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckpointError";
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

/** State lives outside the target checkout, so Git never commits it. */
export function defaultCheckpointPath(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  return path.join(path.dirname(root), ".ai-dev-runs", path.basename(root), "checkpoint.json");
}

export class WorkflowStore {
  readonly filePath: string;
  private token: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async load(): Promise<WorkflowState> {
    try {
      if ((await fs.stat(this.filePath)).size > 64 * 1024 * 1024)
        throw new Error("Checkpoint is too large.");
      return workflowStateSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      throw new CheckpointError(`Cannot load checkpoint ${this.filePath}: ${message(error)}`, {
        cause: error,
      });
    }
  }

  async acquire(): Promise<void> {
    if (this.token) throw new CheckpointError("This checkpoint is already running.");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      try {
        const lock = await fs.open(lockPath, "wx");
        try {
          await lock.writeFile(
            JSON.stringify({ token, pid: process.pid, hostname: os.hostname() }),
          );
          await lock.sync();
        } finally {
          await lock.close();
        }
        this.token = token;
        return;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
          throw new CheckpointError(`Cannot lock checkpoint: ${message(error)}`, { cause: error });
        }
      }
      // Only reclaim a well-formed lock from a demonstrably dead local process.
      const raw = await fs.readFile(lockPath, "utf8");
      let owner: { pid?: unknown; hostname?: unknown };
      try {
        owner = JSON.parse(raw);
      } catch {
        throw new CheckpointError(`Unreadable lock: ${lockPath}`);
      }
      if (
        !owner ||
        owner.hostname !== os.hostname() ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0
      )
        throw new CheckpointError(`Cannot safely reclaim lock: ${lockPath}`);
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        dead = !!error && typeof error === "object" && "code" in error && error.code === "ESRCH";
      }
      if (!dead) throw new CheckpointError(`Workflow is already running (PID ${owner.pid}).`);
      // Serialize stale-lock reclamation so two resumers cannot unlink a new owner's lock.
      const recoveryPath = `${lockPath}.recover`;
      let recovery;
      try {
        recovery = await fs.open(recoveryPath, "wx");
      } catch {
        throw new CheckpointError(`Lock recovery is already in progress: ${recoveryPath}`);
      }
      try {
        if ((await fs.readFile(lockPath, "utf8")) !== raw)
          throw new CheckpointError("Checkpoint lock changed; retry resume.");
        await fs.unlink(lockPath);
      } finally {
        await recovery.close();
        await fs.unlink(recoveryPath);
      }
    }
    throw new CheckpointError("Could not acquire checkpoint lock.");
  }

  async save(state: WorkflowState): Promise<void> {
    // Snapshot before queuing: parallel agents must not serialize mutable live state later.
    let data: string;
    try {
      data = JSON.stringify(workflowStateSchema.parse(state));
    } catch (error) {
      throw new CheckpointError(`Invalid checkpoint state: ${message(error)}`, { cause: error });
    }
    if (Buffer.byteLength(data, "utf8") > 64 * 1024 * 1024)
      throw new CheckpointError(
        "Checkpoint exceeds the 64 MB limit; previous state was preserved.",
      );
    const operation = this.tail.then(async () => {
      if (!this.token) throw new CheckpointError("Checkpoint write requires the workflow lock.");
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(data, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, this.filePath);
      } catch (error) {
        throw new CheckpointError(`Cannot save checkpoint: ${message(error)}`, { cause: error });
      } finally {
        await fs.unlink(temporary).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      }
    });
    this.tail = operation;
    return operation;
  }

  async release(): Promise<void> {
    await this.tail.catch(() => undefined);
    if (!this.token) return;
    const lockPath = `${this.filePath}.lock`;
    const owner: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (owner && typeof owner === "object" && "token" in owner && owner.token === this.token)
      await fs.unlink(lockPath);
    this.token = undefined;
  }
}
