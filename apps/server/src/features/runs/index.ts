import type { Feature } from "../../platform/feature.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createRunsMcp } from "./mcp.ts";
import { createRunsRest, routes } from "./rest.ts";
import { type RunsDeps, type RunsService, createRunsService } from "./service.ts";

export { routes as runsRoutes };
export { RunsError, toRun } from "./service.ts";
export type { RunsErrorKind, RunsService } from "./service.ts";

export type RunsFeatureDeps = RunsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
  log?: Logger | undefined;
};

export interface RunsFeature extends Feature {
  service: RunsService;
}

export function createRunsFeature(deps: RunsFeatureDeps): RunsFeature {
  const service = createRunsService({ db: deps.db });
  return {
    name: "runs",

    rest: createRunsRest(service, deps.sessionReader, deps.authenticate),
    registerTools: createRunsMcp(service, deps.authenticate),
    service,
    startBackgroundTasks: () => {
      let sweeping = false;
      const timer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void service
          .expireStaleRuns()
          .catch((error: unknown) => {
            deps.log?.warn("run staleness sweep failed", { error: String(error) });
          })
          .finally(() => {
            sweeping = false;
          });
      }, 60 * 1000);
      timer.unref();
    },
  };
}
