import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertSecureOrigin,
  canonicalizeServerUrl,
  isLoopbackOrigin,
  resetInsecureOriginWarnings,
  resolveCredentialedOrigin,
  resolveLoginOrigin,
} from "./origin.ts";

afterEach(() => {
  delete process.env.ORRERY_RUNNER_ALLOW_INSECURE_HTTP;
  resetInsecureOriginWarnings();
  vi.restoreAllMocks();
});

describe("server URL canonicalizer (#264)", () => {
  it("lowercases scheme/host, strips default ports and trailing slashes", () => {
    expect(canonicalizeServerUrl("HTTP://Example.COM:80/api/")).toBe("http://example.com/api");
    expect(canonicalizeServerUrl("https://Example.COM:443/a/b/")).toBe("https://example.com/a/b");
    expect(canonicalizeServerUrl("https://example.com:8443/prefix/")).toBe(
      "https://example.com:8443/prefix",
    );
    expect(canonicalizeServerUrl("http://localhost:8080/")).toBe("http://localhost:8080");
  });

  it("preserves path prefix case and never equates localhost with 127.0.0.1", () => {
    expect(canonicalizeServerUrl("https://example.com/Prefix/Mixed")).toBe(
      "https://example.com/Prefix/Mixed",
    );
    expect(canonicalizeServerUrl("http://localhost:8080")).not.toBe(
      canonicalizeServerUrl("http://127.0.0.1:8080"),
    );
  });

  it("rejects credentials, query strings, fragments and non-http schemes", () => {
    expect(() => canonicalizeServerUrl("http://user:pass@example.com/")).toThrow(/credentials/);
    expect(() => canonicalizeServerUrl("https://example.com/?x=1")).toThrow(/query/);
    expect(() => canonicalizeServerUrl("https://example.com/#frag")).toThrow(/fragment/);
    expect(() => canonicalizeServerUrl("ftp://example.com/")).toThrow(/http/);
    expect(() => canonicalizeServerUrl("not-a-url")).toThrow(/Invalid server URL/);
  });

  it("detects loopback origins (localhost, 127/8, ::1)", () => {
    expect(isLoopbackOrigin("http://localhost:8080")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackOrigin("http://127.12.34.56/")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8080/")).toBe(true);
    expect(isLoopbackOrigin("http://example.com/")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.1/")).toBe(false);
  });

  it("refuses non-loopback http without opt-in and warns with opt-in", () => {
    expect(() => assertSecureOrigin("http://example.com")).toThrow(/plain-HTTP/);
    expect(() => assertSecureOrigin("http://127.0.0.1:8080")).not.toThrow();
    expect(() => assertSecureOrigin("https://example.com")).not.toThrow();
    process.env.ORRERY_RUNNER_ALLOW_INSECURE_HTTP = "1";
    const warn = vi.fn<(line: string) => void>();
    assertSecureOrigin("http://example.com", { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("http://example.com");
  });

  it("resolves credentialed origins with fail-fast mismatch (zero HTTP)", () => {
    const stored = "https://example.com/app/";
    // Canonical form is returned.
    expect(resolveCredentialedOrigin({ storedServer: stored })).toBe("https://example.com/app");
    // Matching assertions (different casing/trailing slash) pass.
    expect(
      resolveCredentialedOrigin({
        storedServer: stored,
        serverFlag: "HTTPS://EXAMPLE.COM/app/",
      }),
    ).toBe("https://example.com/app");
    // Mismatched --server fails without leaking secrets.
    expect(() =>
      resolveCredentialedOrigin({ storedServer: stored, serverFlag: "https://other.test/" }),
    ).toThrow(/does not match enrolled origin/);
    // Mismatched ORRERY_URL fails too.
    expect(() =>
      resolveCredentialedOrigin({ storedServer: stored, envUrl: "https://other.test/" }),
    ).toThrow(/ORRERY_URL/);
  });

  it("resolves login origins (reuse, fallback, mismatch)", () => {
    expect(resolveLoginOrigin({ storedServer: "https://a.test/", envUrl: "https://a.test" })).toBe(
      "https://a.test",
    );
    expect(() =>
      resolveLoginOrigin({ storedServer: "https://a.test/", envUrl: "https://b.test/" }),
    ).toThrow(/does not match enrolled origin/);
    expect(resolveLoginOrigin({ serverFlag: "https://b.test/" })).toBe("https://b.test");
    expect(resolveLoginOrigin({ envUrl: "https://b.test/" })).toBe("https://b.test");
    expect(resolveLoginOrigin({})).toBe("http://localhost:8080");
  });
});
