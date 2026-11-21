import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The CLI ships this doctor API as plain JavaScript; the result is typed at the call site.
import { scanBuilt } from "../node_modules/@astryxdesign/cli/api/doctor/built-checks.mjs";

type BuiltFinding = {
  category: string;
  file: string;
  line: number;
  message: string;
};

const srcDir = fileURLToPath(new URL(".", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Selector text before each rule's `{`, ignoring at-rule preludes like `@media`. */
function ruleSelectors(css: string): string[] {
  const selectors: string[] = [];
  let pending = "";
  for (const char of css) {
    if (char === "{") {
      const selector = pending.trim();
      if (selector && !selector.startsWith("@")) selectors.push(selector);
      pending = "";
    } else if (char === "}" || char === ";") {
      pending = "";
    } else {
      pending += char;
    }
  }
  return selectors;
}

/** An opening tag's full text, ending only at its unquoted, unbraced `>`. */
function openingTag(text: string, start: number): string {
  let braces = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") braces++;
    if (char === "}" && braces > 0) braces--;
    if (char === ">" && braces === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Tag text with `{...}` expressions blanked, so only literal props remain. */
function literalProps(tag: string): string {
  let braces = 0;
  let quote: string | null = null;
  let out = "";
  for (let i = 0; i < tag.length; i++) {
    const char = tag[i];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += tag[++i] ?? "";
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === "{") braces++;
    if (char === "}") braces--;
    out += braces > 0 ? " " : char;
  }
  return out;
}

describe("Astryx purity guardrails", () => {
  it("has zero built-astryx-purity findings across lib, routes, and features", () => {
    const { findings } = scanBuilt(srcDir, [
      "@astryxdesign/core",
      "@astryxdesign/theme-neutral",
    ]) as { findings: BuiltFinding[] };
    // This generated theme loader owns the theme CSS imports the scanner flags.
    const relevant = findings.filter((finding) => finding.file !== "astryx-themes.ts");
    expect(relevant).toEqual([]);
  });

  it("keeps orrery.css free of custom class selectors and .astryx-* overrides", () => {
    const css = readFileSync(join(srcDir, "orrery.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // comments
      .replace(/^\s*@import[^;]*;\s*$/gm, ""); // Astryx stylesheet imports

    const selectors = ruleSelectors(css);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.filter((selector) => /\.[A-Za-z_][\w-]*/.test(selector))).toEqual([]);
  });

  it("wraps Button and IconButton icon props in <Icon>", () => {
    const offenders: string[] = [];
    const tags = /<(?:Button|IconButton)(?=[\s/>])/g;
    const bareIcon = /\bicon\s*=\s*(?:"[^"]*"|'[^']*')/;
    for (const file of tsxFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(tags)) {
        const at = match.index ?? 0;
        if (bareIcon.test(literalProps(openingTag(text, at)))) {
          const line = text.slice(0, at).split("\n").length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
