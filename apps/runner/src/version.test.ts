import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  const patched = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  process.stdout.write = patched;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("orrery-runner --version (#268)", () => {
  it("--version prints 0.0.0-dev from TypeScript source", async () => {
    const { main } = await import("./cli.ts");
    const out = await captureStdout(() => main(["--version"]));
    expect(out.trim()).toBe("0.0.0-dev");
  });

  it("-v is a short alias for --version", async () => {
    const { main } = await import("./cli.ts");
    const out = await captureStdout(() => main(["-v"]));
    expect(out.trim()).toBe("0.0.0-dev");
  });

  it("--version wins without a credential, server, or command", async () => {
    const { main } = await import("./cli.ts");
    const dir = await mkdtemp(join(tmpdir(), "orrery-version-"));
    try {
      const savedConfigDir = process.env.ORRERY_RUNNER_CONFIG_DIR;
      const savedUrl = process.env.ORRERY_URL;
      process.env.ORRERY_RUNNER_CONFIG_DIR = dir;
      delete process.env.ORRERY_URL;
      try {
        // No runner-credential.json in dir: any command would fail, but
        // --version is handled before credential/server checks.
        const out = await captureStdout(() => main(["--version"]));
        expect(out.trim()).toBe("0.0.0-dev");
        const withCommand = await captureStdout(() => main(["status", "--version"]));
        expect(withCommand.trim()).toBe("0.0.0-dev");
      } finally {
        if (savedConfigDir === undefined) delete process.env.ORRERY_RUNNER_CONFIG_DIR;
        else process.env.ORRERY_RUNNER_CONFIG_DIR = savedConfigDir;
        if (savedUrl === undefined) delete process.env.ORRERY_URL;
        else process.env.ORRERY_URL = savedUrl;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runner entrypoint split (#268)", () => {
  it("src/main.ts is a thin wrapper with no import.meta.url self-execution guard", async () => {
    const mainSrc = await readFile(join(here, "main.ts"), "utf8");
    expect(mainSrc).toContain("./cli.ts");
    expect(mainSrc).not.toMatch(/import\.meta\.url\s*===?/);
    expect(mainSrc).not.toContain("process.argv[1]");
  });

  it("src/cli.ts owns the main(argv) implementation and the version flag", async () => {
    const cliSrc = await readFile(join(here, "cli.ts"), "utf8");
    expect(cliSrc).toContain("export async function main");
    expect(cliSrc).toContain("--version");
  });
});
