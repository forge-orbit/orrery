import type { DbTransaction } from "../../platform/db.ts";
import type { Feature } from "../../platform/feature.ts";
import type { IssueCommandInput } from "./outbox.ts";
import { createRunnersRest, routes } from "./rest.ts";
import { createRunnersService, type RunnersDeps, type RunnersService } from "./service.ts";

export { routes as runnersRoutes };
export {
  RunnersError,
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
  const service = createRunnersService(deps);
  return {
    name: "runners",
    rest: createRunnersRest(service, deps.sessionReader),
    service,
    // Release the replica's dedicated LISTEN connection on clean shutdown.
    stop: () => service.close(),
  };
}
