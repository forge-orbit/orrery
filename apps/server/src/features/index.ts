import type { Database, DbTransaction } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createObjectStore, type ObjectStore } from "../platform/storage.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import {
  createAttachmentsFeature,
  attachmentsRoutes,
  type AttachmentSeams,
} from "./attachments/index.ts";
import { createAvatarsFeature, avatarsRoutes } from "./avatars/index.ts";
import {
  agentProjectAccessInTransaction,
  createAgentsFeature,
  agentsRoutes,
  revokeMemberWorkspaceKeys,
} from "./agents/index.ts";
import { createDeactivationFeature, deactivationRoutes } from "./deactivation/index.ts";
import type { AgentAuthenticator } from "./agents/index.ts";
import type { IssueSessionGate, WorkSessionGate } from "./projects/index.ts";
import { createHistoryFeature, historyRoutes } from "./history/index.ts";
import { createInboxFeature, inboxRoutes } from "./inbox/index.ts";
import { createInvitationsFeature, invitationsRoutes } from "./invitations/index.ts";
import { createMyWorkFeature, myWorkRoutes } from "./my-work/index.ts";
import {
  createNotificationsFeature,
  notificationsRoutes,
  type NotifyActivity,
} from "./notifications/index.ts";
import { createOwnershipFeature, ownershipRoutes } from "./ownership/index.ts";
import { createProjectsFeature, projectAccessAtLeast, projectsRoutes } from "./projects/index.ts";
import { createRecoveryFeature, recoveryRoutes } from "./recovery/index.ts";
import {
  createRunnersFeature,
  revokeWorkspaceRunnersForMember,
  runnersRoutes,
} from "./runners/index.ts";
import { createRunsFeature, runsRoutes } from "./runs/index.ts";
import { createSettingsFeature, settingsRoutes } from "./settings/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";
import { createTransfersFeature, transfersRoutes } from "./transfers/index.ts";
import { createWebhooksFeature, webhooksRoutes } from "./webhooks/index.ts";
import {
  claimInTransaction,
  createSessionsFeature,
  releaseIssueWorkSessions,
  sessionsRoutes,
} from "./work-sessions/index.ts";
import { createWorkspacesFeature, workspacesRoutes } from "./workspaces/index.ts";

export function createFeatures(
  database: Database,
  config: Config,
  log: Logger,
  storage: ObjectStore = createObjectStore(config),
): Feature[] {
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
  // Notifications is built after projects, but issue and comment writes must
  // deliver mention notifications inside their own transaction.
  let wiredNotifyActivity: NotifyActivity | undefined;
  const notifyActivity: NotifyActivity = (tx, input) => {
    if (wiredNotifyActivity === undefined) throw new Error("mention notifications are not wired");
    return wiredNotifyActivity(tx, input);
  };
  // Attachments is built after projects (it needs the project access gate), but
  // saving a holder must sync references inside that holder's transaction.
  let wiredAttachmentSeams: AttachmentSeams | undefined;
  const attachmentSeams: AttachmentSeams = {
    syncReferences: (tx, input) => {
      if (wiredAttachmentSeams === undefined) throw new Error("attachment sync is not wired");
      return wiredAttachmentSeams.syncReferences(tx, input);
    },
    listMetadata: (tx, holders) => {
      if (wiredAttachmentSeams === undefined) throw new Error("attachment metadata is not wired");
      return wiredAttachmentSeams.listMetadata(tx, holders);
    },
    purgeHolders: (tx, holders) => {
      if (wiredAttachmentSeams === undefined) throw new Error("attachment purge is not wired");
      return wiredAttachmentSeams.purgeHolders(tx, holders);
    },
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
    notifyActivity,
    attachmentSeams,
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

  const avatars = createAvatarsFeature({
    db: database.db,
    store: storage,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    log,
  });

  const attachments = createAttachmentsFeature({
    db: database.db,
    store: storage,
    maxAttachmentBytes: config.ORRERY_MAX_ATTACHMENT_BYTES,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    agentProjectAccess: (tx, identity, workspaceId, projectId) =>
      agentProjectAccessInTransaction(
        tx,
        (t, wid, hid, pids) => projects.projectAccessCeiling(t, wid, hid, pids),
        projectAccessAtLeast,
        identity,
        workspaceId,
        projectId,
      ),
    log,
  });
  wiredAttachmentSeams = {
    syncReferences: (tx, input) => attachments.service.syncReferences(tx, input),
    listMetadata: (tx, holders) => attachments.service.listMetadata(tx, holders),
    purgeHolders: (tx, holders) => attachments.service.purgeHolders(tx, holders),
  };

  const notifications = createNotificationsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    log,
  });
  wiredNotifyActivity = notifications.notifyActivity;

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

  const runners = createRunnersFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    publicUrl: config.PUBLIC_URL,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    claimWorkSession: (tx, identity, input) =>
      claimInTransaction(tx, identity, input, {
        projectAccessCeiling: (t, wid, hid, pids) =>
          projects.projectAccessCeiling(t, wid, hid, pids),
        projectAccessAtLeast,
        evaluateQuestionDeadline: evaluateDeadline,
        notifyActivity: notifications.notifyActivity,
        onActivity: webhooks.enqueueForActivity,
      }),
  });

  return [
    createSystemFeature({ ping: database.ping, checkStorage: () => storage.checkHealth() }),
    accounts,
    avatars,
    attachments,

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
        hashPassword: (password) => accounts.hashPassword(password),
        setPasswordHash: (humanId, passwordHash, tx) =>
          accounts.setPasswordHash(humanId, passwordHash, tx),
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
      revokeMemberWorkspaceRunners: (tx, workspaceId, humanId) =>
        revokeWorkspaceRunnersForMember(tx, workspaceId, humanId),
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
    runners,
  ];
}

export const routes = [
  ...systemRoutes,
  ...accountsRoutes,
  ...avatarsRoutes,
  ...attachmentsRoutes,
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
  ...runnersRoutes,
];
