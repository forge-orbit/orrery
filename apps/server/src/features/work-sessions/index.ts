import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import {
  type SessionsDeps,
  type SessionsService,
  createSessionsService,
  releaseMemberWorkSessions,
} from "./service.ts";
import { createSessionsMcp } from "./mcp.ts";
import { createSessionsRest, routes } from "./rest.ts";

export { routes as sessionsRoutes };
export {
  claimInTransaction,
  releaseIssueWorkSessions,
  SessionsError,
  toSession,
} from "./service.ts";
export type { ClaimInTransactionDeps, SessionsErrorKind, SessionsService } from "./service.ts";

export type SessionsFeatureDeps = SessionsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
  log?: Logger | undefined;
};

export interface SessionsFeature extends Feature {
  service: SessionsService;

  agentHoldsSession(
    tx: DbTransaction,
    agentId: string,
    workspaceId: string,
    issueId: string,
  ): Promise<boolean>;

  issueHasLiveSession(tx: DbTransaction, issueId: string): Promise<boolean>;

  releaseMemberWorkSessions(tx: DbTransaction, workspaceId: string, humanId: string): Promise<void>;
}

export function createSessionsFeature(deps: SessionsFeatureDeps): SessionsFeature {
  const service = createSessionsService({
    db: deps.db,
    projectAccessCeiling: deps.projectAccessCeiling,
    projectAccessAtLeast: deps.projectAccessAtLeast,
    listIssues: deps.listIssues,
    questionLeaseDeadline: deps.questionLeaseDeadline,
    evaluateQuestionDeadline: deps.evaluateQuestionDeadline,
    dueQuestionIssueIds: deps.dueQuestionIssueIds,
    notifyActivity: deps.notifyActivity,
    onActivity: deps.onActivity,
    log: deps.log,
  });
  return {
    name: "work-sessions",
    rest: createSessionsRest(service, deps.sessionReader, deps.authenticate),
    registerTools: createSessionsMcp(service, deps.authenticate),
    startBackgroundTasks: () => {
      let sweeping = false;
      const timer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void service
          .sweep()
          .catch((error: unknown) => {
            deps.log?.warn("expiry sweep failed", { error: String(error) });
          })
          .finally(() => {
            sweeping = false;
          });
      }, 60 * 1000);
      timer.unref();
    },
    service,
    agentHoldsSession: (tx, agentId, workspaceId, issueId) =>
      service.agentHoldsSession(tx, agentId, workspaceId, issueId),
    issueHasLiveSession: (tx, issueId) => service.issueHasLiveSession(tx, issueId),
    releaseMemberWorkSessions,
  };
}
