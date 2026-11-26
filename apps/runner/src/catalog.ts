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
import {
  adapterForHarness,
  type AcpSession,
  type HarnessAdapter,
  isUnsupportedSwitchMethod,
} from "./adapter.ts";
import { RunnerRequestError } from "./client.ts";
import { configDirectory } from "./credential.ts";
import {
  BUILTIN_ACP_HARNESSES,
  commandOnPath,
  harnessLockKey,
  HarnessLocks,
  harnessesJsonPath,
  resolveDefaultHarness,
  type HarnessDefinition,
} from "./harnesses.ts";
import { activeModelEfforts, activeSessionModel, currentConfigValues } from "./probe.ts";

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
  adapter: HarnessAdapter = adapterForHarness(definition),
): HarnessCatalogEntry {
  const discovery = adapter.probeCatalog(initResult, session, probedAt);
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
  /** Defaults to the resolved HarnessAdapter's `probeTimeoutMs`. */
  timeoutMs?: number | undefined;
  env?: Record<string, string> | undefined;
  at?: string | undefined;
  /** Shutdown/401 revocation kills an in-flight probe's process group. */
  signal?: AbortSignal | undefined;
}

/** A bounded ACP discovery session; never leaves a probe process group behind. */
export async function probeHarness(
  definition: HarnessDefinition,
  options: ProbeHarnessOptions,
  adapter: HarnessAdapter = adapterForHarness(definition),
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
    timeoutMs: options.timeoutMs ?? adapter.probeTimeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return catalogEntryFromSession(
    definition,
    initResult,
    session,
    options.at ?? new Date().toISOString(),
    adapter,
  );
}

/** Bounds the restore even when the probe itself ran out of its five seconds. */
const RESTORE_BUDGET_MS = 1500;
const RECOVERY_BUDGET_MS = 2000;
/** ADR-0011: one-shot recovery stays short even if the probe budget is large. */
const MAX_RECOVERY_BUDGET_MS = 5000;
const MAX_RESTORED_OPTIONS = 8;

type PreviousDefaults = {
  model?: string | undefined;
  options: Array<{ id: string; value: string }>;
};

/** The adapter's ACP seam plus the bounded restore RPCs a probe needs. */
export interface ProbeClient extends AcpSession {
  requestInBudget(
    method: string,
    params: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown>;
  forceExit(graceMs: number): Promise<unknown>;
}

export interface StartedProbe {
  client: ProbeClient;
  session: unknown;
  deadline: number;
}

/** Plain function seam; tests can supply a stubbed probe session without a child process. */
export type ProbeStarter = (options: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  mcpServers: unknown[];
  sessionMeta?: Record<string, unknown>;
  worktreeReal: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}) => Promise<StartedProbe>;

