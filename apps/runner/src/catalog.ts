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
import { z } from "zod";
import { AcpStdioClient } from "./acp.ts";
import { RunnerRequestError } from "./client.ts";
import { configDirectory } from "./credential.ts";
import type { HarnessDefinition } from "./harnesses.ts";
import { withHarnessLock } from "./harness-lock.ts";

/** ACP config option ids that carry reasoning-effort choices for the active model. */
export const REASONING_OPTION_IDS = new Set([
  "thought_level",
  "reasoning_effort",
  "reasoningEffort",
  "reasoning_level",
  "effort",
  "thinking_level",
]);

const AcpSessionNew = z.object({
  sessionId: z.string().optional(),
  models: z
    .object({
      availableModels: z
        .array(z.object({ modelId: z.string().min(1), name: z.string().optional() }))
        .optional(),
      currentModelId: z.string().optional(),
    })
    .optional(),
  configOptions: z
    .array(
      z.object({
        id: z.string(),
        options: z
          .array(z.object({ value: z.string().min(1), name: z.string().optional() }))
          .optional(),
        currentValue: z.string().optional(),
      }),
    )
    .optional(),
});

/** Turn one raw `session/new` result into a published catalog entry. */
export function catalogEntryFromSession(
  definition: HarnessDefinition,
  session: unknown,
  probedAt: string = new Date().toISOString(),
): HarnessCatalogEntry {
  const parsed = AcpSessionNew.safeParse(session);
  const available = parsed.success ? (parsed.data.models?.availableModels ?? []) : [];
  const options = parsed.success ? (parsed.data.configOptions ?? []) : [];
  const reasoning = options.find((option) => REASONING_OPTION_IDS.has(option.id));
  const efforts = [...new Set((reasoning?.options ?? []).map((option) => option.value))];
  const currentValue = reasoning?.currentValue;
  const defaultEffort =
    currentValue !== undefined && efforts.includes(currentValue) ? currentValue : efforts[0];
  const currentModelId = parsed.success ? parsed.data.models?.currentModelId : undefined;
  const defaultModel = currentModelId ?? available[0]?.modelId ?? "default";

  const models: HarnessModel[] = [];
  for (const model of available) {
    // ACP only reports configOptions for the currently active model. Everything
    // else stays `unknown` until a targeted probe discovers its effort levels.
    const known = model.modelId === defaultModel && efforts.length > 0;
    const published: HarnessModel = {
      id: model.modelId,
      reasoningDiscovery: known ? "known" : "unknown",
    };
    if (model.name !== undefined && model.name !== "") published.label = model.name;
    if (known) {
      published.supportedEfforts = efforts;
      if (defaultEffort !== undefined) published.defaultEffort = defaultEffort;
    }
    models.push(published);
  }

  return {
    id: definition.id,
    displayName: definition.displayName,
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
  return await withHarnessLock(definition.id, async () => {
    const session = await AcpStdioClient.probe({
      command: definition.command,
      args: definition.args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      mcpServers: [],
      // Lets a test stub tell a discovery session from a real dispatch session.
      sessionMeta: { orreryProbe: true },
      worktreeReal: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    return catalogEntryFromSession(definition, session, options.at ?? new Date().toISOString());
  });
}

/**
 * One Runner owns one checkout: the cache is keyed by its opaque fingerprint so
 * two Runners on the same host cannot overwrite each other's catalog or the
 * `--acp-command` overrides that produced it (ADR-0011).
 */
export function catalogCachePath(repoFingerprint: string, configDir = configDirectory()): string {
  return join(configDir, `harness-catalog-${repoFingerprint}.json`);
}

/** The last successfully published catalog, used to seed a fast startup register. */
export function readCachedCatalog(
  repoFingerprint: string,
  configDir = configDirectory(),
): HarnessCatalog | null {
  let text: string;
  try {
    text = readFileSync(catalogCachePath(repoFingerprint, configDir), "utf8");
  } catch {
    return null;
  }
  const parsed = HarnessCatalog.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

export async function writeCachedCatalog(
  repoFingerprint: string,
  value: HarnessCatalog,
  configDir = configDirectory(),
): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = catalogCachePath(repoFingerprint, configDir);
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
  private readonly onUnauthorized: ((message: string) => void) | undefined;

  constructor(options: CatalogPublisherOptions) {
    this.client = options.client;
    this.runnerId = options.runnerId;
    this.repoFingerprint = options.repoFingerprint;
    this.configDir = options.configDir ?? configDirectory();
    this.onUnauthorized = options.onUnauthorized;
    this.latest = readCachedCatalog(this.repoFingerprint, this.configDir) ?? EMPTY_HARNESS_CATALOG;
  }

  get current(): HarnessCatalog {
    return this.latest;
  }

  publish(next: HarnessCatalog): Promise<void> {
    const task = this.chain.then(async () => {
      const merged = mergeHarnessCatalog(this.latest, next);
      await writeCachedCatalog(this.repoFingerprint, merged, this.configDir);
      try {
        await this.client.putCatalog(this.runnerId, merged);
      } catch (error) {
        if (error instanceof RunnerRequestError && error.status === 401) {
          this.onUnauthorized?.(
            "Catalog update rejected (401). Stopping local operation immediately.",
          );
        }
        throw error;
      }
      this.latest = merged;
    });
    // A failed write must not wedge the queue: a later refresh can retry.
    this.chain = task.catch(() => {});
    return task;
  }
}
