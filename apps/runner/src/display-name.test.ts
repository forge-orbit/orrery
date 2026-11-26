import { describe, expect, it } from "vitest";
import { RunnerHostDisplayName } from "@orrery/contract";
import {
  codePointLength,
  defaultHostDisplayName,
  defaultStartDisplayName,
  defaultWorkDisplayName,
  truncateCodePoints,
  validateDisplayName,
} from "./display-name.ts";

describe("display names by Unicode code points (#264)", () => {
  it("RunnerHostDisplayName counts code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(120);
    expect(codePointLength(emoji)).toBe(120);
    expect(RunnerHostDisplayName.safeParse(emoji).success).toBe(true);
    const over = "😀".repeat(121);
    expect(codePointLength(over)).toBe(121);
    expect(RunnerHostDisplayName.safeParse(over).success).toBe(false);
    // 120 astral chars are 240 UTF-16 units: the old .max(120) would reject.
    expect(over.length).toBe(242);
    expect(RunnerHostDisplayName.safeParse("a".repeat(121)).success).toBe(false);
    expect(RunnerHostDisplayName.safeParse("a".repeat(120)).success).toBe(true);
  });

  it("truncates without splitting surrogate pairs", () => {
    const truncated = truncateCodePoints(`host ${"😀".repeat(200)}`, 120);
    expect(codePointLength(truncated)).toBe(120);
    expect(() => truncated.codePointAt(truncated.length - 1)).not.toThrow();
    // No lone surrogates.
    expect(/[\uD800-\uDBFF]$/.test(truncated)).toBe(false);
  });

  it("validates explicit names strictly (no silent truncation)", () => {
    expect(() => validateDisplayName("😀".repeat(121))).toThrow(/120/);
    expect(validateDisplayName("ok")).toBe("ok");
  });

  it("truncates the OS-hostname fallback for login", () => {
    expect(codePointLength(defaultHostDisplayName("😀".repeat(200)))).toBe(120);
  });

  it("builds work one-shot names within 120 code points", () => {
    const name = defaultWorkDisplayName(`${"😀".repeat(110)}host`);
    expect(codePointLength(name)).toBeLessThanOrEqual(120);
    expect(name).toContain("(one-shot)");
  });

  it("builds start names (tested against git fixtures in checkout tests)", () => {
    // Pure helper smoke: explicit over-long values fail, defaults truncate.
    expect(() => validateDisplayName("x".repeat(121))).toThrow(/120/);
    expect(codePointLength(defaultWorkDisplayName("x".repeat(200)))).toBe(120);
    expect(defaultStartDisplayName).toBeTypeOf("function");
  });
});
