// Standalone packaging smoke test for @forge-orbit/orrery-runner (#268).
//
// Builds the package, packs a tarball, audits tarball hygiene (exact file
// manifest, LICENSE parity with the repo root, shebang + executable bit),
// installs the tarball into an isolated temp dir outside the monorepo with
// `npm install --ignore-scripts`, and executes the published binary through
// the npm `.bin` symlink (`--help` and `--version`).
//
// Run locally: `node scripts/smoke-runner-pack.mjs`
// CI runs the same script on every pull request.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(repoRoot, "apps/runner");
const failures = [];

const check = (label, ok, detail = "") => {
  const mark = ok ? "ok" : "FAIL";
  process.stdout.write(`[${mark}] ${label}${detail === "" ? "" : ` — ${detail}`}\n`);
  if (!ok) failures.push(label);
};

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options });

// 1. Build the standalone bundle.
run("pnpm", ["--filter", "@forge-orbit/orrery-runner", "build"], { cwd: repoRoot, stdio: "pipe" });
check("pnpm build produces dist/main.js", existsSync(join(pkgDir, "dist/main.js")));

// 2. Pack the tarball into a scratch dir (prepack rebuilds dist first).
const packDir = mkdtempSync(join(tmpdir(), "orrery-runner-pack-"));
run("pnpm", ["--filter", "@forge-orbit/orrery-runner", "pack", "--pack-destination", packDir], {
  cwd: repoRoot,
  stdio: "pipe",
});
const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
check("pnpm pack emits exactly one tarball", tarballs.length === 1, tarballs.join(", "));
if (tarballs.length !== 1) {
  process.stderr.write(`Expected one tarball in ${packDir}, found: ${tarballs.join(", ")}\n`);
  process.exit(1);
}
const tarball = join(packDir, tarballs[0]);

// 3. Tarball hygiene: exact manifest, no src/tests/node_modules.
const manifest = run("tar", ["-tzf", tarball], { cwd: packDir })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");
const expected = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/main.js",
  "package/package.json",
];
const sortedManifest = manifest.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
check(
  "tarball contains exactly dist/main.js, package.json, README.md, LICENSE",
  JSON.stringify(sortedManifest) === JSON.stringify(expected),
  manifest.join(", "),
);
check(
  "tarball has no src/, tests, or node_modules",
  !manifest.some(
    (entry) =>
      entry.startsWith("package/src/") ||
      entry.includes("node_modules") ||
      entry.endsWith(".test.js") ||
      entry.endsWith(".test.ts"),
  ),
);

// 4. Extract and audit content: shebang, executable bit, LICENSE parity.
const extractDir = mkdtempSync(join(tmpdir(), "orrery-runner-extract-"));
run("tar", ["-xzf", tarball, "-C", extractDir]);
const bundled = join(extractDir, "package/dist/main.js");
const firstLine = readFileSync(bundled, "utf8").split("\n")[0];
check("dist/main.js starts with a node shebang", firstLine === "#!/usr/bin/env node", firstLine);
const mode = statSync(bundled).mode & 0o777;
check("dist/main.js is executable (0755)", mode === 0o755, `mode ${mode.toString(8)}`);
const rootLicense = readFileSync(join(repoRoot, "LICENSE"));
const packedLicense = readFileSync(join(extractDir, "package/LICENSE"));
check(
  "packed LICENSE is byte-identical to the repo root LICENSE",
  rootLicense.equals(packedLicense),
  `sha256 ${createHash("sha256").update(packedLicense).digest("hex").slice(0, 12)}`,
);
const packedPkg = JSON.parse(readFileSync(join(extractDir, "package/package.json"), "utf8"));
check(
  "packed package has zero runtime dependencies",
  packedPkg.dependencies === undefined,
  JSON.stringify(packedPkg.dependencies ?? {}),
);
check(
  "packed bin points at dist/main.js",
  packedPkg.bin?.["orrery-runner"] === "./dist/main.js",
  JSON.stringify(packedPkg.bin ?? {}),
);

// 5. Isolated install outside the monorepo, executed through the .bin symlink.
const installDir = mkdtempSync(join(tmpdir(), "orrery-runner-install-"));
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
  cwd: installDir,
  stdio: "pipe",
});
const binLink = join(installDir, "node_modules/.bin/orrery-runner");
check("npm install creates node_modules/.bin/orrery-runner", existsSync(binLink));
const help = run(binLink, ["--help"], { cwd: installDir });
check("orrery-runner --help exits 0 via the .bin symlink", help.includes("orrery-runner"));
const version = run(binLink, ["--version"], { cwd: installDir }).trim();
check("orrery-runner --version prints 0.0.0-dev in PR builds", version === "0.0.0-dev", version);
const shortVersion = run(binLink, ["-v"], { cwd: installDir }).trim();
check("orrery-runner -v prints 0.0.0-dev in PR builds", shortVersion === "0.0.0-dev", shortVersion);

// 6. Cleanup scratch dirs (the installed copy stays out of the repo by construction).
rmSync(packDir, { recursive: true, force: true });
rmSync(extractDir, { recursive: true, force: true });
rmSync(installDir, { recursive: true, force: true });

if (failures.length > 0) {
  process.stderr.write(`\nSmoke test FAILED (${failures.length}): ${failures.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write(
  "\nSmoke test passed: standalone tarball installs and runs via .bin symlink.\n",
);
