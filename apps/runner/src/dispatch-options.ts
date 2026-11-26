import type { HarnessCatalog } from "@orrery/contract";
import { detectHarnesses, type HarnessDefinition } from "./harnesses.ts";

/** Identifiers selected for one Dispatch or supplied as CLI defaults (#241). */
export interface ExecutionChoice {
  harness?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

export interface DispatchOptionsContext {
  /** Test seam; production resolves through the local registry below. */
  definitions?: readonly HarnessDefinition[] | undefined;
  /** Cached catalog, used only to read a Harness's default model. */
  catalog?: HarnessCatalog | undefined;
  /** ACP command/args in effect when no Harness was selected. */
  defaultCommand: { command: string; args: string[] };
  acpOverride?: { command: string; args: string[] } | undefined;
  configDir?: string | undefined;
  pathEnv?: string | undefined;
}

export type ResolvedExecution =
  | {
      kind: "default";
      command: { command: string; args: string[] };
      model?: string;
      effort?: string;
    }
  | {
      kind: "harness";
      definition: HarnessDefinition;
      model?: string;
      effort?: string;
      /** True when the model came from the catalog's cached defaultModel. */
      defaultModelUsed: boolean;
    }
  | { kind: "error"; reason: "harness_not_installed"; harness: string };

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** Dispatch choices win over `start`/`work` defaults; blanks are omitted. */
export function mergeExecutionChoice(
  dispatch: ExecutionChoice,
  defaults: ExecutionChoice | undefined,
): ExecutionChoice {
  return {
    harness: nonBlank(dispatch.harness) ?? nonBlank(defaults?.harness),
    model: nonBlank(dispatch.model) ?? nonBlank(defaults?.model),
    effort: nonBlank(dispatch.effort) ?? nonBlank(defaults?.effort),
  };
}

/**
 * Resolve a Harness strictly through the Runner's local registry/config
 * allowlist. The server only ever supplies an opaque id: no command, path or
 * flag from a Dispatch is executed here (ADR-0011).
 */
export function resolveExecutionChoice(
  choice: ExecutionChoice,
  context: DispatchOptionsContext,
): ResolvedExecution {
  const harness = nonBlank(choice.harness);
  const model = nonBlank(choice.model);
  const effort = nonBlank(choice.effort);
  if (harness === undefined) {
    return {
      kind: "default",
      command: context.defaultCommand,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
  }
  const definitions =
    context.definitions ??
    detectHarnesses({
      ...(context.acpOverride === undefined ? {} : { acpOverride: context.acpOverride }),
      ...(context.configDir === undefined ? {} : { configDir: context.configDir }),
      ...(context.pathEnv === undefined ? {} : { pathEnv: context.pathEnv }),
    });
  const definition = definitions.find((item) => item.id === harness);
  if (definition === undefined) {
    return { kind: "error", reason: "harness_not_installed", harness };
  }
  const entry = context.catalog?.harnesses.find((item) => item.id === definition.id);
  // A Dispatch that omits `model` explicitly inherits the Harness's cached
  // default, never a model temporarily selected by a catalog probe (#240).
  const effectiveModel = model ?? nonBlank(entry?.defaultModel);
  return {
    kind: "harness",
    definition,
    ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
    ...(effort === undefined ? {} : { effort }),
    defaultModelUsed: model === undefined && effectiveModel !== undefined,
  };
}

/** A wrapper so callers can name why a Harness/model application failed. */
export class DispatchOptionFailure extends Error {
  readonly kind: "harness_not_installed" | "model_rejected";
  readonly harness: string | undefined;

  constructor(kind: "harness_not_installed" | "model_rejected", message: string, harness?: string) {
    super(message);
    this.name = "DispatchOptionFailure";
    this.kind = kind;
    this.harness = harness;
  }
}
