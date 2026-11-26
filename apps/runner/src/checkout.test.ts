import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bindingFingerprint,
  mainCheckoutRoot,
  runnerFingerprint,
  validateCheckout,
} from "./checkout.ts";
import { defaultStartDisplayName } from "./display-name.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orrery-checkout-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  await mkdtemp(join(tmpdir(), "x"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  await writeFile(join(repo, "f.txt"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

describe("shared git checkout validator and two-tier fingerprints (#264)", () => {
  it("resolves subdirectories to the repo root", async () => {
    const repo = await initRepo();
    const sub = join(repo, "a", "b");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub, { recursive: true });
    const checked = validateCheckout(sub);
    expect(checked.repoRoot).toBe(mainCheckoutRoot(repo));
    expect(runnerFingerprint(sub)).toBe(runnerFingerprint(repo));
    expect(bindingFingerprint(sub)).toBe(bindingFingerprint(repo));
  });

  it("keeps linked worktrees isolated on runner fingerprint but shared on binding", async () => {
    const repo = await initRepo();
    const link = join(repo, "..", "linked");
    git(repo, ["worktree", "add", link, "-b", "linked-branch"]);
    const mainFp = runnerFingerprint(repo);
    const linkFp = runnerFingerprint(link);
    expect(linkFp).not.toBe(mainFp);
    expect(bindingFingerprint(link)).toBe(bindingFingerprint(repo));
    // Main vs worktree display names differ only when basenames differ.
    const mainName = defaultStartDisplayName("host", repo);
    const linkName = defaultStartDisplayName("host", link);
    expect(mainName).toContain("host ·");
    expect(linkName.length).toBeGreaterThan(0);
  });

  it("resolves submodules to their own root (not the superproject)", async () => {
    const superRepo = await initRepo();
    const subSrc = await initRepo();
    execFileSync(
      "git",
      [
        "-C",
        superRepo,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        subSrc,
        "vendor/sub",
      ],
      {
        encoding: "utf8",
      },
    );
    git(superRepo, ["commit", "-qam", "add submodule"]);
    const subPath = join(superRepo, "vendor", "sub");
    const toplevel = git(subPath, ["rev-parse", "--show-toplevel"]);
    expect(toplevel).toBe(subPath);
    expect(runnerFingerprint(subPath)).not.toBe(runnerFingerprint(superRepo));
    expect(mainCheckoutRoot(subPath)).toBe(subPath);
  });

  it("fails fast on missing dir, non-git dir and unborn repo", async () => {
    expect(() => validateCheckout("/definitely/not/here-12345")).toThrow(/does not exist/);
    const nonGit = await mkdtemp(join(tmpdir(), "orrery-nongit-"));
    dirs.push(nonGit);
    expect(() => validateCheckout(nonGit)).toThrow(/not inside a git work tree/);
    const unborn = await mkdtemp(join(tmpdir(), "orrery-unborn-"));
    dirs.push(unborn);
    const repo = join(unborn, "repo");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    expect(() => validateCheckout(repo)).toThrow(/no HEAD/);
  });
});
