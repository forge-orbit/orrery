import {
  ProjectAccessLevel,
  QuestionStatus,
  TERMINAL_ISSUE_STATUSES,
  type MyWorkResponse,
} from "@orrery/contract";
import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  humans,
  issues,
  projects,
  questions,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionAccount } from "../accounts/index.ts";

export type MyWorkErrorKind = "not_signed_in" | "human_deactivated";

const messages: Record<MyWorkErrorKind, string> = {
  not_signed_in: "Sign in as a human to see My work.",
  human_deactivated: "This account is deactivated.",
};

export class MyWorkError extends Error {
  readonly kind: MyWorkErrorKind;

  constructor(kind: MyWorkErrorKind) {
    super(messages[kind]);
    this.name = "MyWorkError";
    this.kind = kind;
  }
}

export type MyWorkProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface MyWorkDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: MyWorkProjectAccessCeiling;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;
}

export interface MyWorkService {
  get(actor: SessionAccount | null): Promise<MyWorkResponse>;
}

const effectiveQuestionStatus = sql<string>`case when ${questions.status} = 'open' and ${questions.responseDeadlineAt} <= statement_timestamp() then case when coalesce(${issues.fallbackPolicyOverride}, ${projects.fallbackPolicy}) = 'fallback_allowed' then 'fallback_used' else 'paused' end else ${questions.status} end`;

const PAGE = 200;

const byNewest = (a: string, b: string) => b.localeCompare(a);

