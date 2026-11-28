import type { ProjectAccessLevel } from "@orrery/contract";
import type { Feature } from "../../platform/feature.ts";
import type { Logger } from "../../platform/log.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import {
  type ProjectsDeps,
  type ProjectsService,
  type WorkSessionGate,
  createProjectsService,
} from "./service.ts";
import { createProjectsMcp } from "./mcp.ts";
import { createProjectsRest, routes } from "./rest.ts";

export { routes as projectsRoutes };
export {
  createProjectsService,
  issueBoardOrder,
  projectAccessAtLeast,
  projectAccessCeilingInTransaction,
} from "./service.ts";
export { ProjectsError } from "./service.ts";
export type {
  IssueSessionGate,
  ProjectsErrorKind,
  ProjectsService,
  ReleaseIssueWorkSessions,
  WorkActor,
  WorkSessionGate,
} from "./service.ts";

export type ProjectsDepsWithAccounts = ProjectsDeps & {
  sessionReader: SessionReader;

  agentAuthenticator: AgentAuthenticator;

  sessionGate: WorkSessionGate;

  issueSessionGate?: ProjectsDeps["issueSessionGate"];
  log?: Logger;
};

export interface ProjectsFeature extends Feature {
  service: ProjectsService;

  purgeExpiredTrash(): Promise<number>;
  startBackgroundTasks(): void;
  revokeMemberProjectAccess(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ): Promise<void>;
  applyInvitationGrants(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    grantedByHumanId: string,
    offered: readonly { projectId: string; level: ProjectAccessLevel }[],
  ): Promise<string[]>;

  projectAccessCeiling(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectAccessLevel | null>>;
}

export function createProjectsFeature(deps: ProjectsDepsWithAccounts): ProjectsFeature {
  const service = createProjectsService(deps);
  return {
    name: "projects",
    rest: createProjectsRest(service, deps.sessionReader, deps.agentAuthenticator),
    service,

    registerTools: createProjectsMcp(service, deps.agentAuthenticator),
    purgeExpiredTrash: () => service.purgeExpiredTrash(),
    startBackgroundTasks: () => {
      const timer = setInterval(
        () => {
          void service.purgeExpiredTrash().catch((error: unknown) => {
            deps.log?.warn("trash purge sweep failed", { error: String(error) });
          });
        },
        60 * 60 * 1000,
      );
      timer.unref();
    },
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      service.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      service.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      service.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
  };
}
