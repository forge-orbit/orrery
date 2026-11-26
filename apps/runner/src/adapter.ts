import { basename } from "node:path";
import { isReservedHarnessId, type HarnessDefinition } from "./harnesses.ts";
import {
  activeSessionModel,
  effortConfigIds,
  hasConfigOption,
  hasConfigOptions,
  parseDiscovery,
  type Discovery,
} from "./probe.ts";

/**
 * Harness-specific ACP behavior, injected through plain arguments. No DI
 * container and no decorators: callers resolve one adapter per Harness and
 * pass it to the catalog probe and dispatch supervision functions.
 *
 * The interface stays small on purpose: transport, locks, leases and process
 * teardown belong to the callers; an adapter only decides *what* an ACP
 * conversation looks like for one Harness dialect.
 */
export interface HarnessAdapter {
  /** Total budget for a startup catalog probe or an on-demand model probe. */
  readonly probeTimeoutMs: number;
  /**
   * Whether a successful model switch mutates the Harness's persisted CLI
   * default. Session-scoped switches need no restore/recovery; CLI-default
   * switches must be restored before the per-Harness lock is released.
   */
  readonly modelSwitchMutatesCliDefault: boolean;
  /** Interpret one bounded discovery session's payloads into catalog models. */
  probeCatalog(initResult: unknown, sessionResult: unknown, probedAt: string): Discovery;
  /** Switch one probe session to a model and read its post-switch options. */
  probeModel(session: AcpSession, modelId: string, deadline: number): Promise<ProbeSwitchResult>;
  /** Apply model and effort to a dispatch session before its first prompt. */
  applyDispatchOptions(
    session: AcpSession,
    options: DispatchOptionsInput,
  ): Promise<DispatchOptionsResult>;
}

/** The only ACP surface an adapter needs; `AcpStdioClient` satisfies it directly. */
export interface AcpSession {
  readonly id: string;
  readonly sessionResult: unknown;
  /** No timeout when omitted (dispatch); probe callers pass a shared deadline. */
  requestAcp(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface ProbeSwitchResult {
  /** Result of the last switch RPC; the caller parses it with `probe.ts`. */
  readonly result: unknown;
  /** False when the session already opened on the requested model. */
  readonly switched: boolean;
}

export interface DispatchOptionsInput {
  model?: string | undefined;
  effort?: string | undefined;
}

export interface DispatchOptionsResult {
  readonly modelSwitched: boolean;
  readonly effortApplied: boolean;
}

/** Pure resolver; overrides are injected as a plain function in tests and at startup. */
export type AdapterResolver = (definition: HarnessDefinition) => HarnessAdapter;

export type ModelSwitchMethod = "config-option" | "set_model";

export interface GenericAcpAdapterOptions {
  probeTimeoutMs?: number;
  /** Switch RPC used by catalog/model probes. */
  probeSwitchMethod?: ModelSwitchMethod;
  /** Preferred switch RPC at dispatch time; the other one is the fallback. */
  dispatchSwitchMethod?: ModelSwitchMethod;
  /**
   * Some v1 adapters only advertise the new model's configOptions from a
   * `session/set_config_option` read after `session/set_model` succeeded.
   */
  refreshConfigOptionsAfterSwitch?: boolean;
  modelSwitchMutatesCliDefault?: boolean;
}

const remaining = (deadline: number): number => Math.max(1, deadline - Date.now());

/**
 * Only a dialect refusal justifies retrying the other switch RPC. A timeout or
 * a dead process must keep its original failure: a hung set_model may already
 * have mutated the CLI default, and a retry on a dead session hides that.
 */
export function isUnsupportedSwitchMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unsupported|not found|invalid method|unknown method/i.test(message) &&
    !/timed out|exited/i.test(message)
  );
}

/**
 * Safe default for `--acp-command` overrides and user-defined harnesses: read
 * the dialect from the session instead of assuming a named harness's quirks,
 * and always restore a mutated CLI default.
 */
export class GenericAcpAdapter implements HarnessAdapter {
  readonly probeTimeoutMs: number;
  readonly modelSwitchMutatesCliDefault: boolean;
  readonly probeSwitchMethod: ModelSwitchMethod;
  readonly dispatchSwitchMethod: ModelSwitchMethod;
  readonly refreshConfigOptionsAfterSwitch: boolean;

