import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { type InboxDeps, type InboxService, createInboxService } from "./service.ts";
import { createInboxMcp } from "./mcp.ts";
import { createInboxRest, routes } from "./rest.ts";

export { routes as inboxRoutes };
export { InboxError, createInboxService } from "./service.ts";
export type { InboxErrorKind, InboxService } from "./service.ts";

export type InboxFeatureDeps = Omit<InboxDeps, "deliver" | "log"> & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
  deliver: (mail: OutgoingMail) => Promise<void>;
  log: Logger;
};

export interface InboxFeature extends Feature {
  service: InboxService;

  questionDeadline(tx: DbTransaction, issueId: string): Promise<Date | null>;
  evaluateDeadline(tx: DbTransaction, issueId: string): Promise<void>;
  findDueQuestionIssueIds(): Promise<string[]>;
}

export function createInboxFeature(deps: InboxFeatureDeps): InboxFeature {
  const service = createInboxService({
    db: deps.db,
    projectAccessCeiling: deps.projectAccessCeiling,
    projectAccessAtLeast: deps.projectAccessAtLeast,
    deliver: deps.deliver,
    log: deps.log,
    notifyActivity: deps.notifyActivity,
    onActivity: deps.onActivity,
    onRunnerCommand: deps.onRunnerCommand,
  });
  return {
    name: "inbox",
    rest: createInboxRest(service, deps.sessionReader, deps.authenticate),
    registerTools: createInboxMcp(service, deps.authenticate),
    service,
    questionDeadline: (tx, issueId) => service.questionDeadline(tx, issueId),
    evaluateDeadline: (tx, issueId) => service.evaluateDeadline(tx, issueId),
    findDueQuestionIssueIds: () => service.findDueQuestionIssueIds(),
  };
}
