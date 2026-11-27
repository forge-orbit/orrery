import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { readCredential } from "./credential.ts";
import type { ReadyWorkFilter } from "@orrery/contract";
import { loadSupervisionConfig } from "./config.ts";
import { defaultHostDisplayName, validateDisplayName } from "./display-name.ts";
import { shadowedPresetIds } from "./harnesses.ts";
import { init } from "./init.ts";
import { login } from "./login.ts";
import { assertSecureOrigin, resolveLoginOrigin } from "./origin.ts";
import { start } from "./start.ts";
import { work } from "./work.ts";

declare const ORRERY_RUNNER_VERSION: string | undefined;

/**
 * Build-injected version string (esbuild `define`, #268). Falls back to
 * `0.0.0-dev` when executed directly from TypeScript source.
 */
export const RUNNER_VERSION =
  typeof ORRERY_RUNNER_VERSION === "string" && ORRERY_RUNNER_VERSION !== ""
    ? ORRERY_RUNNER_VERSION
    : "0.0.0-dev";

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const positive = (raw: string | undefined, flag: string): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer`);
  }
  return parsed;
};

const isReadyWorkFilter = (value: string): value is ReadyWorkFilter =>
  value === "assignedToMe" || value === "unassigned" || value === "all";

const usage = `orrery-runner — local agent runner for Orrery

Commands:
  login                     Enroll this Runner host in the browser
  init [--workspace W] [--project P]
                            Resolve and remember a checkout binding, then exit
  start [--workspace W] [--project P]
                            Register a project-bound Runner and heartbeat
  work <ISSUE>              Run one issue in an ephemeral Runner and exit
  status                    Show the locally stored host credential

