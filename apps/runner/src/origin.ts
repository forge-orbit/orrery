/**
 * Shared server-origin canonicalization, comparison and transport hardening
 * for `orrery-runner` (#264, ADR-0012).
 *
 * One helper owns every origin decision so `login`, credential read/write,
 * origin comparison, display output and HTTP clients cannot drift.
 */

/** Canonical loopback hosts for plain-`http:` allowance. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1") return true;
  const parts = bare.split(".");
  if (parts.length === 4 && parts[0] === "127") {
    return parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    );
  }
  return false;
}

/**
 * Canonicalize a server URL to `scheme://host[:port][/path-prefix]`.
 *
 * - Only `http:` and `https:` are allowed.
 * - Embedded credentials, query strings and fragments are rejected.
 * - Scheme and host are lowercased; default ports are stripped via `url.host`.
 * - Path prefix case/encoding is preserved; trailing slashes are stripped.
 * - `localhost` is never equated with `127.0.0.1` (plain string comparison).
 */
export function canonicalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Server URL must not be empty.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid server URL '${trimmed}'. Use an http(s):// URL.`);
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Server URL must use http: or https:, got '${url.protocol}'.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Server URL must not include credentials.");
  }
  if (url.search !== "") {
    throw new Error("Server URL must not include a query string.");
  }
  if (url.hash !== "") {
    throw new Error("Server URL must not include a fragment.");
  }
  const host = url.host.toLowerCase();
  if (host === "") throw new Error(`Invalid server URL '${trimmed}'. Missing host.`);
  let path = url.pathname;
  if (path === "/") path = "";
  else path = path.replace(/\/+$/, "");
  return `${protocol}//${host}${path}`;
}

/** True when the canonical origin's hostname is loopback. */
export function isLoopbackOrigin(canonical: string): boolean {
  const hostname = new URL(canonical).hostname;
  return isLoopbackHostname(hostname);
}

export interface InsecureCheckOptions {
  warn?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Reject plain `http:` outside loopback unless
 * `ORRERY_RUNNER_ALLOW_INSECURE_HTTP=1` is set. The opt-in prints a
 * per-invocation warning naming the origin and never relaxes origin pinning.
 */
export function assertSecureOrigin(canonical: string, options: InsecureCheckOptions = {}): void {
  const scheme = new URL(canonical).protocol.toLowerCase();
  if (scheme !== "http:") return;
  if (isLoopbackOrigin(canonical)) return;
  const env = options.env ?? process.env;
  if (env.ORRERY_RUNNER_ALLOW_INSECURE_HTTP === "1") {
    const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    warn(
      `Warning: using insecure plain-HTTP origin ${canonical} ` +
        `(ORRERY_RUNNER_ALLOW_INSECURE_HTTP=1). Credentials are sent in cleartext.`,
    );
    return;
  }
  throw new Error(
    `Refusing plain-HTTP origin ${canonical} outside loopback. ` +
      `Use https:// or set ORRERY_RUNNER_ALLOW_INSECURE_HTTP=1 to opt in explicitly.`,
  );
}

/** Canonicalize and compare two origins without equating loopback aliases. */
export function originsEqual(a: string, b: string): boolean {
  return canonicalizeServerUrl(a) === canonicalizeServerUrl(b);
}

export interface CredentialedOriginOptions extends InsecureCheckOptions {
  storedServer: string;
  serverFlag?: string | undefined;
  envUrl?: string | undefined;
}

/**
 * Resolve the authoritative origin for credentialed commands (`start`,
 * `work`, and future `init`). The stored enrollment wins; `--server` and
 * `ORRERY_URL` act as assertions that fail fast before any HTTP request.
 * Never falls back to `http://localhost:8080`.
 */
export function resolveCredentialedOrigin(options: CredentialedOriginOptions): string {
  const stored = canonicalizeServerUrl(options.storedServer);
  if (options.serverFlag !== undefined && options.serverFlag !== "") {
    const asserted = canonicalizeServerUrl(options.serverFlag);
    if (asserted !== stored) {
      throw new Error(
        `Server mismatch: --server ${asserted} does not match enrolled origin ${stored}. ` +
          `Use 'orrery-runner login --server <url>' to switch installations.`,
      );
    }
  }
  if (options.envUrl !== undefined && options.envUrl !== "") {
    const asserted = canonicalizeServerUrl(options.envUrl);
    if (asserted !== stored) {
      throw new Error(
        `Server mismatch: ORRERY_URL ${asserted} does not match enrolled origin ${stored}. ` +
          `Use 'orrery-runner login --server <url>' to switch installations.`,
      );
    }
  }
  assertSecureOrigin(stored, options);
  return stored;
}

export interface LoginOriginOptions {
  storedServer?: string | undefined;
  serverFlag?: string | undefined;
  envUrl?: string | undefined;
}

/**
 * Resolve the server for `login` (the only command allowed to switch
 * origins, and only via explicit `--server`). Without `--server`, reuse the
 * enrolled origin and fail if `ORRERY_URL` disagrees; otherwise fall back to
 * `ORRERY_URL` then `http://localhost:8080`.
 */
export function resolveLoginOrigin(options: LoginOriginOptions): string {
  if (options.serverFlag !== undefined && options.serverFlag !== "") {
    return canonicalizeServerUrl(options.serverFlag);
  }
  if (options.storedServer !== undefined && options.storedServer !== "") {
    const stored = canonicalizeServerUrl(options.storedServer);
    if (options.envUrl !== undefined && options.envUrl !== "") {
      const asserted = canonicalizeServerUrl(options.envUrl);
      if (asserted !== stored) {
        throw new Error(
          `Server mismatch: ORRERY_URL ${asserted} does not match enrolled origin ${stored}. ` +
            `Pass --server <url> to switch installations.`,
        );
      }
    }
    return stored;
  }
  if (options.envUrl !== undefined && options.envUrl !== "") {
    return canonicalizeServerUrl(options.envUrl);
  }
  return canonicalizeServerUrl("http://localhost:8080");
}
