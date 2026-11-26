// Bundles the runner CLI into a single standalone executable ESM file (#268).
//
// `prepack` reuses this script so `pnpm pack` (and `pnpm publish`) always
// ship a fresh bundle with the stamped `package.json` version injected via
// `define`. `@orrery/contract` and `zod` are bundled, so the published
// package has zero runtime `dependencies`.
import { buildSync } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

buildSync({
  entryPoints: [join(pkgDir, "src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  outfile: join(pkgDir, "dist/main.js"),
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "inline",
  define: { ORRERY_RUNNER_VERSION: JSON.stringify(pkg.version ?? "0.0.0-dev") },
  logLevel: "info",
});

chmodSync(join(pkgDir, "dist/main.js"), 0o755);
