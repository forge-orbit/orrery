import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findBinding, readReposFile, reposPath, saveBinding, type RepoBinding } from "./repos.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orrery-repos-"));
  dirs.push(dir);
  return dir;
}

function binding(overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    server: "http://127.0.0.1:8080",
    bindingFingerprint: "a".repeat(64),
    workspaceId: "ws-1",
    projectId: "proj-1",
    agentId: "agent-1",
    hostId: "host-1",
    workspaceName: "Acme",
    projectKey: "ONE",
    agentName: "Ada",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("repos.json persistence (#267)", () => {
  it("reads an empty binding list when the file is missing", async () => {
    const dir = await makeDir();
    expect(await readReposFile(dir)).toEqual([]);
  });

  it("writes atomically with 0700 dir and 0600 file permissions", async () => {
    const dir = await makeDir();
    const path = await saveBinding(binding(), dir);
    expect(path).toBe(join(dir, "repos.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toMatchObject({ version: 1 });
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("bindings" in parsed) ||
      !Array.isArray(parsed.bindings)
    ) {
      throw new Error("repos.json has no bindings array");
    }
    expect(parsed.bindings).toHaveLength(1);
    const back = await readReposFile(dir);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ workspaceId: "ws-1", projectId: "proj-1" });
    // No stray temp files survive the atomic rename.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["repos.json"]);
  });

  it("never stores displayName or credentials", async () => {
    const dir = await makeDir();
    const path = await saveBinding(binding(), dir);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("displayName");
    expect(text).not.toContain("credential");
    expect(text).not.toContain("orr_rh_");
  });

  it("upserts on (canonicalServer, bindingFingerprint) and canonicalizes the server", async () => {
    const dir = await makeDir();
    await saveBinding(binding({ server: "http://127.0.0.1:8080/" }), dir);
    await saveBinding(
      binding({ server: "http://127.0.0.1:8080", projectId: "proj-2", projectKey: "TWO" }),
      dir,
    );
    const back = await readReposFile(dir);
    expect(back).toHaveLength(1);
    expect(back[0]?.projectId).toBe("proj-2");
    expect(back[0]?.server).toBe("http://127.0.0.1:8080");
    await saveBinding(binding({ bindingFingerprint: "b".repeat(64) }), dir);
    expect(await readReposFile(dir)).toHaveLength(2);
  });

  it("finds bindings across equivalent server spellings", async () => {
    const dir = await makeDir();
    await saveBinding(binding({ server: "http://127.0.0.1:8080/" }), dir);
    const back = await readReposFile(dir);
    expect(findBinding(back, "http://127.0.0.1:8080", "a".repeat(64))?.projectId).toBe("proj-1");
    expect(findBinding(back, "http://127.0.0.1:8080", "c".repeat(64))).toBeUndefined();
  });

  it("fails fast naming the path on malformed content", async () => {
    const dir = await makeDir();
    await writeFile(reposPath(dir), "{not json");
    await expect(readReposFile(dir)).rejects.toThrow(
      new RegExp(reposPath(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    // The file is left unchanged for manual repair.
    expect(await readFile(reposPath(dir), "utf8")).toBe("{not json");
  });

  it("fails fast naming the path on unknown versions", async () => {
    const dir = await makeDir();
    await writeFile(reposPath(dir), JSON.stringify({ version: 2, bindings: [] }));
    await expect(readReposFile(dir)).rejects.toThrow(/repos\.json/);
  });

  it("rejects duplicate (server, fingerprint) entries on read", async () => {
    const dir = await makeDir();
    const entry = {
      ...binding(),
      updatedAt: new Date().toISOString(),
      server: "http://127.0.0.1:8080",
    };
    await writeFile(reposPath(dir), JSON.stringify({ version: 1, bindings: [entry, entry] }));
    await expect(readReposFile(dir)).rejects.toThrow(/Duplicate binding entries.*repos\.json/);
  });

  it("preserves other checkouts when one binding is updated", async () => {
    const dir = await makeDir();
    await saveBinding(binding({ bindingFingerprint: "a".repeat(64), projectId: "proj-1" }), dir);
    await saveBinding(binding({ bindingFingerprint: "b".repeat(64), projectId: "proj-9" }), dir);
    await saveBinding(
      binding({ bindingFingerprint: "a".repeat(64), projectId: "proj-2", projectKey: "TWO" }),
      dir,
    );
    const back = await readReposFile(dir);
    expect(back).toHaveLength(2);
    expect(back.find((entry) => entry.bindingFingerprint === "b".repeat(64))?.projectId).toBe(
      "proj-9",
    );
    expect(back.find((entry) => entry.bindingFingerprint === "a".repeat(64))?.projectId).toBe(
      "proj-2",
    );
  });
});
