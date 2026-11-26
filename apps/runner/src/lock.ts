import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory } from "./credential.ts";

export interface CheckoutLockInfo {
  pid: number;
  startedAt: string;
  server: string;
  repoRoot: string;
}

export interface AcquireLockOptions {
  fingerprint: string;
  server: string;
  repoRoot: string;
  configDir?: string | undefined;
}

/** Local single-instance lockfile `runner-<fingerprint>.lock` (0600). */
export function lockPath(fingerprint: string, configDir?: string): string {
  const dir = configDir ?? configDirectory();
  return join(dir, `runner-${fingerprint}.lock`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a live process we cannot signal; anything else is dead.
    if (errorCode(error) === "EPERM") return true;
    return false;
  }
}

function readPid(text: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value === "object" && value !== null && "pid" in value) {
    return typeof value.pid === "number" ? value.pid : undefined;
  }
  return undefined;
}

/**
 * Acquire the per-checkout lock with `O_CREAT | O_EXCL`. On contention with a
 * live PID, fail fast naming the PID; on a dead PID, unlink the stale lock
 * and retry once. Returns an idempotent release function for `finally` blocks.
 */
export async function acquireCheckoutLock(
  options: AcquireLockOptions,
): Promise<() => Promise<void>> {
  const dir = options.configDir ?? configDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = lockPath(options.fingerprint, dir);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      server: options.server,
      repoRoot: options.repoRoot,
    } satisfies CheckoutLockInfo,
    null,
    2,
  );

  const writeExclusive = async (): Promise<boolean> => {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${payload}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await chmod(path, 0o600);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  };

  const releaseOnce = async (): Promise<void> => {
    try {
      const text = await readFile(path, "utf8");
      if (readPid(text) === process.pid) await unlink(path);
    } catch {
      // Our lock is already gone (or unreadable): nothing to release.
    }
  };

  if (await writeExclusive()) {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await releaseOnce();
    };
  }

  // Contention: inspect the existing lockfile.
  let pid: number | undefined;
  try {
    pid = readPid(await readFile(path, "utf8"));
  } catch {
    pid = undefined;
  }
  if (pid !== undefined && isAlive(pid)) {
    throw new Error(
      `Another orrery-runner start is already running in this checkout (pid ${pid}). ` +
        `Stop it before starting a second Runner here.`,
    );
  }
  // Stale lock from a dead process: remove and retry once.
  try {
    await unlink(path);
  } catch {
    // Raced with another recovery: fall through to the retry.
  }
  if (await writeExclusive()) {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await releaseOnce();
    };
  }
  throw new Error(
    "Another orrery-runner start is already running in this checkout. Stop it before starting again.",
  );
}
