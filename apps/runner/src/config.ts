import { resolve } from "node:path";
import type { DispatchOptions } from "@orrery/contract";
import { isReservedHarnessId } from "./harnesses.ts";
import { canonicalizeServerUrl } from "./origin.ts";

/** The local ACP harness the Runner supervises over stdio. */
export interface AcpHarnessConfig {
  command: string;
  args: string[];
}

/** Timing and layout knobs for local dispatch supervision. */
export interface SupervisionConfig {
  acp: AcpHarnessConfig;
  /** True only when a CLI flag or env var explicitly replaced the ACP command/args. */
  acpOverridden: boolean;
  /** `--harness`, `--model` and `--effort`: defaults for dispatches without overrides. */
  defaults: DispatchOptions;
  /** Renew the five-minute work-session lease this often. */
  leaseRenewMs: number;
  /** Grace period before escalating SIGTERM to SIGKILL on cancel. */
  cancelGraceMs: number;
  /** Parent directory for per-slot git worktrees. */
  worktreeRoot: string | undefined;
}

export interface SupervisionOverrides extends DispatchOptions {
  acp?: Partial<AcpHarnessConfig> | undefined;
  leaseRenewMs?: number | undefined;
  cancelGraceMs?: number | undefined;
  worktreeRoot?: string | undefined;
}

function positiveInt(value: string | number | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function loadSupervisionConfig(
  overrides: SupervisionOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): SupervisionConfig {
  const harness = overrides.harness;
  // `--harness <preset>` and an explicit ACP command/args override are mutually
  // exclusive: silently ignoring one would dispatch the wrong Harness. The
  // reserved `custom` id explicitly selects the override entry, so it is the
  // only `--harness` value allowed alongside an override.
  if (harness !== undefined && !isReservedHarnessId(harness)) {
    if (overrides.acp?.command !== undefined) {
      throw new Error(
        "Pass either --harness or --acp-command, not both: --harness selects a preset while --acp-command overrides it.",
      );
    }
    if (overrides.acp?.args !== undefined) {
      throw new Error(
        "Pass either --harness or --acp-arg, not both: --harness selects a preset while --acp-arg overrides it.",
      );
    }
    if (env.ORRERY_ACP_COMMAND !== undefined) {
      throw new Error(
        "Pass either --harness or ORRERY_ACP_COMMAND, not both: --harness selects a preset while ORRERY_ACP_COMMAND overrides it.",
      );
    }
    if (env.ORRERY_ACP_ARGS !== undefined) {
      throw new Error(
        "Pass either --harness or ORRERY_ACP_ARGS, not both: --harness selects a preset while ORRERY_ACP_ARGS overrides it.",
      );
    }
  }
  const acpOverridden =
    overrides.acp?.command !== undefined ||
    overrides.acp?.args !== undefined ||
    env.ORRERY_ACP_COMMAND !== undefined ||
    env.ORRERY_ACP_ARGS !== undefined;
  const command = overrides.acp?.command ?? env.ORRERY_ACP_COMMAND ?? "opencode";
  let parsedArgs: string[] = ["acp"];
  if (env.ORRERY_ACP_ARGS !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(env.ORRERY_ACP_ARGS);
    } catch (error) {
      throw new Error(`ORRERY_ACP_ARGS must be a JSON array of strings: ${String(error)}`, {
        cause: error,
      });
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      parsedArgs = value;
    } else {
      throw new Error("ORRERY_ACP_ARGS must be a JSON array of strings");
    }
  }
  const args = overrides.acp?.args ?? parsedArgs;
  const root = overrides.worktreeRoot ?? env.ORRERY_WORKTREE_ROOT;
  return {
    acp: { command, args: [...args] },
    acpOverridden,
    defaults: {
      harness: overrides.harness,
      model: overrides.model,
      effort: overrides.effort,
    },
    leaseRenewMs: positiveInt(
      overrides.leaseRenewMs ?? env.ORRERY_LEASE_RENEW_MS,
      "leaseRenewMs",
      60_000,
    ),
    cancelGraceMs: positiveInt(
      overrides.cancelGraceMs ?? env.ORRERY_CANCEL_GRACE_MS,
      "cancelGraceMs",
      2_000,
    ),
    worktreeRoot: root === undefined ? undefined : resolve(root),
  };
}

/**
 * The ephemeral `/mcp` configuration handed to an ACP session. It points at
 * Orrery, carries the short-lived Dispatch token, and pins the active scope.
 */
export interface EphemeralMcpServer {
  name: string;
  type: "http";
  url: string;
  headers: Array<{ name: string; value: string }>;
  env: Array<{ name: string; value: string }>;
}

export interface DispatchMcpContext {
  server: string;
  dispatchToken: string;
  issueId: string;
  runId: string;
  workSessionId: string;
  dispatchAttemptId: string;
}

export function ephemeralMcpConfig(context: DispatchMcpContext): EphemeralMcpServer {
  const url = `${canonicalizeServerUrl(context.server)}/mcp`;
  return {
    name: "orrery",
    type: "http",
    url,
    headers: [{ name: "authorization", value: `Bearer ${context.dispatchToken}` }],
    env: [
      { name: "ORRERY_MCP_URL", value: url },
      { name: "ORRERY_DISPATCH_TOKEN", value: context.dispatchToken },
      { name: "ORRERY_ISSUE_ID", value: context.issueId },
      { name: "ORRERY_RUN_ID", value: context.runId },
      { name: "ORRERY_WORK_SESSION_ID", value: context.workSessionId },
      { name: "ORRERY_DISPATCH_ATTEMPT_ID", value: context.dispatchAttemptId },
    ],
  };
}