  constructor(options: GenericAcpAdapterOptions = {}) {
    this.probeTimeoutMs = Math.max(1, Math.floor(options.probeTimeoutMs ?? 5000));
    this.modelSwitchMutatesCliDefault = options.modelSwitchMutatesCliDefault ?? true;
    this.probeSwitchMethod = options.probeSwitchMethod ?? "set_model";
    this.dispatchSwitchMethod = options.dispatchSwitchMethod ?? "config-option";
    this.refreshConfigOptionsAfterSwitch = options.refreshConfigOptionsAfterSwitch ?? false;
  }

  probeCatalog(initResult: unknown, sessionResult: unknown, probedAt: string): Discovery {
    return parseDiscovery(initResult, sessionResult, probedAt);
  }

  private async switchModel(
    session: AcpSession,
    modelId: string,
    method: ModelSwitchMethod,
    deadline?: number,
  ): Promise<unknown> {
    const methodName = method === "set_model" ? "session/set_model" : "session/set_config_option";
    const params =
      method === "set_model"
        ? { sessionId: session.id, modelId }
        : { sessionId: session.id, configId: "model", value: modelId };
    return await session.requestAcp(
      methodName,
      params,
      deadline === undefined ? undefined : remaining(deadline),
    );
  }

  async probeModel(
    session: AcpSession,
    modelId: string,
    deadline: number,
  ): Promise<ProbeSwitchResult> {
    if (activeSessionModel(session.sessionResult) === modelId) {
      // `session/new` already opened on the requested model: reusing its
      // configOptions avoids a redundant (and possibly rejected) switch.
      return { result: session.sessionResult, switched: false };
    }
    const hasModelConfigOption = hasConfigOption(session.sessionResult, "model");
    // Try the adapter's preferred dialect first, then the other one. A harness
    // that only implements one of the two switch RPCs still probes cleanly.
    const methods: ModelSwitchMethod[] =
      this.probeSwitchMethod === "set_model"
        ? ["set_model", "config-option"]
        : ["config-option", "set_model"];
    let result: unknown;
    let usedMethod: ModelSwitchMethod | undefined;
    let firstError: unknown;
    for (const method of methods) {
      try {
        result = await this.switchModel(session, modelId, method, deadline);
        usedMethod = method;
        break;
      } catch (error) {
        firstError ??= error;
        if (!isUnsupportedSwitchMethod(error)) throw error;
      }
    }
    if (usedMethod === undefined) throw firstError;

    if (
      usedMethod === "config-option" &&
      usedMethod === this.probeSwitchMethod &&
      !hasConfigOptions(result)
    ) {
      // A config-option-only adapter may answer with `configOptions: []`. The
      // switch already succeeded, so keep that empty discovery when the other
      // dialect is unsupported — never turn it into a probe failure.
      try {
        const alternative = await this.switchModel(session, modelId, "set_model", deadline);
        if (hasConfigOptions(alternative)) result = alternative;
      } catch {
        // Optional dialect extension; the successful switch result stands.
      }
    } else if (
      usedMethod === "set_model" &&
      (this.refreshConfigOptionsAfterSwitch || (hasModelConfigOption && !hasConfigOptions(result)))
    ) {
      // A successful switch that advertised no configOptions is still a
      // completed discovery: try one config-option read for fresh efforts.
      try {
        const refreshed = await this.switchModel(session, modelId, "config-option", deadline);
        if (hasConfigOptions(refreshed)) result = refreshed;
      } catch (error) {
        // Only an unsupported dialect is optional. A timeout or a killed
        // process must surface so the caller can restore the CLI default.
        if (!isUnsupportedSwitchMethod(error)) throw error;
      }
    }
    return { result, switched: true };
  }