export interface ProbeModelOptions extends ProbeHarnessOptions {
  /** Used when a killed probe never reported the active model. */
  fallbackModel?: string | undefined;
  /** Shared with dispatch supervision: never probe and spawn one Harness at once. */
  locks?: HarnessLocks | undefined;
  /** Injectable probe-session factory; defaults to `AcpStdioClient.startProbe`. */
  startProbe?: ProbeStarter | undefined;
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

async function restoreOptionValues(
  client: ProbeClient,
  values: Array<{ id: string; value: string }>,
  deadline: number,
): Promise<boolean> {
  let ok = true;
  for (const option of values) {
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

async function restoreDefaults(
  client: ProbeClient,
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
    } catch (error) {
      if (isUnsupportedSwitchMethod(error)) {
        // A config-option-only harness still needs its previous model restored.
        try {
          await client.requestInBudget(
            "session/set_config_option",
            { sessionId: client.id, configId: "model", value: previous.model },
            deadline,
          );
        } catch {
          ok = false;
        }
      } else {
        ok = false;
      }
    }
  }
  return (await restoreOptionValues(client, previous.options, deadline)) && ok;
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
  const budget = Math.min(
    MAX_RECOVERY_BUDGET_MS,
    Math.max(RECOVERY_BUDGET_MS, options.timeoutMs ?? RECOVERY_BUDGET_MS),
  );
  const deadline = Date.now() + budget;
  const startProbe: ProbeStarter =
    options.startProbe ?? (async (startOptions) => await AcpStdioClient.startProbe(startOptions));
  let client: ProbeClient | undefined;
  try {
    const started = await startProbe({
      command: definition.command,
      args: definition.args,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      mcpServers: [],
      sessionMeta: { orreryProbe: true, orreryRecovery: true },
      worktreeReal: options.cwd,
      timeoutMs: budget,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    client = started.client;
    if (
      options.allowAlreadyRestored === true &&
      previous.model !== undefined &&
      activeSessionModel(started.session) === previous.model
    ) {
      // A brand-new session already opens on the previous default, which may
      // mean a session-scoped switch never touched the CLI default — but an
      // option restored in that old session must still match before we trust it.
      const current = currentConfigValues(started.session);
      const mismatched = previous.options.filter(
        (option) => !current.some((item) => item.id === option.id && item.value === option.value),
      );
      if (mismatched.length === 0) return true;
      return await restoreOptionValues(client, mismatched, deadline);
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
 * model's own configOptions through the resolved adapter, and restore the
 * previous model AND options before the per-Harness lock is released when the
 * adapter says the switch mutates the CLI default. A timeout or kill then
 * triggers a bounded restore attempt and, if needed, a one-shot recovery
 * session (ADR-0011).
 */
export async function probeModel(
  definition: HarnessDefinition,
  modelId: string,
  options: ProbeModelOptions,
  adapter: HarnessAdapter = adapterForHarness(definition),
): Promise<ProbeModelResult> {
  const locks = options.locks ?? new HarnessLocks();
  const timeoutMs = options.timeoutMs ?? adapter.probeTimeoutMs;
  const resolved: ProbeModelOptions = { ...options, timeoutMs };
  return await locks.run(harnessLockKey(definition), async () => {
    if (options.signal?.aborted === true) {
      return {
        status: "restored_after_failure",
        restored: true,
        recovery: false,
        error: "ACP probe aborted before the child was spawned.",
      };
    }
    const deadline = Date.now() + timeoutMs;
    const startProbe: ProbeStarter =
      options.startProbe ?? (async (startOptions) => await AcpStdioClient.startProbe(startOptions));
    let client: ProbeClient | undefined;
    let previous: PreviousDefaults | undefined;
    let discovered: HarnessModel | undefined;
    let didSwitch = false;
    let failure: unknown;
    try {
      const started = await startProbe({
        command: definition.command,
        args: definition.args,
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        mcpServers: [],
        // The registry supplies the command; the control plane only names a model.
        sessionMeta: { orreryProbe: true, orreryProbeModel: modelId },
        worktreeReal: options.cwd,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      client = started.client;
      // One tolerant parser serves every dialect: `models.currentModelId`,
      // `configId` plus `state.currentValue`, and `choices` all read the same.
      const activeModel = activeSessionModel(started.session);
      previous = {
        ...(activeModel === undefined
          ? options.fallbackModel === undefined
            ? {}
            : { model: options.fallbackModel }
          : { model: activeModel }),
        options: currentConfigValues(started.session)
          .filter((option) => option.id !== "model")
          .slice(0, MAX_RESTORED_OPTIONS),
      };
      // ACP reports configOptions for the active model, so read them *after*
      // switching instead of reusing the previous model's effort levels. The
      // resolved adapter owns the dialect (set_model vs config-option, optional
      // post-switch refresh) and returns the payload to publish.
      const switched = await adapter.probeModel(client, modelId, deadline);
      didSwitch = switched.switched;
      // A successful switch that advertised no reasoning options is still a
      // completed discovery: publish `known` with an empty effort list so the
      // UI hides the selector and reselecting the model does not re-probe it
      // forever. Only a failed/timed-out switch leaves it `unknown`.
      const efforts = activeModelEfforts(switched.result);
      discovered = {
        id: modelId,
        reasoningDiscovery: "known",
        supportedEfforts: efforts.supportedEfforts,
        ...(efforts.defaultEffort === undefined ? {} : { defaultEffort: efforts.defaultEffort }),
      };
    } catch (error) {
      failure = error;
      // A hung/killed session never revealed its active model. Use the cached
      // default as the recovery target rather than leaving the CLI mutated.
      if (previous === undefined && options.fallbackModel !== undefined) {
        previous = { model: options.fallbackModel, options: [] };
      }
    }

    // A switch that timed out or killed the probe may already have mutated the
    // CLI default, so a failed probe must be restored just like a successful one.
    const mutatedDefault =
      adapter.modelSwitchMutatesCliDefault && (didSwitch || failure !== undefined);
    let restored = false;
    if (client !== undefined) {
      // No RPC switch or a session-scoped switch never touched the persisted
      // CLI default, so there is nothing to restore (no recovery client either).
      restored = !mutatedDefault;
      if (mutatedDefault && previous !== undefined) {
        try {
          restored = await restoreDefaults(client, previous, Date.now() + RESTORE_BUDGET_MS);
        } catch {
          restored = false;
        }
      }
      await client.forceExit(250);
    }
    let recovery = false;
    if (mutatedDefault && !restored && previous !== undefined) {
      recovery = true;
      restored = await recoveryRestore(definition, previous, {
        ...resolved,
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
 * (ADR-0011). The resolved omitted-harness default and the set of installed
 * preset binaries are folded in as well, so installing or removing a Harness
 * on PATH invalidates a stale cache instead of reusing it.
 */
export function harnessConfigKey(
  options: {
    acpOverride?: { command: string; args: readonly string[] } | undefined;
    configDir?: string | undefined;
    pathEnv?: string | undefined;
    defaultHarness?: HarnessDefinition | null | undefined;
  } = {},
): string {
  const configDir = options.configDir ?? configDirectory();
  let harnessesText: string | null = null;
  try {
    harnessesText = readFileSync(harnessesJsonPath(configDir), "utf8");
  } catch {
    // No user registry file: the override alone identifies the configuration.
  }
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const installedPresets = BUILTIN_ACP_HARNESSES.filter((preset) =>
    commandOnPath(preset.command, pathEnv),
  ).map((preset) => preset.id);
  const resolvedDefault =
    options.defaultHarness !== undefined
      ? options.defaultHarness
      : (resolveDefaultHarness({
          ...(options.acpOverride === undefined ? {} : { acpOverride: options.acpOverride }),
          configDir,
          pathEnv,
        }) ?? null);
  return createHash("sha256")
    .update(
      JSON.stringify([
        options.acpOverride ?? null,
        harnessesText,
        installedPresets,
        resolvedDefault,
      ]),
    )
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
