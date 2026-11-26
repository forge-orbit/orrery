import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { HarnessCatalog, mergeHarnessCatalog, type HarnessCatalogEntry } from "@orrery/contract";
import type { OrreryClient } from "./client.ts";
import { configDirectory } from "./credential.ts";
import { discoverHarnesses, HarnessLocks, type AcpOverride } from "./harnesses.ts";
import { entryFromProbe, probeHarness } from "./probe.ts";

/**
 * Local Harness catalog cache and background discovery for `orrery-runner
 * start` (issue #240). The catalog is cached in the runner config directory,
 * seeded into registration, probed in the background with strict timeouts,
 * and pushed via `PUT /api/runners/{runnerId}/catalog` so five-second
 * heartbeats stay lean (`activeSlotCount` only).
 */

const CATALOG_CACHE_FILE = "harness-catalog.json";

export function catalogCachePath(configDir = configDirectory()): string {
  return `${configDir}/${CATALOG_CACHE_FILE}`;
}

/** Reads the cached catalog; a malformed or missing file reads as none. */
export async function readCatalogCache(
  configDir = configDirectory(),
): Promise<HarnessCatalog | null> {
  try {
    const parsed = HarnessCatalog.safeParse(
      JSON.parse(await readFile(catalogCachePath(configDir), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeCatalogCache(
  catalog: HarnessCatalog,
  configDir = configDirectory(),
): Promise<void> {
  const path = catalogCachePath(configDir);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode is masked by the process umask; enforce it explicitly.
  await chmod(path, 0o600);
}

/**
 * Serialized catalog writer: every publish merges into the local state (so a
 * slower startup probe can never regress a known model's effort levels back
 * to "unknown"), rewrites the local cache, then PUTs once to Orrery. Writes
 * never interleave — each publish awaits the previous one.
 */
export class CatalogPublisher {
  private catalog: HarnessCatalog;
  private queue: Promise<void> = Promise.resolve();
  private readonly client: OrreryClient;
  private readonly runnerId: string;
  private readonly configDir: string;

  constructor(
    client: OrreryClient,
    runnerId: string,
    initial: HarnessCatalog | null,
    configDir = configDirectory(),
  ) {
    this.client = client;
    this.runnerId = runnerId;
    this.configDir = configDir;
    this.catalog = initial ?? { harnesses: [], updatedAt: new Date().toISOString() };
  }

  get localCatalog(): HarnessCatalog {
    return this.catalog;
  }

  /** Merge, cache, and upload; serialized behind every earlier publish. */
  publish(incoming: HarnessCatalog): Promise<void> {
    const write = this.queue.then(async () => {
      this.catalog = mergeHarnessCatalog(this.catalog, incoming);
      await writeCatalogCache(this.catalog, this.configDir);
      await this.client.updateCatalog(this.runnerId, this.catalog);
    });
    // The queue must survive a rejected write so later publishes still run.
    this.queue = write.catch(() => {});
    return write;
  }

  /** Publishes the current local state once (e.g. the seed after registering). */
  sync(): Promise<void> {
    const snapshot: HarnessCatalog = { ...this.catalog, updatedAt: new Date().toISOString() };
    return this.publish(snapshot);
  }
}

export interface CatalogSyncOptions {
  client: OrreryClient;
  runnerId: string;
  /** The cached catalog read before registration, or null when none exists. */
  initial: HarnessCatalog | null;
  /** The supervision ACP override (`--acp-command` / `--acp-arg`). */
  override: AcpOverride | undefined;
  cwd: string;
  signal: AbortSignal;
  write?: ((line: string) => void) | undefined;
  configDir?: string | undefined;
  /** Shared with dispatch supervision: never probe and spawn one Harness at once. */
  locks?: HarnessLocks | undefined;
}

/**
 * Background Harness discovery: seed the server with the local catalog state
 * (empty when there is no cache, so the Fleet sees the Runner immediately),
 * then probe every detected Harness and publish each result as it lands.
 * Catalog discovery is best-effort, but never silent: failures are written
 * to the runner log and the local cache recovers on the next start.
 */
export function startCatalogSync(options: CatalogSyncOptions): {
  publisher: CatalogPublisher;
  done: Promise<void>;
} {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configDir = options.configDir ?? configDirectory();
  const locks = options.locks ?? new HarnessLocks();
  const publisher = new CatalogPublisher(
    options.client,
    options.runnerId,
    options.initial,
    configDir,
  );
  const done = (async () => {
    try {
      // Registration already seeded a cached catalog; without one, PUT the
      // empty state so the Fleet shows a catalog before probing finishes.
      if (options.initial === null) await publisher.sync();
      const harnesses = await discoverHarnesses(options.override, configDir);
      for (const harness of harnesses) {
        if (options.signal.aborted) return;
        // The probe may temporarily switch this Harness's default model, so a
        // Dispatch spawn for the same Harness waits for it (issue #241).
        const outcome = await locks.run(harness.id, () =>
          probeHarness(harness, { cwd: options.cwd, signal: options.signal }),
        );
        if (!outcome.ok) {
          write(`Harness probe failed for ${harness.id}: ${outcome.reason}`);
          continue;
        }
        const entry: HarnessCatalogEntry = entryFromProbe(harness, outcome);
        write(
          `Harness ${entry.id} probed: ${entry.models.length} model(s)${
            entry.defaultModel === null ? "" : `, default ${entry.defaultModel}`
          }.`,
        );
        await publisher.publish({ harnesses: [entry], updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      if (!options.signal.aborted) write(`Harness catalog sync failed: ${String(error)}`);
    }
  })();
  return { publisher, done };
}
