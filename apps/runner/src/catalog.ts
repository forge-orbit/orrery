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
import {
  harnessLockKey,
  HarnessLocks,
  harnessesJsonPath,
  type HarnessDefinition,
} from "./harnesses.ts";
import { activeSessionModel, parseDiscovery } from "./probe.ts";
import { z } from "zod";

/** ACP config option ids that carry reasoning-effort choices for the active model. */
export const REASONING_OPTION_IDS = new Set([
  "thought_level",
  "reasoning_effort",
  "effort",
  "thinking_level",
]);

const AcpSessionNew = z.object({
  models: z
    .object({
      availableModels: z
        .array(z.object({ modelId: z.string(), name: z.string().optional() }))
        .optional(),
      currentModelId: z.string().optional(),
    })
    .optional(),
  configOptions: z
    .array(
      z.object({
        id: z.string(),
        options: z.array(z.object({ value: z.string() })).optional(),
        currentValue: z.string().optional(),
      }),
    )
    .optional(),
});

interface SessionInfo {
  available: Array<{ modelId: string; name?: string | undefined }>;
  options: Array<{
    id: string;
    values: string[];
    currentValue?: string | undefined;
  }>;
  efforts: string[];
  defaultEffort?: string | undefined;
  currentModelId?: string | undefined;
}

/** Parse the raw `session/new` (or model-switch) result without trusting it. */
function sessionInfo(session: unknown): SessionInfo | undefined {
  const parsed = AcpSessionNew.safeParse(session);
  if (!parsed.success) return undefined;
  const available = parsed.data.models?.availableModels ?? [];
  const options = (parsed.data.configOptions ?? []).map((option) =>
    Object.assign(
      { id: option.id, values: (option.options ?? []).map((item) => item.value) },
      option.currentValue === undefined ? {} : { currentValue: option.currentValue },
    ),
  );
  const reasoning = options.find((option) => REASONING_OPTION_IDS.has(option.id));
  const efforts = [...new Set(reasoning?.values ?? [])];
  const currentValue = reasoning?.currentValue;
  const defaultEffort =
    currentValue !== undefined && efforts.includes(currentValue) ? currentValue : efforts[0];
  return {
    available,
    options,
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(parsed.data.models?.currentModelId === undefined
      ? {}
      : { currentModelId: parsed.data.models.currentModelId }),
  };
}

/**
 * Return a Harness's cached default model only when it is a real advertised
 * model id (PR #260 stores synthetic `defaultModel: "default"` when a harness
 * advertises 0 models, which must never be sent to `session/set_model`).
 */
export function verifiedDefaultModel(
  catalog: HarnessCatalog | null | undefined,
  harnessId: string,
): string | null {
  const entry = catalog?.harnesses.find((item) => item.id === harnessId);
  if (entry === undefined) return null;
  return entry.models.some((model) => model.id === entry.defaultModel) ? entry.defaultModel : null;
}

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

