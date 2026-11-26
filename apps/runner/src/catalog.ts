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
import { z } from "zod";
import { AcpStdioClient } from "./acp.ts";
import { RunnerRequestError } from "./client.ts";
import { configDirectory } from "./credential.ts";
import { harnessesJsonPath, type HarnessDefinition } from "./harnesses.ts";
import { harnessLockKey, withHarnessLock } from "./harness-lock.ts";

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

/** Turn one raw `session/new` result into a published catalog entry. */
export function catalogEntryFromSession(
  definition: HarnessDefinition,
  session: unknown,
  probedAt: string = new Date().toISOString(),
): HarnessCatalogEntry {
  const info = sessionInfo(session);
  const available = info?.available ?? [];
  const efforts = info?.efforts ?? [];
  const defaultEffort = info?.defaultEffort;
  const defaultModel = info?.currentModelId ?? available[0]?.modelId ?? "default";

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
  return await withHarnessLock(harnessLockKey(definition), async () => {
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
    try {
      await client.requestInBudget(
        "session/set_config_option",
        { sessionId: client.id, optionId: option.id, value: option.value },
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
  options: ProbeModelOptions,
): Promise<boolean> {
  const deadline = Date.now() + RECOVERY_BUDGET_MS;
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
      timeoutMs: RECOVERY_BUDGET_MS,
    });
    client = started.client;
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
  return await withHarnessLock(harnessLockKey(definition), async () => {
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
      });
      client = started.client;
      const initial = sessionInfo(started.session);
      previous = {
        ...(initial?.currentModelId === undefined
          ? options.fallbackModel === undefined
            ? {}
            : { model: options.fallbackModel }
          : { model: initial.currentModelId }),
        options: (initial?.options ?? [])
          .filter((option) => option.currentValue !== undefined)
          .slice(0, MAX_RESTORED_OPTIONS)
          .map((option) => ({ id: option.id, value: option.currentValue! })),
      };
      // ACP reports configOptions for the active model, so read them *after*
      // switching instead of reusing the previous model's effort levels.
      const switched = await client.requestInBudget(
        "session/set_model",
        { sessionId: client.id, modelId },
        deadline,
      );
      const after = sessionInfo(switched);
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
      restored = await recoveryRestore(definition, previous, options);
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
      const merged = mergeHarnessCatalog(this.latest, next);
      await writeCachedCatalog(this.repoFingerprint, merged, this.configDir, this.configKey);
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

export interface StartupCatalogProbeOptions {
  definitions: readonly HarnessDefinition[];
  probe: (definition: HarnessDefinition) => Promise<HarnessCatalogEntry>;
  publish: (catalog: HarnessCatalog) => Promise<void>;
  isAborted?: (() => boolean) | undefined;
  write?: ((line: string) => void) | undefined;
  now?: (() => string) | undefined;
}

/**
 * One bounded startup discovery pass. An empty local registry is a successful
 * detection: publishing an empty catalog lets the server drop Harnesses the
 * Runner no longer has. Definitions that all fail to probe keep the last good
 * catalog instead of wiping it on a transient outage.
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
  for (const definition of options.definitions) {
    if (aborted()) return;
    try {
      harnesses.push(await options.probe(definition));
    } catch (error) {
      write(`Harness ${definition.id} probe failed: ${String(error)}`);
    }
  }
  if (aborted() || harnesses.length === 0) return;
  await options.publish({ harnesses, probedAt: now() });
}