export function createMyWorkService(deps: MyWorkDeps): MyWorkService {
  return {
    async get(actor) {
      if (actor === null) throw new MyWorkError("not_signed_in");

      return deps.db.transaction(
        async (tx) => {
          const [human] = await tx
            .select({ id: humans.id, deactivatedAt: humans.deactivatedAt })
            .from(humans)
            .where(eq(humans.id, actor.humanId))
            .limit(1);
          if (human === undefined) throw new MyWorkError("not_signed_in");
          if (human.deactivatedAt !== null) throw new MyWorkError("human_deactivated");

          const personal = await tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.personalOwnerHumanId, actor.humanId));
          const shared = await tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .innerJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, workspaces.id),
                eq(workspaceMemberships.humanId, actor.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          const scopes = [
            ...new Map([...personal, ...shared].map((row) => [row.id, row])).values(),
          ];

          if (scopes.length === 0) {
            return { assignedIssues: [], activeAgentSessions: [], needsInputQuestions: [] };
          }

          const workspaceIds = scopes.map((scope) => scope.id);
          const workspaceNames = new Map(scopes.map((scope) => [scope.id, scope.name]));
          const allProjects = await tx
            .select({
              id: projects.id,
              workspaceId: projects.workspaceId,
              key: projects.key,
            })
            .from(projects)
            .where(and(inArray(projects.workspaceId, workspaceIds), isNull(projects.deletedAt)));
          if (allProjects.length === 0) {
            return { assignedIssues: [], activeAgentSessions: [], needsInputQuestions: [] };
          }

          // The ceiling helper is workspace-scoped, so one call per workspace resolves
          // every project instead of one call per project.
          const projectsByWorkspace = new Map<
            string,
            { id: string; workspaceId: string; key: string }[]
          >();
          for (const project of allProjects) {
            const list = projectsByWorkspace.get(project.workspaceId) ?? [];
            list.push(project);
            projectsByWorkspace.set(project.workspaceId, list);
          }
          const levels = new Map<string, ProjectAccessLevel | null>();
          for (const [workspaceId, workspaceProjects] of projectsByWorkspace) {
            const ceiling = await deps.projectAccessCeiling(
              tx,
              workspaceId,
              actor.humanId,
              workspaceProjects.map((row) => row.id),
            );
            for (const [projectId, level] of ceiling) levels.set(projectId, level);
          }

          const readable: string[] = [];
          const actionable: string[] = [];
          for (const project of allProjects) {
            const level = levels.get(project.id) ?? null;
            if (level === null) continue;
            if (deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
              readable.push(project.id);
            }
            if (deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.contribute)) {
              actionable.push(project.id);
            }
          }
          if (readable.length === 0) {
            return { assignedIssues: [], activeAgentSessions: [], needsInputQuestions: [] };
          }

          const assignedIssues = (
            await tx
              .select({
                id: issues.id,
                projectId: issues.projectId,
                projectName: projects.name,
                projectKey: projects.key,
                workspaceId: projects.workspaceId,
                number: issues.number,
                title: issues.title,
                status: issues.status,
                priority: issues.priority,
                needsInput: issues.needsInput,
                updatedAt: issues.updatedAt,
              })
              .from(issues)
              .innerJoin(projects, eq(projects.id, issues.projectId))
              .where(
                and(
                  inArray(issues.projectId, readable),
                  inArray(projects.workspaceId, workspaceIds),
                  eq(issues.assigneeType, "human"),
                  eq(issues.assigneeId, actor.humanId),
                  isNull(issues.deletedAt),
                  notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
                ),
              )
              .orderBy(desc(issues.updatedAt))
              .limit(PAGE)
          ).map((row) => ({
            id: row.id,
            projectId: row.projectId,
            projectName: row.projectName,
            projectKey: row.projectKey,
            workspaceId: row.workspaceId,
            workspaceName: workspaceNames.get(row.workspaceId) ?? "",
            number: row.number,
            identifier: `${row.projectKey}-${row.number}`,
            title: row.title,
            status: row.status,
            priority: row.priority,
            needsInput: row.needsInput,
            updatedAt: row.updatedAt.toISOString(),
          }));

          const activeAgentSessions = (
            await tx
              .select({
                id: workSessions.id,
                agentId: workSessions.agentId,
                agentName: agents.name,
                runId: workSessions.runId,
                harness: runs.harness,
                model: runs.model,
                issueId: issues.id,
                issueNumber: issues.number,
                issueTitle: issues.title,
                issueProjectId: issues.projectId,
                projectName: projects.name,
                projectKey: projects.key,
                workspaceId: workSessions.workspaceId,
                leaseExpiresAt: workSessions.leaseExpiresAt,
                progress: workSessions.progress,
                stopRequestedAt: workSessions.stopRequestedAt,
                stopReason: workSessions.stopReason,
                inputTokens: workSessions.inputTokens,
                outputTokens: workSessions.outputTokens,
                costUsdMicros: workSessions.costUsdMicros,
              })
              .from(workSessions)
              .innerJoin(agents, eq(agents.id, workSessions.agentId))
              .innerJoin(runs, eq(runs.id, workSessions.runId))
              .innerJoin(issues, eq(issues.id, workSessions.issueId))
              .innerJoin(projects, eq(projects.id, issues.projectId))
              .where(
                and(
                  inArray(workSessions.workspaceId, workspaceIds),
                  eq(agents.humanId, actor.humanId),
                  eq(workSessions.status, "active"),
                  gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                  isNull(issues.deletedAt),
                  inArray(issues.projectId, readable),
                  eq(workSessions.workspaceId, projects.workspaceId),
                ),
              )
              .orderBy(desc(workSessions.leaseExpiresAt))
              .limit(PAGE)
          ).map((row) => ({
            sessionId: row.id,
            agentId: row.agentId,
            agentName: row.agentName,
            runId: row.runId,
            harness: row.harness,
            model: row.model,
            issueId: row.issueId,
            issueIdentifier: `${row.projectKey}-${row.issueNumber}`,
            issueTitle: row.issueTitle,
            projectId: row.issueProjectId,
            projectName: row.projectName,
            workspaceId: row.workspaceId,
            workspaceName: workspaceNames.get(row.workspaceId) ?? "",
            leaseExpiresAt: row.leaseExpiresAt.toISOString(),
            progress: row.progress,
            stopRequestedAt: row.stopRequestedAt?.toISOString() ?? null,
            stopReason: row.stopReason,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            costUsdMicros: row.costUsdMicros,
          }));

          let needsInputQuestions: MyWorkResponse["needsInputQuestions"] = [];
          if (actionable.length > 0) {
            needsInputQuestions = (
              await tx
                .select({
                  id: questions.id,
                  issueId: questions.issueId,
                  issueNumber: issues.number,
                  issueTitle: issues.title,
                  issueProjectId: issues.projectId,
                  projectName: projects.name,
                  projectKey: projects.key,
                  workspaceId: questions.workspaceId,
                  agentId: questions.agentId,
                  agentName: agents.name,
                  question: questions.question,
                  status: effectiveQuestionStatus,
                  responseDeadlineAt: questions.responseDeadlineAt,
                  createdAt: questions.createdAt,
                })
                .from(questions)
                .innerJoin(issues, eq(issues.id, questions.issueId))
                .innerJoin(projects, eq(projects.id, questions.projectId))
                .innerJoin(agents, eq(agents.id, questions.agentId))
                .where(
                  and(
                    inArray(questions.workspaceId, workspaceIds),
                    inArray(questions.projectId, actionable),
                    inArray(questions.status, [
                      QuestionStatus.enum.open,
                      QuestionStatus.enum.paused,
                    ]),
                    isNull(issues.deletedAt),
                    eq(questions.workspaceId, projects.workspaceId),
                    sql`${effectiveQuestionStatus} in ('open', 'paused')`,
                  ),
                )
                .orderBy(desc(questions.createdAt))
                .limit(PAGE)
            ).map((row) => ({
              id: row.id,
              issueId: row.issueId,
              issueIdentifier: `${row.projectKey}-${row.issueNumber}`,
              issueTitle: row.issueTitle,
              projectId: row.issueProjectId,
              projectName: row.projectName,
              workspaceId: row.workspaceId,
              workspaceName: workspaceNames.get(row.workspaceId) ?? "",
              agentId: row.agentId,
              agentName: row.agentName,
              question: row.question,
              status: QuestionStatus.parse(row.status),
              responseDeadlineAt: row.responseDeadlineAt.toISOString(),
              createdAt: row.createdAt.toISOString(),
            }));
          }

          return {
            assignedIssues: assignedIssues
              .toSorted((a, b) => byNewest(a.updatedAt, b.updatedAt))
              .slice(0, PAGE),
            activeAgentSessions: activeAgentSessions
              .toSorted((a, b) => byNewest(a.leaseExpiresAt, b.leaseExpiresAt))
              .slice(0, PAGE),
            needsInputQuestions: needsInputQuestions
              .toSorted((a, b) => byNewest(a.createdAt, b.createdAt))
              .slice(0, PAGE),
          };
        },
        { accessMode: "read only" },
      );
    },
  };
}
