import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_HARNESS_CATALOG,
  HarnessCatalog,
  type HarnessCatalogEntry,
  type HarnessModel,
  mergeHarnessCatalog,
} from "@orrery/contract";
import { AcpStdioClient } from "./acp.ts";
import { RunnerRequestError } from "./client.ts";
import { configDirectory } from "./credential.ts";
import { harnessesJsonPath, type HarnessDefinition } from "./harnesses.ts";
import { parseDiscovery } from "./probe.ts";

/**
 * Turn one raw discovery payload pair into a published catalog entry. The
 * shared dialect-tolerant parser reads both `initialize` models and
 * `session/new` config options (PR #255), so the same logic also parses a
 * discovery payload pair.
 */
export function catalogEntryFromSession(
  definition: HarnessDefinition,
  initResult: unknown,
  session: unknown,
  probedAt: string = new Date().toISOString(),
): HarnessCatalogEntry {
  const discovery = parseDiscovery(initResult, session, probedAt);
  // A hostile or merely sloppy ACP payload must never produce an entry that
  // fails the shared contract on PUT and poisons the local cache (#255 review).
  const models: HarnessModel[] = [];
  const seen = new Set<string>();
  for (const model of discovery.models) {
    const id = model.id.trim().slice(0, 200);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const published: HarnessModel = {
      id,
      reasoningDiscovery: model.reasoningDiscovery,
      probedAt,
    };
    if (model.label !== undefined && model.label !== "")
      published.label = model.label.trim().slice(0, 200);
    if (model.supportedEfforts !== undefined) {
      const efforts = [
        ...new Set(
          model.supportedEfforts.map((value) => value.trim().slice(0, 64)).filter(Boolean),
        ),
      ].slice(0, 32);
      if (efforts.length > 0 || model.reasoningDiscovery === "known") {
        published.supportedEfforts = efforts;
      }
    }
    if (model.defaultEffort !== undefined && model.defaultEffort.trim() !== "")
      published.defaultEffort = model.defaultEffort.trim().slice(0, 64);
    models.push(published);
    if (models.length === 200) break;
  }
  const defaultModel =
    models.length === 0
      ? "default"
      : (models.find((m) => m.id === discovery.defaultModel)?.id ?? models[0]!.id);
  return {
    id: definition.id.trim().slice(0, 64),
    displayName: definition.displayName.trim().slice(0, 120),
    source: definition.source,
    defaultModel,
    models,
    probedAt,
  };
}

export interface ProbeHarnessOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string> | undefined;
  at?: string | undefined;
  /** Shutdown/401 revocation kills an in-flight probe's process group. */
  signal?: AbortSignal | undefined;
}

/**
 * A bounded ACP discovery session; never leaves a probe process group behind.
 * The per-Harness lock keeps a probe from switching the Harness's default
 * model while a Dispatch for that same Harness is starting (ADR-0011).
 */