/** A bounded ACP discovery session; never leaves a probe process group behind. */
export async function probeHarness(
  definition: HarnessDefinition,
  options: ProbeHarnessOptions,
): Promise<HarnessCatalogEntry> {
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

/** Bounds the restore even when the probe itself ran out of its five seconds. */
const RESTORE_BUDGET_MS = 1500;
const RECOVERY_BUDGET_MS = 2000;
const MAX_RESTORED_OPTIONS = 8;

type PreviousDefaults = {
  model?: string | undefined;
  options: Array<{ id: string; value: string }>;
};

export interface ProbeModelOptions extends ProbeHarnessOptions {
  /** Used when a killed probe never reported the active model. */
  fallbackModel?: string | undefined;
  /** Shared with dispatch supervision: never probe and spawn one Harness at once. */
  locks?: HarnessLocks | undefined;
}

export type ProbeModelStatus =
  | "ok"
  | "restored_after_timeout"
  | "restored_after_failure"
  | "restore_failed";

export interface ProbeModelResult {
  status: ProbeModelStatus;
  /** Defined only when model-specific efforts were actually discovered. */
  model?: HarnessModel;
  restored: boolean;
  /** True when a fresh one-shot session had to restore the CLI default. */
  recovery: boolean;
  error?: string;
}

async function restoreDefaults(
  client: AcpStdioClient,
  previous: PreviousDefaults,
  deadline: number,
): Promise<boolean> {
  let ok = true;
  if (previous.model !== undefined) {
    try {
      await client.requestInBudget(
        "session/set_model",
        { sessionId: client.id, modelId: previous.model },
        deadline,
      );
    } catch {
      ok = false;
    }
  }
  for (const option of previous.options) {
    if (option.id === "model") continue;
    try {
      await client.requestInBudget(
        "session/set_config_option",
        { sessionId: client.id, configId: option.id, value: option.value },
        deadline,
      );
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * A killed/hung probe cannot restore its own process. Start one short, local
 * recovery session against the same registry entry and put the CLI's persisted
 * default back. Never uses a path or command supplied by the control plane.
 */
async function recoveryRestore(
  definition: HarnessDefinition,
  previous: PreviousDefaults,
  options: ProbeModelOptions & { allowAlreadyRestored?: boolean },
): Promise<boolean> {
  const budget = Math.max(RECOVERY_BUDGET_MS, options.timeoutMs);
  const deadline = Date.now() + budget;
  let client: AcpStdioClient | undefined;
  try {
    const started = await AcpStdioClient.startProbe({
      command: definition.command,
      args: definition.args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      mcpServers: [],
      sessionMeta: { orreryProbe: true, orreryRecovery: true },
      worktreeReal: options.cwd,
      timeoutMs: budget,
    });
    client = started.client;
    if (
      options.allowAlreadyRestored === true &&
      previous.model !== undefined &&
      activeSessionModel(started.session) === previous.model
    ) {
      // A brand-new session already opens on the previous default: the
      // successful switch was session-scoped and never mutated the CLI default.
      return true;
    }
    return await restoreDefaults(client, previous, deadline);
  } catch {
    return false;
  } finally {
    await client?.forceExit(250);
  }
}

/**
 * Switch one Harness's active model for a bounded ACP session, read that
 * model's own configOptions, and restore the previous model AND options before
 * the per-Harness lock is released. A timeout or kill triggers a bounded
 * restore attempt and, if needed, a one-shot recovery session (ADR-0011).
 */
export async function probeModel(
  definition: HarnessDefinition,
  modelId: string,
  options: ProbeModelOptions,
): Promise<ProbeModelResult> {
  const locks = options.locks ?? new HarnessLocks();
  return await locks.run(harnessLockKey(definition), async () => {
    if (options.signal?.aborted === true) {
      return {
        status: "restored_after_failure",
        restored: true,
        recovery: false,
        error: "ACP probe aborted before the child was spawned.",
      };
    }
    const deadline = Date.now() + options.timeoutMs;
    let client: AcpStdioClient | undefined;
    let previous: PreviousDefaults | undefined;
    let discovered: HarnessModel | undefined;
    let failure: unknown;
    try {
      const started = await AcpStdioClient.startProbe({
        command: definition.command,
        args: definition.args,
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        mcpServers: [],
        // The registry supplies the command; the control plane only names a model.
        sessionMeta: { orreryProbe: true, orreryProbeModel: modelId },
        worktreeReal: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      client = started.client;
      const initial = sessionInfo(started.session);
      const hasModelConfigOption =
        initial?.options.some((option) => option.id === "model") ?? false;
      previous = {
        ...(initial?.currentModelId === undefined
          ? options.fallbackModel === undefined
            ? {}
            : { model: options.fallbackModel }
          : { model: initial.currentModelId }),
        options: (initial?.options ?? [])
          .filter((option) => option.id !== "model" && option.currentValue !== undefined)
          .slice(0, MAX_RESTORED_OPTIONS)
          .map((option) => ({ id: option.id, value: option.currentValue! })),
      };
      // ACP reports configOptions for the active model, so read them *after*
      // switching instead of reusing the previous model's effort levels.
      // Some ACP v1 adapters (e.g. Hermes) return `{}` from `session/set_model`
      // and only return updated `configOptions` from `session/set_config_option`.
      let switched = await client.requestInBudget(
        "session/set_model",
        { sessionId: client.id, modelId },
        deadline,
      );
      let after = sessionInfo(switched);
      if (hasModelConfigOption && (after === undefined || after.options.length === 0)) {
        switched = await client.requestInBudget(
          "session/set_config_option",
          { sessionId: client.id, configId: "model", value: modelId },
          deadline,
        );
        after = sessionInfo(switched);
      }
      if (after !== undefined) {
        // A successful switch that advertised no reasoning options is still a
        // completed discovery: publish `known` with an empty effort list so the
        // UI hides the selector and reselecting the model does not re-probe it
        // forever. Only a failed/timed-out switch leaves it `unknown`.
        discovered = {
          id: modelId,
          reasoningDiscovery: "known",
          supportedEfforts: after.efforts,
          ...(after.defaultEffort === undefined ? {} : { defaultEffort: after.defaultEffort }),
        };
      }
    } catch (error) {
      failure = error;
      // A hung/killed session never revealed its active model. Use the cached
      // default as the recovery target rather than leaving the CLI mutated.
      if (previous === undefined && options.fallbackModel !== undefined) {
        previous = { model: options.fallbackModel, options: [] };
      }
    }

    let restored = false;
    if (client !== undefined && previous !== undefined) {
      try {
        restored = await restoreDefaults(client, previous, Date.now() + RESTORE_BUDGET_MS);
      } catch {
        restored = false;
      }
      await client.forceExit(250);
    }
    let recovery = false;
    if (!restored && previous !== undefined) {
      recovery = true;
      restored = await recoveryRestore(definition, previous, {
        ...options,
        allowAlreadyRestored: failure === undefined && discovered !== undefined,
      });
    }

    const detail =
      failure === undefined
        ? undefined
        : failure instanceof Error
          ? failure.message
          : JSON.stringify(failure);
    if (!restored) {
      return {
        status: "restore_failed",
        ...(discovered === undefined ? {} : { model: discovered }),
        restored: false,
        recovery,
        ...(detail === undefined ? {} : { error: detail }),
      };
    }
    if (failure !== undefined) {
      return {
        status:
          detail?.includes("timed out") === true
            ? "restored_after_timeout"
            : "restored_after_failure",
        ...(discovered === undefined ? {} : { model: discovered }),
        restored: true,
        recovery,
        ...(detail === undefined ? {} : { error: detail }),
      };
    }
    return {
      status: "ok",
      ...(discovered === undefined ? {} : { model: discovered }),
      restored: true,
      recovery,
    };
  });
}

/**
 * Fold one newly discovered model into the locally cached catalog. Previously
 * known effort levels are never dropped, even if a probe returns fewer options.
 */
export function catalogWithProbedModel(
  catalog: HarnessCatalog,
  definition: HarnessDefinition,
  model: HarnessModel,
  probedAt: string = new Date().toISOString(),
): HarnessCatalog {
  const existing = catalog.harnesses.find((item) => item.id === definition.id);
  const prior = existing?.models.find((item) => item.id === model.id);
  const efforts = [
    ...new Set([...(prior?.supportedEfforts ?? []), ...(model.supportedEfforts ?? [])]),
  ];
  const updated: HarnessModel = {
    ...model,
    ...(prior?.label === undefined ? {} : { label: prior.label }),
    reasoningDiscovery: "known",
    supportedEfforts: efforts,
    ...(prior?.defaultEffort === undefined ? {} : { defaultEffort: prior.defaultEffort }),
  };
  const entry: HarnessCatalogEntry = {
    id: definition.id,
    displayName: definition.displayName,
    defaultModel: existing?.defaultModel ?? model.id,
    models:
      existing === undefined
        ? [updated]
        : prior === undefined
          ? [...existing.models, updated]
          : existing.models.map((item) => (item.id === model.id ? updated : item)),
    probedAt,
  };
  return {
    probedAt,
    harnesses: [...catalog.harnesses.filter((item) => item.id !== definition.id), entry],
  };
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
  /** Server-stored catalog from registerRunner, used when local cache is missing/cold. */
  initial?: HarnessCatalog | undefined;
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
    const cached = readCachedCatalog(this.repoFingerprint, this.configDir, this.configKey);
    this.latest =
      cached !== null && options.initial !== undefined
        ? mergeHarnessCatalog(options.initial, cached)
        : (cached ?? options.initial ?? EMPTY_HARNESS_CATALOG);
  }

  get current(): HarnessCatalog {
    return this.latest;
  }

  publish(next: HarnessCatalog): Promise<void> {
    const task = this.chain.then(async () => {
      // Validate the merged result before it can reach the cache or the server:
      // a single oversized probe entry must not disable discovery for good.
      const merged: HarnessCatalog = HarnessCatalog.parse(mergeHarnessCatalog(this.latest, next));
      let response: unknown;
      try {
        response = await this.client.putCatalog(this.runnerId, merged);
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
      const serverCatalog =
        typeof response === "object" && response !== null && "harnessCatalog" in response
          ? HarnessCatalog.safeParse(response.harnessCatalog)
          : null;
      const persisted = serverCatalog?.success ? serverCatalog.data : merged;
      await writeCachedCatalog(this.repoFingerprint, persisted, this.configDir, this.configKey);
      this.latest = persisted;
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
  /** Shared with dispatch supervision: never probe and spawn one Harness at once. */
  locks?: HarnessLocks | undefined;
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
  const locks = options.locks ?? new HarnessLocks();
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
      harnesses.push(await locks.run(harnessLockKey(definition), () => options.probe(definition)));
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
