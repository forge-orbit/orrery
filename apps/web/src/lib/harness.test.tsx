import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar, HarnessBadge, resolveHarnessKind } from "./harness.tsx";

describe("resolveHarnessKind", () => {
  it("resolves codex and claude harness variants", () => {
    expect(resolveHarnessKind("codex")).toBe("codex");
    expect(resolveHarnessKind("Codex")).toBe("codex");
    expect(resolveHarnessKind("codex-cli")).toBe("codex");
    expect(resolveHarnessKind("openai-codex")).toBe("codex");

    expect(resolveHarnessKind("claude")).toBe("claude");
    expect(resolveHarnessKind("claude-code")).toBe("claude");
    expect(resolveHarnessKind("Claude Code")).toBe("claude");
    expect(resolveHarnessKind("claude_code")).toBe("claude");
    expect(resolveHarnessKind("anthropic")).toBe("claude");
  });

  it("resolves other supported coding harnesses", () => {
    expect(resolveHarnessKind("openai")).toBe("openai");
    expect(resolveHarnessKind("cursor")).toBe("cursor");
    expect(resolveHarnessKind("acp-cursor")).toBe("cursor");
    expect(resolveHarnessKind("opencode")).toBe("opencode");
    expect(resolveHarnessKind("acp-opencode")).toBe("opencode");
    expect(resolveHarnessKind("gemini")).toBe("gemini");
    expect(resolveHarnessKind("gemini-cli")).toBe("gemini");
    expect(resolveHarnessKind("grok")).toBe("grok");
    expect(resolveHarnessKind("github-copilot")).toBe("copilot");
    expect(resolveHarnessKind("windsurf")).toBe("windsurf");
    expect(resolveHarnessKind("cline")).toBe("cline");
  });

  it("returns null for unknown or empty harness names", () => {
    expect(resolveHarnessKind(null)).toBeNull();
    expect(resolveHarnessKind(undefined)).toBeNull();
    expect(resolveHarnessKind("")).toBeNull();
    expect(resolveHarnessKind("   ")).toBeNull();
    expect(resolveHarnessKind("e2e")).toBeNull();
    expect(resolveHarnessKind("my-work-ui-e2e")).toBeNull();
    expect(resolveHarnessKind("codexia")).toBeNull();
  });
});

describe("HarnessBadge", () => {
  it("renders the Codex logo alongside the harness label and optional version", () => {
    const html = renderToStaticMarkup(<HarnessBadge harness="codex" version="0.171.0" />);
    expect(html).toContain('data-harness-brand="codex"');
    expect(html).toContain('data-harness-logo="codex"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">codex 0.171.0</");
    expect(html).not.toContain("<title>");
  });

  it("renders the Claude logo for claude-code and claude", () => {
    const claudeCode = renderToStaticMarkup(<HarnessBadge harness="claude-code" />);
    expect(claudeCode).toContain('data-harness-brand="claude"');
    expect(claudeCode).toContain('data-harness-logo="claude"');
    expect(claudeCode).toContain(">claude-code</");

    const claude = renderToStaticMarkup(<HarnessBadge harness="claude" />);
    expect(claude).toContain('data-harness-logo="claude"');
    expect(claude).toContain(">claude</");
  });

  it("renders plain text with no logo for unknown or empty harnesses", () => {
    expect(renderToStaticMarkup(<HarnessBadge harness="e2e" />)).toBe("e2e");
    expect(renderToStaticMarkup(<HarnessBadge harness={null} empty="—" />)).toBe("—");
    expect(renderToStaticMarkup(<HarnessBadge harness={null} empty="Unknown" />)).toBe("Unknown");
  });
});

describe("AgentAvatar", () => {
  it("renders a distinct Bot icon when no harness logo is known", () => {
    const html = renderToStaticMarkup(<AgentAvatar name="AG" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="AG"');
    expect(html).toContain('data-color="accent"');
  });
});
