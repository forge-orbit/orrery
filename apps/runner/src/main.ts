#!/usr/bin/env node
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { readCredential } from "./credential.ts";
import type { ReadyWorkFilter } from "@orrery/contract";
import { loadSupervisionConfig } from "./config.ts";
import { login } from "./login.ts";
import { start } from "./start.ts";
import { work } from "./work.ts";

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
  login                     Enroll this machine as a Runner host in the browser
  start --workspace ID --project ID
                            Register a project-bound Runner and heartbeat
  work <ISSUE>              Run one issue in an ephemeral Runner and exit
  status                    Show the locally stored host credential

Options:
  --server URL              Orrery base URL (default: ORRERY_URL or http://localhost:8080)
  --host-name NAME          Display name for this machine (login)
  --platform NAME           Platform label (login)
  --agent ID                Default Agent id (start; otherwise the host owner's first Agent)
  --name NAME               Runner display name (start)
  --capability NAME         Declared capability, repeatable (start)
  --concurrency N           Max concurrent local slots, 1-64 (start; default: 1)
  --repo PATH               Local checkout path (start/work; default: current directory)
  --heartbeat-ms N          Heartbeat interval (start; default: 5000)
  --auto-claim              Opt in to autonomous ready-work pickup (start)
  --auto-claim-filter FILTER  assignedToMe | unassigned | all (start; default: assignedToMe)
  --auto-claim-poll-ms N    Auto-claim poll interval (start; default: 1000)
  --workspace SLUG-OR-ID    Disambiguate an issue key (work)
  --prompt TEXT             Requester instructions for one Dispatch (work; max 16,000 chars)
  --acp-command NAME        ACP harness command (default: opencode; env: ORRERY_ACP_COMMAND)
  --acp-arg ARG             ACP harness argument, repeatable (default: acp)
  --lease-renew-ms N        Work-session lease renewal interval (default: 60000)
  --cancel-grace-ms N       SIGTERM -> SIGKILL grace period (default: 2000)
  --worktree-root PATH      Parent directory for isolated git worktrees
  -h, --help                Show this help
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
      project: { type: "string" },
      agent: { type: "string" },
      name: { type: "string" },
      capability: { type: "string", multiple: true },
      concurrency: { type: "string" },
      "auto-claim": { type: "boolean" },
      "auto-claim-filter": { type: "string" },
      "auto-claim-poll-ms": { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      "heartbeat-ms": { type: "string" },
      "acp-command": { type: "string" },
      "acp-arg": { type: "string", multiple: true },
      "lease-renew-ms": { type: "string" },
      "cancel-grace-ms": { type: "string" },
      "worktree-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(usage);
    return;
  }

  const server = values.server ?? process.env.ORRERY_URL ?? "http://localhost:8080";
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
      ...(leaseRenewMs === undefined ? {} : { leaseRenewMs }),
      ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
      ...(values["worktree-root"] === undefined ? {} : { worktreeRoot: values["worktree-root"] }),
    });
  };

  const command = positionals[0] ?? "";
  try {
    switch (command) {
      case "login": {
        await login({
          server,
          hostDisplayName: values["host-name"] ?? hostname(),
          ...(values.platform === undefined ? {} : { platform: values.platform }),
          ...(values["poll-ms"] === undefined ? {} : { pollIntervalMs: Number(values["poll-ms"]) }),
          signal: controller.signal,
        });
        return;
      }
      case "start": {
        const workspaceId = values.workspace;
        const projectId = values.project;
        if (workspaceId === undefined || projectId === undefined) {
          throw new Error("start requires --workspace ID and --project ID");
        }
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
        await start({
          server,
          workspaceId,
          projectId,
          ...(values.agent === undefined ? {} : { agentId: values.agent }),
          ...(values.name === undefined ? {} : { displayName: values.name }),
          capabilities: values.capability ?? [],
          maxConcurrency: concurrency,
          heartbeatMs,
          ...(values.repo === undefined ? {} : { repoPath: values.repo }),
          signal: controller.signal,
          supervision: supervision(),
          autoClaim: values["auto-claim"] === true,
          ...(filter === undefined ? {} : { autoClaimFilter: filter }),
          ...(autoClaimPollMs === undefined ? {} : { autoClaimPollMs }),
        });
        return;
      }
      case "work": {
        const target = positionals[1] ?? fail("work requires an issue ID, URL or KEY");
        const outcome = await work(target, {
          server,
          ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
          ...(values.repo === undefined ? {} : { repoPath: values.repo }),
          ...(values.agent === undefined ? {} : { agentId: values.agent }),
          ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
          signal: controller.signal,
          supervision: supervision(),
        });
        if (outcome !== "completed") {
          fail(`One-shot work ended with '${outcome}'.`);
        }
        return;
      }
      case "status": {
        const stored = await readCredential();
        process.stdout.write(
          `Runner host '${stored.displayName}' (${stored.hostId}) enrolled with ${stored.server}.\n`,
        );
        return;
      }
      default:
        fail(`Unknown command '${command}'. Run 'orrery-runner --help'.`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