Options:
  --server URL              Orrery base URL (login: switch installations; start/work/init: must match enrollment)
  --host-name NAME          Display name for this Runner host (login)
  --platform NAME           Platform label (login)
  --agent ID-OR-NAME        Default Agent (start/init/work; otherwise the host owner's first Agent)
  --name NAME               Runner display name (start)
  --capability NAME         Declared capability, repeatable (start)
  --concurrency N           Max concurrent local slots, 1-64 (start; default: 1)
  --reconfigure             Re-resolve targets and update the saved binding (start; saved only after registration)
  --repo PATH               Local checkout path (start/work/init; default: current directory)
  --heartbeat-ms N          Heartbeat interval (start; default: 5000)
  --auto-claim              Opt in to autonomous ready-work pickup (start)
  --auto-claim-filter FILTER  assignedToMe | unassigned | all (start; default: assignedToMe)
  --auto-claim-label NAME   Require this project label, repeatable (start; default
                            with --auto-claim: ready-for-agent)
  --auto-claim-any-label    Disable the default label gate (start; conflicts with --auto-claim-label)
  --auto-claim-poll-ms N    Auto-claim poll interval (start; default: 1000)
  --workspace SLUG-OR-NAME  Workspace ID, name or slug (start/init; disambiguates an issue key in work)
  --project KEY-OR-NAME     Project ID, key or name (start/init)
  --prompt TEXT             Optional instructions appended after the runner's
                            preamble (work; max 16,000 characters)
  --harness ID              Local Harness id for dispatches without a choice
                            (start/work; e.g. opencode, codex)
  --model ID                Default model for dispatches without one (start/work)
  --effort LEVEL            Default reasoning effort (start/work; e.g. high)
  --acp-command NAME        ACP harness command (default: opencode; env: ORRERY_ACP_COMMAND)
  --acp-arg ARG             ACP harness argument, repeatable (default: acp)
  --lease-renew-ms N        Work-session lease renewal interval (default: 60000)
  --cancel-grace-ms N       SIGTERM -> SIGKILL grace period (default: 2000)
  --worktree-root PATH      Parent directory for isolated git worktrees
  -h, --help                Show this help
  -v, --version             Print the runner version and exit
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      "host-name": { type: "string" },
      platform: { type: "string" },
      "poll-ms": { type: "string" },
      workspace: { type: "string" },
      prompt: { type: "string" },
      harness: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      project: { type: "string" },
      agent: { type: "string" },
      name: { type: "string" },
      capability: { type: "string", multiple: true },
      concurrency: { type: "string" },
      reconfigure: { type: "boolean" },
      "auto-claim": { type: "boolean" },
      "auto-claim-filter": { type: "string" },
      "auto-claim-label": { type: "string", multiple: true },
      "auto-claim-any-label": { type: "boolean" },
      "auto-claim-poll-ms": { type: "string" },
      repo: { type: "string" },
      "heartbeat-ms": { type: "string" },
      "acp-command": { type: "string" },
      "acp-arg": { type: "string", multiple: true },
      "lease-renew-ms": { type: "string" },
      "cancel-grace-ms": { type: "string" },
      "worktree-root": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  // Handled before command, credential, or server checks so `orrery-runner
  // --version` works on a fresh machine with no enrollment.
  if (values.version === true) {
    process.stdout.write(`${RUNNER_VERSION}\n`);
    return;
  }

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(usage);
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const supervision = () => {
    const acp = {
      ...(values["acp-command"] === undefined ? {} : { command: values["acp-command"] }),
      ...(values["acp-arg"] === undefined ? {} : { args: values["acp-arg"] }),
    };
    const leaseRenewMs = positive(values["lease-renew-ms"], "--lease-renew-ms");
    const cancelGraceMs = positive(values["cancel-grace-ms"], "--cancel-grace-ms");
    return loadSupervisionConfig({
      ...(Object.keys(acp).length === 0 ? {} : { acp }),
      ...(values.harness === undefined ? {} : { harness: values.harness }),
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values.effort === undefined ? {} : { effort: values.effort }),
      ...(leaseRenewMs === undefined ? {} : { leaseRenewMs }),
      ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
      ...(values["worktree-root"] === undefined ? {} : { worktreeRoot: values["worktree-root"] }),
    });
  };

  const command = positionals[0] ?? "";
  try {
    switch (command) {
      case "login": {
        let previous: { server: string; displayName: string } | undefined;
        try {
          const stored = await readCredential();
          previous = { server: stored.server, displayName: stored.displayName };
        } catch {
          previous = undefined;
        }
        const server = resolveLoginOrigin({
          ...(previous === undefined ? {} : { storedServer: previous.server }),
          ...(values.server === undefined ? {} : { serverFlag: values.server }),
          ...(process.env.ORRERY_URL === undefined ? {} : { envUrl: process.env.ORRERY_URL }),
        });
        // Validate before warning so an invalid flag never prints a switch warning.
        assertSecureOrigin(server);
        const hostDisplayName =
          values["host-name"] === undefined
            ? defaultHostDisplayName(hostname())
            : validateDisplayName(values["host-name"]);
        if (previous !== undefined && previous.server !== server) {
          process.stdout.write(
            `Warning: replacing enrollment for Runner host '${previous.displayName}' on ${previous.server} with ${server}. ` +
              `Revoke the old Runner host in Orrery if it is no longer used.\n`,
          );
        }
        await login({
          server,
          hostDisplayName,
          ...(values.platform === undefined ? {} : { platform: values.platform }),
          ...(values["poll-ms"] === undefined ? {} : { pollIntervalMs: Number(values["poll-ms"]) }),
          signal: controller.signal,
        });
        return;
      }
      case "init": {
        await init({
          ...(values.server === undefined ? {} : { server: values.server }),
          ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
          ...(values.project === undefined ? {} : { project: values.project }),
          ...(values.agent === undefined ? {} : { agentId: values.agent }),
          ...(values.repo === undefined ? {} : { repoPath: values.repo }),
          signal: controller.signal,
        });
        return;
      }
      case "start": {
        const workspaceId = values.workspace;
        const projectId = values.project;
        const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
          fail("--concurrency must be an integer from 1 to 64");
        }
        const heartbeatMs =
          values["heartbeat-ms"] === undefined ? 5000 : Number(values["heartbeat-ms"]);
        if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10) {
          fail("--heartbeat-ms must be an integer of at least 10");
        }
        const rawFilter = values["auto-claim-filter"];
        const filter =
          rawFilter === undefined
            ? undefined
            : isReadyWorkFilter(rawFilter)
              ? rawFilter
              : fail("--auto-claim-filter must be assignedToMe, unassigned or all");
        const autoClaimPollMs = positive(values["auto-claim-poll-ms"], "--auto-claim-poll-ms");
        const requestedLabels = (values["auto-claim-label"] ?? []).map((label) => label.trim());
        if (requestedLabels.some((label) => label === "")) {
          fail("--auto-claim-label must not be empty");
        }
        const anyLabel = values["auto-claim-any-label"] === true;
        if (anyLabel && requestedLabels.length > 0) {
          fail("--auto-claim-label and --auto-claim-any-label cannot be combined");
        }
        // Autonomous pickup is label-gated by default so a runner never silently
        // pulls personal human todo issues (ADR-0013).
        const autoClaimLabels = anyLabel
          ? undefined
          : requestedLabels.length > 0
            ? requestedLabels
            : ["ready-for-agent"];
        await start({
          ...(values.server === undefined ? {} : { server: values.server }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(values.agent === undefined ? {} : { agentId: values.agent }),
          ...(values.name === undefined ? {} : { displayName: values.name }),
          capabilities: values.capability ?? [],
          maxConcurrency: concurrency,
          heartbeatMs,
          ...(values.repo === undefined ? {} : { repoPath: values.repo }),
          reconfigure: values.reconfigure === true,
          signal: controller.signal,
          supervision: supervision(),
          autoClaim: values["auto-claim"] === true,
          ...(filter === undefined ? {} : { autoClaimFilter: filter }),
          ...(autoClaimLabels === undefined ? {} : { autoClaimLabels }),
          ...(autoClaimPollMs === undefined ? {} : { autoClaimPollMs }),
        });
        return;
      }
      case "work": {
        const target = positionals[1] ?? fail("work requires an issue ID, URL or KEY");
        const outcome = await work(target, {
          ...(values.server === undefined ? {} : { server: values.server }),
          ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
          ...(values.repo === undefined ? {} : { repoPath: values.repo }),
          ...(values.agent === undefined ? {} : { agentId: values.agent }),
          ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
          ...(values.harness === undefined ? {} : { harness: values.harness }),
          ...(values.model === undefined ? {} : { model: values.model }),
          ...(values.effort === undefined ? {} : { effort: values.effort }),
          signal: controller.signal,
          supervision: supervision(),
        });
        if (outcome !== "completed") {
          fail(`One-shot work ended with '${outcome}'.`);
        }
        return;
      }
      case "status": {
        // Strictly offline: ignore --server and ORRERY_URL, make zero network calls.
        // Read the shadowed presets before writing anything so a malformed
        // harnesses.json fails cleanly without partial stdout.
        const stored = await readCredential();
        const shadowed = shadowedPresetIds();
        process.stdout.write(
          `Runner host '${stored.displayName}' (${stored.hostId}) enrolled with ${stored.server}.\n`,
        );
        for (const id of shadowed) {
          process.stdout.write(`Harness preset '${id}' is shadowed by harnesses.json.\n`);
        }
        return;
      }
      default:
        fail(`Unknown command '${command}'. Run 'orrery-runner --help'.`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
