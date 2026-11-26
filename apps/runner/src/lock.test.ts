import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireCheckoutLock } from "./lock.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("per-checkout PID lockfile (#264)", () => {
  it("fails fast on contention with the live PID and recovers stale locks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orrery-lock-"));
    dirs.push(dir);
    const release = await acquireCheckoutLock({
      fingerprint: "a".repeat(64),
      server: "http://127.0.0.1:8080",
      repoRoot: "/tmp/repo",
      configDir: dir,
    });
    await expect(
      acquireCheckoutLock({
        fingerprint: "a".repeat(64),
        server: "http://127.0.0.1:8080",
        repoRoot: "/tmp/repo",
        configDir: dir,
      }),
    ).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    await release();
    // After release, acquisition succeeds again.
    const release2 = await acquireCheckoutLock({
      fingerprint: "a".repeat(64),
      server: "http://127.0.0.1:8080",
      repoRoot: "/tmp/repo",
      configDir: dir,
    });
    await release2();

    // Stale lock from a dead PID is cleaned up.
    const { writeFile } = await import("node:fs/promises");
    const { lockPath } = await import("./lock.ts");
    await writeFile(
      lockPath("b".repeat(64), dir),
      JSON.stringify({
        pid: 2147483647,
        startedAt: new Date().toISOString(),
        server: "x",
        repoRoot: "y",
      }),
      { mode: 0o600 },
    );
    const release3 = await acquireCheckoutLock({
      fingerprint: "b".repeat(64),
      server: "http://127.0.0.1:8080",
      repoRoot: "/tmp/repo",
      configDir: dir,
    });
    const text = await readFile(lockPath("b".repeat(64), dir), "utf8");
    expect(JSON.parse(text).pid).toBe(process.pid);
    await release3();
  });
});