export async function probeHarness(
  definition: HarnessDefinition,
  options: ProbeHarnessOptions,
): Promise<HarnessCatalogEntry> {
  {
    const { session, initResult } = await AcpStdioClient.probe({
      command: definition.command,
      args: definition.args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      mcpServers: [],
      // Lets a test stub tell a discovery session from a real dispatch session.
      sessionMeta: { orreryProbe: true },
      worktreeReal: options.cwd,
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return catalogEntryFromSession(
      definition,
      initResult,
      session,
      options.at ?? new Date().toISOString(),
    );
  }
}

/**
 * The effective local Harness configuration belongs in the cache identity: two
 * Runners on the same checkout with different `--acp-command` overrides or
 * `harnesses.json` contents otherwise overwrite each other's discovery state
 * (ADR-0011).
 */
export function harnessConfigKey(
  options: {
    acpOverride?: { command: string; args: readonly string[] } | undefined;
    configDir?: string | undefined;
  } = {},
): string {
  const configDir = options.configDir ?? configDirectory();
  let harnessesText: string | null = null;
  try {
    harnessesText = readFileSync(harnessesJsonPath(configDir), "utf8");
  } catch {
    // No user registry file: the override alone identifies the configuration.
  }
  return createHash("sha256")
    .update(JSON.stringify([options.acpOverride ?? null, harnessesText]))
    .digest("hex")
    .slice(0, 16);
}

/** One Runner owns one checkout AND one local Harness configuration. */
export function catalogCachePath(
  repoFingerprint: string,
  configDir = configDirectory(),
  configKey = "",
): string {
  const suffix = configKey === "" ? "" : `-${configKey}`;
  return join(configDir, `harness-catalog-${repoFingerprint}${suffix}.json`);
}

/** The last successfully published catalog, used to seed a fast startup register. */
export function readCachedCatalog(
  repoFingerprint: string,
  configDir = configDirectory(),
  configKey = "",
): HarnessCatalog | null {
  let text: string;
  try {
    text = readFileSync(catalogCachePath(repoFingerprint, configDir, configKey), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A truncated or corrupt local cache must never abort Runner startup.
    return null;
  }
  const parsed = HarnessCatalog.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function writeCachedCatalog(
  repoFingerprint: string,
  value: HarnessCatalog,
  configDir = configDirectory(),
  configKey = "",
): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = catalogCachePath(repoFingerprint, configDir, configKey);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The minimal HTTP seam a publisher needs; `OrreryClient` satisfies it. */
export interface CatalogWriter {
  putCatalog(runnerId: string, catalog: HarnessCatalog): Promise<unknown>;
}

export interface CatalogPublisherOptions {
  client: CatalogWriter;
  runnerId: string;
  repoFingerprint: string;
  configDir?: string | undefined;
  configKey?: string | undefined;
  onUnauthorized?: ((message: string) => void) | undefined;
}

/**
 * Serializes catalog writes so a slow PUT can never land after a newer one and
 * fold stale `unknown` effort levels over a previously discovered `known` entry.
 * The shared contract merge is applied locally as well as on the server.
 */
export class CatalogPublisher {
  private latest: HarnessCatalog;
  private chain: Promise<void> = Promise.resolve();
  private readonly client: CatalogWriter;
  private readonly runnerId: string;
  private readonly repoFingerprint: string;
  private readonly configDir: string;
  private readonly configKey: string;
  private readonly onUnauthorized: ((message: string) => void) | undefined;

  constructor(options: CatalogPublisherOptions) {
    this.client = options.client;
    this.runnerId = options.runnerId;
    this.repoFingerprint = options.repoFingerprint;
    this.configDir = options.configDir ?? configDirectory();
    this.configKey = options.configKey ?? "";
    this.onUnauthorized = options.onUnauthorized;
    this.latest =
      readCachedCatalog(this.repoFingerprint, this.configDir, this.configKey) ??
      EMPTY_HARNESS_CATALOG;
  }

  get current(): HarnessCatalog {
    return this.latest;
  }

  publish(next: HarnessCatalog): Promise<void> {
    const task = this.chain.then(async () => {
      // Validate the merged result before it can reach the cache or the server:
      // a single oversized probe entry must not disable discovery for good.
      const merged: HarnessCatalog = HarnessCatalog.parse(mergeHarnessCatalog(this.latest, next));
      try {
        await this.client.putCatalog(this.runnerId, merged);
      } catch (error) {
        if (error instanceof RunnerRequestError && error.status === 401) {
          this.onUnauthorized?.(
            "Catalog update rejected (401). Stopping local operation immediately.",
          );
        }
        // A rejected PUT must never leave a cache that seeds a failing register.
        await writeCachedCatalog(
          this.repoFingerprint,
          this.latest,
          this.configDir,
          this.configKey,
        ).catch(() => {});
        throw error;
      }
      await writeCachedCatalog(this.repoFingerprint, merged, this.configDir, this.configKey);
      this.latest = merged;
    });
    // A failed write must not wedge the queue: a later refresh can retry.
    this.chain = task.catch(() => {});
    return task;
  }
}

export interface StartupCatalogProbeOptions {
  definitions: readonly HarnessDefinition[];
  probe: (definition: HarnessDefinition) => Promise<HarnessCatalogEntry>;
  publish: (catalog: HarnessCatalog) => Promise<void>;
  /**
   * The last published catalog. An entry whose probe fails but which was
   * previously discovered is carried over verbatim, so a transient failure
   * cannot erase a known Harness or its effort levels (#240).
   */
  previous?: HarnessCatalog | undefined;
  isAborted?: (() => boolean) | undefined;
  write?: ((line: string) => void) | undefined;
  now?: (() => string) | undefined;
}

/**
 * One bounded startup discovery pass. An empty local registry is a successful detection: publishing an
 * empty catalog lets the server drop Harnesses the Runner no longer has.
 * A harness that is still installed but whose individual probe fails keeps its
 * previous entry; a harness never seen before is omitted. If every probe
 * fails, nothing is published, so the last good catalog survives a transient
 * outage (ADR-0011, #240/#242).
 */
export async function runStartupCatalogProbe(options: StartupCatalogProbeOptions): Promise<void> {
  const aborted = options.isAborted ?? (() => false);
  const write = options.write ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  if (aborted()) return;
  if (options.definitions.length === 0) {
    await options.publish({ harnesses: [], probedAt: now() });
    return;
  }
  const harnesses: HarnessCatalogEntry[] = [];
  let succeeded = 0;
  for (const definition of options.definitions) {
    if (aborted()) return;
    try {
      harnesses.push(await options.probe(definition));
      succeeded += 1;
    } catch (error) {
      write(`Harness ${definition.id} probe failed: ${String(error)}`);
      const prior = options.previous?.harnesses.find((item) => item.id === definition.id);
      if (prior !== undefined) harnesses.push(prior);
    }
  }
  // A partial refresh with at least one success is publishable; restoring a
  // failed harness's prior entry must not count as a successful discovery.
  if (aborted() || succeeded === 0) return;
  await options.publish({ harnesses, probedAt: now() });
}
