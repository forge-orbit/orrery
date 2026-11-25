import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confinedPath, evaluatePermission, respondToPermission } from "./permission.ts";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orrery-permission-test-"));
  directories.push(path);
  await writeFile(join(path, "notes.txt"), "inside\n");
  return path;
}

const decision = (params: unknown, root: string) => evaluatePermission(params, root);

describe("local worktree permission policy", () => {
  it("fails closed for unknown or empty permission shapes", async () => {
    const root = await worktree();
    expect(decision({}, root).allow).toBe(false);
    expect(decision({ toolCall: { toolName: "unknown" } }, root).allow).toBe(false);
    expect(respondToPermission({}, decision({}, root)).outcome).toEqual({ outcome: "cancelled" });
  });

  it("allows in-worktree paths, denies traversal, and accepts a literal '..foo' name", async () => {
    const root = await worktree();
    await writeFile(join(root, "..foo"), "odd name\n");
    expect(decision({ path: join(root, "notes.txt") }, root).allow).toBe(true);
    expect(decision({ path: join(root, "..", "outside.txt") }, root).allow).toBe(false);
    expect(confinedPath(join(root, "..foo"), root)).toBe(join(root, "..foo"));
    expect(decision({ path: join(root, "..foo") }, root).allow).toBe(true);
  });

  it("rejects file:// URIs that escape and accepts those inside the worktree", async () => {
    const root = await worktree();
    expect(decision({ uri: "file:///etc/passwd" }, root).allow).toBe(false);
    expect(decision({ uri: `file://${join(root, "notes.txt")}` }, root).allow).toBe(true);
  });

  it("rejects existing and dangling symlink escapes", async () => {
    const root = await worktree();
    await symlink("/etc/passwd", join(root, "link-to-outside"));
    await symlink(join(root, "..", "missing-outside"), join(root, "dangling"));
    expect(confinedPath(join(root, "link-to-outside"), root)).toBeUndefined();
    expect(confinedPath(join(root, "dangling"), root)).toBeUndefined();
    expect(decision({ path: join(root, "dangling") }, root).allow).toBe(false);
  });

  it("rejects shell metacharacters, command substitution and chained commands", async () => {
    const root = await worktree();
    for (const command of [
      "echo hi\nrm -rf /",
      "echo hi\rrm -rf /",
      "echo `whoami`",
      "echo $(whoami)",
      "echo hi & rm -rf /",
      "echo ~",
      "echo $HOME",
      "echo hi && rm -rf /",
      "echo hi <(whoami)",
      "echo hi >(whoami)",
    ]) {
      expect({ command, allow: decision({ command }, root).allow }).toEqual({
        command,
        allow: false,
      });
    }
  });

  it("matches every redirect form and strips quotes before confinement", async () => {
    const root = await worktree();
    for (const command of [
      "echo secret > /etc/passwd",
      "echo secret 2> /etc/passwd",
      "echo secret &> /etc/passwd",
      "cat < /etc/passwd",
      "echo secret > '/etc/passwd'",
    ]) {
      expect({ command, allow: decision({ command }, root).allow }).toEqual({
        command,
        allow: false,
      });
    }
    expect(decision({ command: "echo notes > 'notes.txt'" }, root).allow).toBe(true);
  });

  it("blocks all force-push spellings and arbitrary executables", async () => {
    const root = await worktree();
    for (const command of [
      "git push -f origin main",
      "git push --force origin main",
      "git push --force-with-lease origin main",
      "git push origin +main:main",
      "find . -exec rm -rf {} +",
      "env node -e 'process.exit(0)'",
      "python3 -c 'print(1)'",
      "php -r 'echo 1;'",
      "ruby -e 'puts 1'",
    ]) {
      expect({ command, allow: decision({ command }, root).allow }).toEqual({
        command,
        allow: false,
      });
    }
    expect(decision({ command: "git status --short" }, root).allow).toBe(true);
  });

  it("treats { command, args } as one invocation instead of independent commands", async () => {
    const root = await worktree();
    expect(decision({ command: "git", args: ["status", "--short"] }, root).allow).toBe(true);
    expect(decision({ command: "git", args: ["push", "--force"] }, root).allow).toBe(false);
    expect(decision({ command: "cat", args: ["notes.txt"] }, root).allow).toBe(true);
    expect(decision({ command: "cat", args: ["/etc/passwd"] }, root).allow).toBe(false);
  });

  it("maps an allow decision onto the offered allow option", async () => {
    const root = await worktree();
    const params = {
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    };
    expect(
      respondToPermission(params, decision({ path: join(root, "notes.txt") }, root)),
    ).toMatchObject({ allow: true, outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(respondToPermission(params, decision({ path: "/etc/passwd" }, root))).toMatchObject({
      allow: false,
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it("creates a nested directory inside the worktree safely", async () => {
    const root = await worktree();
    expect(confinedPath(join(root, "new", "deep", "file.txt"), root)).toBe(
      join(root, "new", "deep", "file.txt"),
    );
    await mkdir(join(root, "new"), { recursive: true });
    expect(confinedPath(join(root, "new", "deep", "file.txt"), root)).toBe(
      join(root, "new", "deep", "file.txt"),
    );
  });
});
