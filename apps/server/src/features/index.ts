import type { Database, DbTransaction } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createAgentsFeature, agentsRoutes, revokeMemberWorkspaceKeys } from "./agents/index.ts";
import { createDeactivationFeature, deactivationRoutes } from "./deactivation/index.ts";
import type { AgentAuthenticator } from "./agents/index.ts";
import type { IssueSessionGate, WorkSessionGate } from "./projects/index.ts";
import { createHistoryFeature, historyRoutes } from "./history/index.ts";
import { createInboxFeature, inboxRoutes } from "./inbox/index.ts";
import { createInvitationsFeature, invitationsRoutes } from "./invitations/index.ts";
import { createMyWorkFeature, myWorkRoutes } from "./my-work/index.ts";
import { createNotificationsFeature, notificationsRoutes } from "./notifications/index.ts";
import { createOwnershipFeature, ownershipRoutes } from "./ownership/index.ts";
import { createProjectsFeature, projectAccessAtLeast, projectsRoutes } from "./projects/index.ts";
import { createRecoveryFeature, recoveryRoutes } from "./recovery/index.ts";
import { createRunsFeature, runsRoutes } from "./runs/index.ts";
import { createSettingsFeature, settingsRoutes } from "./settings/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";
import { createTransfersFeature, transfersRoutes } from "./transfers/index.ts";
import { createWebhooksFeature, webhooksRoutes } from "./webhooks/index.ts";
import {
  createSessionsFeature,
  releaseIssueWorkSessions,
  sessionsRoutes,
} from "./work-sessions/index.ts";
import { createWorkspacesFeature, workspacesRoutes } from "./workspaces/index.ts";

export function createFeatures(database: Database, config: Config, log: Logger): Feature[] {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: config.BOOTSTRAP_SECRET,
    publicUrl: config.PUBLIC_URL,
  });

  const settings = createSettingsFeature({
    db: database.db,
    publicUrl: config.PUBLIC_URL,
    encryptionKey: config.ORRERY_ENCRYPTION_KEY,
    sessionReader: accounts.sessionReader,
    markEmailVerified: accounts.markEmailVerified,
    log,
  });

  let authenticateAgent: AgentAuthenticator | undefined;
  const agentAuthenticator: AgentAuthenticator = (request) => {
    if (authenticateAgent === undefined) throw new Error("agent authenticator is not wired");
    return authenticateAgent(request);
  };

  const webhooks = createWebhooksFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    encryptionKey: config.ORRERY_ENCRYPTION_KEY,
    allowPrivateUrls: config.ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS,
    log,
  });

  let sessionGate: WorkSessionGate | undefined;
  const workSessionGate: WorkSessionGate = (tx, agentId, workspaceId, issueId) => {
    if (sessionGate === undefined) throw new Error("work session gate is not wired");
    return sessionGate(tx, agentId, workspaceId, issueId);
  };
  let trashSessionGate: IssueSessionGate | undefined;
  const issueSessionGate: IssueSessionGate = (tx, issueId) => {
    if (trashSessionGate === undefined) throw new Error("trash session gate is not wired");
    return trashSessionGate(tx, issueId);
  };

  let questionLeaseDeadline:
    | ((tx: DbTransaction, issueId: string) => Promise<Date | null>)
    | undefined;
  let questionEvaluateDeadline: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
  const leaseDeadline = (tx: DbTransaction, issueId: string): Promise<Date | null> => {
    if (questionLeaseDeadline === undefined) throw new Error("question deadline is not wired");
    return questionLeaseDeadline(tx, issueId);
  };
  const evaluateDeadline = (tx: DbTransaction, issueId: string): Promise<void> => {
    if (questionEvaluateDeadline === undefined) throw new Error("question deadline is not wired");
    return questionEvaluateDeadline(tx, issueId);
  };
  let dueQuestionIssueIds: (() => Promise<string[]>) | undefined;
  const sweepDueQuestions = (): Promise<string[]> => {
    if (dueQuestionIssueIds === undefined) throw new Error("question deadline is not wired");
    return dueQuestionIssueIds();
  };
  const projects = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator,
    sessionGate: workSessionGate,
    issueSessionGate,
    releaseIssueWorkSessions,

    evaluateQuestionDeadline: evaluateDeadline,
    onActivity: webhooks.enqueueForActivity,
    log,
  });
  const agents = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  authenticateAgent = agents.authenticator;

  const notifications = createNotificationsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    log,
  });

  const sessions = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    listIssues: (actor, projectId) => projects.service.listIssues(actor, projectId),
    questionLeaseDeadline: leaseDeadline,
    evaluateQuestionDeadline: evaluateDeadline,
    dueQuestionIssueIds: sweepDueQuestions,
    notifyActivity: notifications.notifyActivity,
    onActivity: webhooks.enqueueForActivity,
    log,
  });
  sessionGate = (tx, agentId, workspaceId, issueId) =>
    sessions.agentHoldsSession(tx, agentId, workspaceId, issueId);

  trashSessionGate = (tx, issueId) => sessions.issueHasLiveSession(tx, issueId);

  const inbox = createInboxFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    deliver: settings.deliver,
    log,
    notifyActivity: notifications.notifyActivity,
    onActivity: webhooks.enqueueForActivity,
  });
  questionLeaseDeadline = (tx, issueId) => inbox.questionDeadline(tx, issueId);
  questionEvaluateDeadline = (tx, issueId) => inbox.evaluateDeadline(tx, issueId);
  dueQuestionIssueIds = () => inbox.findDueQuestionIssueIds();
  return [
    createSystemFeature({ ping: database.ping }),
    accounts,

    createDeactivationFeature({ db: database.db, sessionReader: accounts.sessionReader }),

    createOwnershipFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      deliver: settings.deliver,
      log,
    }),
    settings,

    createRecoveryFeature({
      db: database.db,
      accounts: {
        accountByEmail: (email, tx) => accounts.accountByEmail(email, tx),
        setPassword: (humanId, password, tx) => accounts.setPassword(humanId, password, tx),
        invalidateBrowserSessions: (humanId, tx) => accounts.invalidateBrowserSessions(humanId, tx),
      },
      deliver: settings.deliver,
      publicUrl: config.PUBLIC_URL,
      log,
    }),

    createInvitationsFeature({
      db: database.db,
      publicUrl: config.PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log,
    }),
    createWorkspacesFeature({
      db: database.db,
      publicUrl: config.PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
        projects.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
      revokeMemberWorkspaceKeys: (tx, workspaceId, humanId, actorHumanId) =>
        revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId),
      releaseMemberWorkSessions: (tx, workspaceId, humanId) =>
        sessions.releaseMemberWorkSessions(tx, workspaceId, humanId),
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projects.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
      log,
    }),
    projects,
    agents,
    webhooks,

    createHistoryFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    }),

    createRunsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      authenticate: agentAuthenticator,
    }),
    sessions,
    inbox,
    notifications,

    createMyWorkFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
      projectAccessAtLeast,
    }),

    createTransfersFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
    }),
  ];
}

export const routes = [
  ...systemRoutes,
  ...accountsRoutes,
  ...deactivationRoutes,
  ...ownershipRoutes,
  ...agentsRoutes,
  ...settingsRoutes,
  ...recoveryRoutes,
  ...invitationsRoutes,
  ...workspacesRoutes,
  ...projectsRoutes,
  ...historyRoutes,
  ...runsRoutes,
  ...sessionsRoutes,
  ...inboxRoutes,
  ...notificationsRoutes,
  ...myWorkRoutes,
  ...transfersRoutes,
  ...webhooksRoutes,
];