  async applyDispatchOptions(
    session: AcpSession,
    options: DispatchOptionsInput,
  ): Promise<DispatchOptionsResult> {
    const requested = options.model;
    let switchResult: unknown;
    let usedDispatchMethod: ModelSwitchMethod | undefined;
    // `session/new` may already be on the requested model: a second switch is
    // redundant and can reject a perfectly usable default (#241).
    if (requested !== undefined && activeSessionModel(session.sessionResult) !== requested) {
      const methods: ModelSwitchMethod[] =
        this.dispatchSwitchMethod === "set_model"
          ? ["set_model", "config-option"]
          : ["config-option", "set_model"];
      let lastError: unknown;
      for (const method of methods) {
        try {
          switchResult = await this.switchModel(session, requested, method);
          usedDispatchMethod = method;
          break;
        } catch (error) {
          lastError = error;
          // A real model rejection must reach the diagnostic mapper, not be
          // masked by a different error from the fallback RPC.
          if (!isUnsupportedSwitchMethod(error)) throw error;
        }
      }
      if (usedDispatchMethod === undefined) throw lastError;
      if (this.refreshConfigOptionsAfterSwitch && usedDispatchMethod === "set_model") {
        try {
          switchResult = await this.switchModel(session, requested, "config-option");
        } catch (error) {
          if (!isUnsupportedSwitchMethod(error)) throw error;
        }
      }
    }

    let effortApplied = false;
    if (options.effort !== undefined) {
      for (const configId of effortConfigIds(switchResult, requested, session.sessionResult)) {
        try {
          await session.requestAcp("session/set_config_option", {
            sessionId: session.id,
            configId,
            value: options.effort,
          });
          effortApplied = true;
          break;
        } catch {
          // An unsupported effort is non-fatal: try the next advertised id.
        }
      }
    }
    return { modelSwitched: usedDispatchMethod !== undefined, effortApplied };
  }
}

/** OpenCode uses the native `session/set_model` extension at dispatch time. */
export class OpenCodeAdapter extends GenericAcpAdapter {
  constructor(options: GenericAcpAdapterOptions = {}) {
    super({ probeSwitchMethod: "set_model", dispatchSwitchMethod: "set_model", ...options });
  }
}

/**
 * Hermes' `session/set_config_option` switches and returns the new model's
 * configOptions in one RPC, so no second refresh is needed. Its switches are
 * session-scoped: probing must never trip the harness's `-contributor` guard.
 */
export class HermesAdapter extends GenericAcpAdapter {
  constructor(options: GenericAcpAdapterOptions = {}) {
    super({
      probeTimeoutMs: 8000,
      probeSwitchMethod: "config-option",
      dispatchSwitchMethod: "config-option",
      modelSwitchMutatesCliDefault: false,
      ...options,
    });
  }
}

/** Oh My Pi switches with `session/set_model` and keeps switches session-scoped. */
export class OmpAdapter extends GenericAcpAdapter {
  constructor(options: GenericAcpAdapterOptions = {}) {
    super({
      probeSwitchMethod: "set_model",
      dispatchSwitchMethod: "set_model",
      modelSwitchMutatesCliDefault: false,
      ...options,
    });
  }
}

export const genericAcpAdapter: HarnessAdapter = new GenericAcpAdapter();
export const openCodeAdapter: HarnessAdapter = new OpenCodeAdapter();
export const hermesAdapter: HarnessAdapter = new HermesAdapter();
export const ompAdapter: HarnessAdapter = new OmpAdapter();

/** Pure registry: no process is spawned and no global configuration is read. */
export function adapterForHarness(definition: HarnessDefinition): HarnessAdapter {
  // An explicit --acp-command override may point at any binary named "hermes";
  // without a safe default it could silently skip CLI-default restore.
  if (definition.source === "override" || isReservedHarnessId(definition.id)) {
    return genericAcpAdapter;
  }
  const command = basename(definition.command.replace(/\\/g, "/"))
    .replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();
  // A `source: "user"` entry reusing a preset ID with an unrelated command must
  // not inherit that preset's dialect: match user entries by command only.
  if (definition.source === "user") {
    if (command === "hermes") return hermesAdapter;
    if (command === "opencode") return openCodeAdapter;
    if (command === "omp") return ompAdapter;
    return genericAcpAdapter;
  }
  const id = definition.id.toLowerCase();
  if (id === "hermes" || command === "hermes") return hermesAdapter;
  if (id === "opencode" || command === "opencode") return openCodeAdapter;
  if (id === "omp" || command === "omp") return ompAdapter;
  return genericAcpAdapter;
}
