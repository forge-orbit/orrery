import type { DbTransaction } from "../../platform/db.ts";
import type { Feature } from "../../platform/feature.ts";
import type { IssueCommandInput } from "./outbox.ts";
import { createRunnersRest, routes } from "./rest.ts";
import { createRunnersService, type RunnersDeps, type RunnersService } from "./service.ts";

export { routes as runnersRoutes };
export {
  RunnersError,
  revokeProjectRunners,
  revokeRunnerHostsForHuman,
  revokeWorkspaceRunnersForMember,
  RUNNER_ONLINE_WINDOW_SECONDS,
} from "./service.ts";
export { enqueueCommandForIssue } from "./outbox.ts";
export type { IssueCommandInput } from "./outbox.ts";
export type EnqueueIssueCommand = (tx: DbTransaction, input: IssueCommandInput) => Promise<void>;
export type { RunnersErrorKind, RunnersService, RunnersDeps } from "./service.ts";

export interface RunnersFeature extends Feature {
  service: RunnersService;
}

export function createRunnersFeature(deps: RunnersDeps): RunnersFeature {
  let clearTimers: (() => void) | undefined;
  // service.close() clears the #199 ticks through onClose, so the feature's
  // stop hook stays the single outbox-notifier seam used by the M44 model.
  const service = createRunnersService({ ...deps, onClose: () => clearTimers?.() });
  let disconnectTimer: NodeJS.Timeout | undefined;
  let rollupTimer: NodeJS.Timeout | undefined;
  clearTimers = () => {
    if (disconnectTimer !== undefined) clearInterval(disconnectTimer);
    if (rollupTimer !== undefined) clearInterval(rollupTimer);
    disconnectTimer = undefined;
    rollupTimer = undefined;
  };
  return {
    name: "runners",
    rest: createRunnersRest(service, deps.sessionReader),
    service,
    // #199: missed heartbeats make dispatches uncertain; ended/expired sessions
    // roll their hot stream chunks into ObjectStore. Both ticks are guarded and
    // unref'd so tests and short-lived workers can exit cleanly.
    startBackgroundTasks: () => {
      if (disconnectTimer !== undefined || rollupTimer !== undefined) return;
      let disconnectSweep = false;
      disconnectTimer = setInterval(() => {
        if (disconnectSweep) return;
        disconnectSweep = true;
        void service
          .markDisconnectedDispatches()
          .catch((error: unknown) => {
            deps.log?.warn("runner disconnect sweep failed", { error: String(error) });
          })
          .finally(() => {
            disconnectSweep = false;
          });
      }, 10 * 1000);
      disconnectTimer.unref();

      let rollupSweep = false;
      rollupTimer = setInterval(() => {
        if (rollupSweep) return;
        rollupSweep = true;
        void service
          .rollUpStreams()
          .catch((error: unknown) => {
            deps.log?.warn("stream rollup sweep failed", { error: String(error) });
          })
          .finally(() => {
            rollupSweep = false;
          });
      }, 60 * 1000);
      rollupTimer.unref();
    },
    // Registers the timer cleanup used by service.close(), then stops the
    // replica's LISTEN connection through the original outbox seam.
    stop: () => service.close(),
  };
}
