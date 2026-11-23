import { randomUUID } from "node:crypto";
import {
  FallbackPolicy,
  ProjectAccessLevel,
  QuestionStatus,
  type AgentIdentity,
  type Question,
} from "@orrery/contract";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  agents,
  humans,
  issues,
  projectActivity,
  projects,
  questions,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { Logger } from "../../platform/log.ts";
import type { NotifyActivity } from "../notifications/index.ts";
import type { EnqueueWebhookActivity } from "../webhooks/index.ts";
import { renderEmail, type OutgoingMail } from "../settings/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { decideQuestionAnswer, questionMachine } from "./state-machine.ts";

export type InboxErrorKind =
  | "not_signed_in"
  | "agents_cannot_use_inbox"
  | "agents_cannot_answer"
  | "issue_not_found"
  | "project_not_found"
  | "run_not_found"
  | "session_required"
  | "insufficient_access"
  | "question_not_found"
  | "question_open"
  | "question_not_open"
  | "question_resolved";

const messages: Record<InboxErrorKind, string> = {
  not_signed_in: "Sign in as a human to use the inbox.",
  agents_cannot_use_inbox: "Only humans may use the inbox.",
  agents_cannot_answer: "Only humans may answer a question; agents and sibling runs cannot.",
  issue_not_found: "No such issue is in scope for this agent.",
  project_not_found: "No such project is in scope for the caller.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  session_required: "This agent holds no live session for this issue.",
  insufficient_access: "Contribute access is required to answer questions on this project.",
  question_not_found: "No such question is in scope for the caller.",
  question_open: "This issue already has an open question.",
  question_not_open: "Only an open issue can be asked about.",
  question_resolved: "This question has already been resolved.",
};

export class InboxError extends Error {
  readonly kind: InboxErrorKind;

  constructor(kind: InboxErrorKind) {
    super(messages[kind]);
    this.name = "InboxError";
    this.kind = kind;
  }
}

export type InboxProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface InboxDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: InboxProjectAccessCeiling;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;

  deliver: (mail: OutgoingMail) => Promise<void>;
  log: Logger;
  notifyActivity?: NotifyActivity | undefined;
  onActivity?: EnqueueWebhookActivity | undefined;
}

const noNotify: NotifyActivity = async () => {};
const noEnqueue: EnqueueWebhookActivity = async () => {};

export type AgentActor = { kind: "agent"; identity: AgentIdentity };

export interface InboxService {
  ask(
    actor: AgentActor | null,
    input: { issueId: string; runId: string; question: string; proposedFallback: string },
  ): Promise<Question>;
  answer(actor: WorkActor | null, questionId: string, answer: string): Promise<Question>;
  list(actor: WorkActor | null): Promise<Question[]>;
  issueHistory(actor: WorkActor | null, issueId: string): Promise<Question[]>;

  questionDeadline(tx: DbTransaction, issueId: string): Promise<Date | null>;
  evaluateDeadline(tx: DbTransaction, issueId: string): Promise<void>;
  findDueQuestionIssueIds(): Promise<string[]>;
}

type QuestionRow = typeof questions.$inferSelect;
type QuestionView = Omit<QuestionRow, "sessionId"> & { effectiveStatus?: string };
type QuestionIssueInfo = {
  number: number;
  title: string;
  projectKey: string;
  canAnswer: boolean;
};

const questionColumns = {
  id: questions.id,
  issueId: questions.issueId,
  issueNumber: issues.number,
  issueTitle: issues.title,
  projectId: questions.projectId,
  projectKey: projects.key,
  workspaceId: questions.workspaceId,
  agentId: questions.agentId,
  runId: questions.runId,
  question: questions.question,
  proposedFallback: questions.proposedFallback,
  status: questions.status,
  effectiveStatus: sql<string>`case when ${questions.status} = 'open' and ${questions.responseDeadlineAt} <= statement_timestamp() then case when coalesce(${issues.fallbackPolicyOverride}, ${projects.fallbackPolicy}) = 'fallback_allowed' then 'fallback_used' else 'paused' end else ${questions.status} end`,
  responseDeadlineAt: questions.responseDeadlineAt,
  answer: questions.answer,
  answeredByHumanId: questions.answeredByHumanId,
  answeredAt: questions.answeredAt,
  followUp: questions.followUp,
  followUpByHumanId: questions.followUpByHumanId,
  followUpAt: questions.followUpAt,
  resolvedAt: questions.resolvedAt,
  createdAt: questions.createdAt,
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toQuestion(row: QuestionView, issue: QuestionIssueInfo): Question {
  const status = QuestionStatus.parse(row.effectiveStatus ?? row.status);
  return {
    id: row.id,
    issueId: row.issueId,
    issueNumber: issue.number,
    issueTitle: issue.title,
    projectId: row.projectId,
    projectKey: issue.projectKey,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    runId: row.runId,
    question: row.question,
    proposedFallback: row.proposedFallback,
    status,

    authorizedFallback: status === QuestionStatus.enum.fallback_used ? row.proposedFallback : null,
    responseDeadlineAt: row.responseDeadlineAt.toISOString(),
    answer: row.answer,
    answeredByHumanId: row.answeredByHumanId,
    answeredAt: iso(row.answeredAt),
    followUp: row.followUp,
    followUpByHumanId: row.followUpByHumanId,
    followUpAt: iso(row.followUpAt),
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
    canAnswer: issue.canAnswer,
  };
}

async function lockIssue(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select({
      id: issues.id,
      projectId: issues.projectId,
      title: issues.title,
      number: issues.number,
      status: issues.status,
    })
    .from(issues)

    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
    .limit(1)
    .for("update");
  if (row === undefined) throw new InboxError("issue_not_found");
  return row;
}

async function effectiveFallbackPolicy(
  tx: DbTransaction,
  issueId: string,
): Promise<FallbackPolicy> {
  const [policy] = await tx
    .select({
      override: issues.fallbackPolicyOverride,
      projectPolicy: projects.fallbackPolicy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  return policy?.override ?? policy?.projectPolicy ?? FallbackPolicy.enum.require_human;
}

async function recordActivity(
  tx: DbTransaction,
  input: {
    projectId: string;
    issueId: string;
    type:
      | "issue_question_asked"
      | "issue_question_answered"
      | "issue_question_paused"
      | "issue_question_fallback_used"
      | "issue_question_follow_up";
    summary: string;
    agentId?: string;
    humanId?: string;
  },
  notify: NotifyActivity = noNotify,
  onActivity: EnqueueWebhookActivity = noEnqueue,
) {
  const activityId = randomUUID();
  await tx.insert(projectActivity).values({
    id: activityId,
    projectId: input.projectId,
    type: input.type,
    issueId: input.issueId,
    summary: input.summary,
    actorAgentId: input.agentId ?? null,
    actorHumanId: input.humanId ?? null,
    createdAt: sql`statement_timestamp()`,
  });
  await onActivity(tx, activityId);
  if (input.type === "issue_question_asked" || input.type === "issue_question_paused") {
    await notify(tx, {
      activityId,
      projectId: input.projectId,
      issueId: input.issueId,
      kind: "needs_input",
      summary: input.summary,
      actorAgentId: input.agentId ?? null,
      actorHumanId: input.humanId ?? null,
    });
  }
}

async function storeFollowUp(
  tx: DbTransaction,
  input: {
    questionId: string;
    projectId: string;
    issueId: string;
    answer: string;
    humanId: string;
  },
  onActivity: EnqueueWebhookActivity = noEnqueue,
) {
  const [followed] = await tx
    .update(questions)
    .set({
      followUp: input.answer,
      followUpByHumanId: input.humanId,
      followUpAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(questions.id, input.questionId),
        eq(questions.status, "fallback_used"),
        isNull(questions.followUp),
      ),
    )
    .returning();
  if (followed === undefined) throw new InboxError("question_resolved");
  await recordActivity(
    tx,
    {
      projectId: input.projectId,
      issueId: input.issueId,
      type: "issue_question_follow_up",
      summary: `Follow-up on an authorized fallback: ${input.answer}`,
      humanId: input.humanId,
    },
    noNotify,
    onActivity,
  );
  return followed;
}

function humanIdOf(actor: WorkActor): string {
  if (actor.kind === "human") return actor.account.humanId;
  throw new InboxError("agents_cannot_use_inbox");
}

async function requireAccess(
  tx: DbTransaction,
  actor: WorkActor,
  projectId: string,
  required: ProjectAccessLevel,
  deps: InboxDeps,
  missing: "issue_not_found" | "project_not_found" | "question_not_found",
) {
  const [project] = await tx
    .select({ id: projects.id, workspaceId: projects.workspaceId, key: projects.key })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (
    project === undefined ||
    (actor.kind === "agent" && project.workspaceId !== actor.identity.workspaceId)
  ) {
    throw new InboxError(missing);
  }
  const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
  const ceiling = await deps.projectAccessCeiling(tx, project.workspaceId, humanId, [projectId]);
  const humanLevel = ceiling.get(projectId) ?? null;
  let effective = humanLevel;
  if (actor.kind === "agent") {
    const keyLevel = actor.identity.projects.find((grant) => grant.projectId === projectId)?.level;
    if (keyLevel === undefined) throw new InboxError(missing);
    effective =
      humanLevel === null
        ? null
        : deps.projectAccessAtLeast(humanLevel, keyLevel)
          ? keyLevel
          : humanLevel;
  }

  if (effective === null) throw new InboxError(missing);
  if (!deps.projectAccessAtLeast(effective, required)) {
    throw new InboxError("insufficient_access");
  }
  return { project, level: effective };
}

function requireAgent(actor: AgentActor | null): AgentIdentity {
  if (actor === null) throw new InboxError("not_signed_in");
  return actor.identity;
}

const evaluateDeadline = async (
  tx: DbTransaction,
  issueId: string,
  notify: NotifyActivity = noNotify,
  onActivity: EnqueueWebhookActivity = noEnqueue,
): Promise<void> => {
  const [due] = await tx
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.issueId, issueId),
        eq(questions.status, "open"),
        lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (due === undefined) return;
  const effectivePolicy = await effectiveFallbackPolicy(tx, issueId);
  const stillDue = and(
    eq(questions.id, due.id),
    eq(questions.status, "open"),
    lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
  );

  if (effectivePolicy === FallbackPolicy.enum.fallback_allowed) {
    questionMachine.assertTransition("open", "fallback_used");
    const [used] = await tx
      .update(questions)
      .set({ status: "fallback_used", resolvedAt: sql`statement_timestamp()` })
      .where(stillDue)
      .returning();
    if (used === undefined) return;

    await tx
      .update(issues)
      .set({ needsInput: false, updatedAt: sql`statement_timestamp()` })
      .where(eq(issues.id, issueId));
    const [liveClaim] = await tx
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          eq(workSessions.issueId, issueId),
          eq(workSessions.status, "active"),
          gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (liveClaim === undefined) {
      await tx
        .update(workSessions)
        .set({
          status: "expired",
          endedAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(
          and(
            eq(workSessions.issueId, issueId),
            eq(workSessions.status, "active"),
            lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          ),
        );
      await tx
        .update(issues)
        .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
        .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
    }
    await recordActivity(
      tx,
      {
        projectId: used.projectId,
        issueId,
        type: "issue_question_fallback_used",
        summary: `Authorized fallback used at the one-hour deadline: ${used.question}`,
        agentId: used.agentId,
      },
      notify,
      onActivity,
    );
    return;
  }

  questionMachine.assertTransition("open", "paused");
  const [paused] = await tx
    .update(questions)
    .set({ status: "paused", resolvedAt: sql`statement_timestamp()` })
    .where(stillDue)
    .returning();
  if (paused === undefined) return;

  await tx
    .update(workSessions)
    .set({
      status: "expired",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );
  await tx
    .update(workSessions)
    .set({
      status: "released",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );

  await tx
    .update(issues)
    .set({ needsInput: true, updatedAt: sql`statement_timestamp()` })
    .where(eq(issues.id, issueId));
  await tx
    .update(issues)
    .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
    .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
  await recordActivity(
    tx,
    {
      projectId: paused.projectId,
      issueId,
      type: "issue_question_paused",
      summary: `Question paused at the one-hour deadline: ${paused.question}`,
      agentId: paused.agentId,
    },
    notify,
    onActivity,
  );
};

const questionDeadline: InboxService["questionDeadline"] = async (tx, issueId) => {
  const [row] = await tx
    .select({ responseDeadlineAt: questions.responseDeadlineAt })
    .from(questions)
    .where(and(eq(questions.issueId, issueId), eq(questions.status, "open")))
    .limit(1);
  if (row === undefined) return null;

  return (await effectiveFallbackPolicy(tx, issueId)) === FallbackPolicy.enum.require_human
    ? row.responseDeadlineAt
    : null;
};

export function createInboxService(deps: InboxDeps): InboxService {
  const { db } = deps;

  return {
    async ask(actorArg, input) {
      const identity = requireAgent(actorArg);
      const actor: WorkActor = { kind: "agent", identity };

      const outcome = await db.transaction(async (tx) => {
        const issue = await lockIssue(tx, input.issueId);
        await evaluateDeadline(tx, issue.id, deps.notifyActivity, deps.onActivity);
        const access = await requireAccess(
          tx,
          actor,
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          deps,
          "issue_not_found",
        );
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.agentId, identity.agentId),
              eq(runs.workspaceId, identity.workspaceId),
            ),
          )
          .limit(1);
        if (run === undefined) throw new InboxError("run_not_found");

        if (issue.status !== "in_progress") throw new InboxError("question_not_open");
        const [session] = await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.issueId, issue.id),
              eq(workSessions.runId, input.runId),
              eq(workSessions.agentId, identity.agentId),
              eq(workSessions.workspaceId, identity.workspaceId),
              eq(workSessions.status, "active"),
              gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
            ),
          )
          .limit(1);
        if (session === undefined) throw new InboxError("session_required");
        const [existing] = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(eq(questions.issueId, issue.id), sql`${questions.status} in ('open', 'paused')`),
          )
          .limit(1);
        if (existing !== undefined) throw new InboxError("question_open");
        const [created] = await tx
          .insert(questions)
          .values({
            id: randomUUID(),
            issueId: issue.id,
            projectId: issue.projectId,
            workspaceId: identity.workspaceId,
            agentId: identity.agentId,
            runId: input.runId,
            sessionId: session.id,
            question: input.question,
            proposedFallback: input.proposedFallback,
            status: "open",
            responseDeadlineAt: sql`statement_timestamp() + interval '1 hour'`,
            createdAt: sql`statement_timestamp()`,
          })
          .returning();
        if (created === undefined) throw new InboxError("question_open");
        await tx
          .update(issues)
          .set({ needsInput: true, updatedAt: sql`statement_timestamp()` })
          .where(eq(issues.id, issue.id));
        await recordActivity(
          tx,
          {
            projectId: issue.projectId,
            issueId: issue.id,
            type: "issue_question_asked",
            summary: `Question asked: ${input.question}`,
            agentId: identity.agentId,
          },
          deps.notifyActivity,
          deps.onActivity,
        );
        const [owner] = await tx
          .select({ email: humans.email, name: agents.name })
          .from(agents)
          .innerJoin(humans, eq(humans.id, agents.humanId))
          .where(eq(agents.id, identity.agentId))
          .limit(1);
        return {
          question: toQuestion(created, {
            number: issue.number,
            title: issue.title,
            projectKey: access.project.key,
            canAnswer: false,
          }),
          ownerEmail: owner?.email ?? null,
          agentName: owner?.name ?? identity.agentId,
          issueTitle: issue.title,
          issueNumber: issue.number,
        };
      });

      if (outcome.ownerEmail !== null) {
        try {
          await deps.deliver({
            to: outcome.ownerEmail,
            subject: `Orrery: input needed on #${outcome.issueNumber} ${outcome.issueTitle}`,
            text: [
              `${outcome.agentName} asked for input on issue #${outcome.issueNumber} (${outcome.issueTitle}).`,
              "",
              outcome.question.question,
              "",
              `Proposed fallback: ${outcome.question.proposedFallback}`,
              "",
              `Answer it in the Orrery inbox before ${outcome.question.responseDeadlineAt}.`,
            ].join("\n"),
            html: renderEmail({
              preheader: `${outcome.agentName} asked for input on #${outcome.issueNumber}.`,
              heading: `Input needed on #${outcome.issueNumber}`,
              paragraphs: [`${outcome.agentName} asked for your input on "${outcome.issueTitle}".`],
              callout: {
                label: "Question",
                body: outcome.question.question,
                meta: `Proposed fallback: ${outcome.question.proposedFallback}`,
              },
              footnote: `Answer it in your Orrery inbox before ${outcome.question.responseDeadlineAt}.`,
            }),
          });
        } catch (error) {
          deps.log.warn("input notification email was not delivered", {
            questionId: outcome.question.id,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      return outcome.question;
    },

    async answer(actorArg, questionId, answer) {
      const actor = actorArg;
      if (actor === null) throw new InboxError("not_signed_in");
      if (actor.kind === "agent") throw new InboxError("agents_cannot_answer");
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select({ issueId: questions.issueId })
          .from(questions)
          .where(eq(questions.id, questionId))
          .limit(1);
        if (found === undefined) throw new InboxError("question_not_found");
        const issue = await lockIssue(tx, found.issueId);
        const access = await requireAccess(
          tx,
          actor,
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          deps,
          "question_not_found",
        );
        const questionView = (row: QuestionView) =>
          toQuestion(row, {
            number: issue.number,
            title: issue.title,
            projectKey: access.project.key,
            canAnswer: true,
          });

        await evaluateDeadline(tx, issue.id, deps.notifyActivity, deps.onActivity);
        const freshRow = async () => {
          const [fresh] = await tx
            .select()
            .from(questions)
            .where(eq(questions.id, questionId))
            .limit(1)
            .for("update");
          if (fresh === undefined) throw new InboxError("question_not_found");
          return fresh;
        };
        const followUp = () =>
          storeFollowUp(
            tx,
            {
              questionId,
              projectId: issue.projectId,
              issueId: issue.id,
              answer,
              humanId: actor.account.humanId,
            },
            deps.onActivity,
          );
        const row = await freshRow();
        const answerAction = decideQuestionAnswer(row.status, row.followUp !== null);
        if (answerAction === "already_resolved") throw new InboxError("question_resolved");
        if (answerAction === "record_follow_up") return questionView(await followUp());
        questionMachine.assertTransition(row.status, "answered");

        const resolveAnswered = () =>
          tx
            .update(questions)
            .set({
              status: "answered",
              answer,
              answeredByHumanId: actor.account.humanId,
              answeredAt: sql`statement_timestamp()`,
              resolvedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(questions.id, questionId),
                sql`${questions.status} in ('open', 'paused')`,

                or(
                  gt(questions.responseDeadlineAt, sql`statement_timestamp()`),
                  eq(questions.status, "paused"),
                ),
              ),
            )
            .returning();
        const [first] = await resolveAnswered();
        let answered = first;
        if (answered === undefined) {
          await evaluateDeadline(tx, issue.id, deps.notifyActivity, deps.onActivity);
          const retried = await freshRow();
          if (retried.status === "fallback_used") return questionView(await followUp());
          if (retried.status === "answered") throw new InboxError("question_resolved");
          if (retried.status === "paused" || retried.status === "open") {
            const [resolved] = await resolveAnswered();
            answered = resolved;
          }
        }
        if (answered === undefined) throw new InboxError("question_resolved");

        await tx
          .update(issues)
          .set({ needsInput: false, updatedAt: sql`statement_timestamp()` })
          .where(eq(issues.id, issue.id));

        const [liveClaim] = await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.issueId, issue.id),
              eq(workSessions.status, "active"),
              gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
            ),
          )
          .limit(1);
        if (liveClaim === undefined) {
          await tx
            .update(workSessions)
            .set({
              status: "expired",
              endedAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(workSessions.issueId, issue.id),
                eq(workSessions.status, "active"),
                lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
              ),
            );
          await tx
            .update(issues)
            .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
            .where(and(eq(issues.id, issue.id), eq(issues.status, "in_progress")));
        }
        await recordActivity(
          tx,
          {
            projectId: issue.projectId,
            issueId: issue.id,
            type: "issue_question_answered",
            summary: `Question answered: ${answer}`,
            humanId: actor.account.humanId,
          },
          noNotify,
          deps.onActivity,
        );
        return questionView(answered);
      });
    },

    async list(actorArg) {
      if (actorArg === null) throw new InboxError("not_signed_in");
      if (actorArg.kind === "agent") throw new InboxError("agents_cannot_use_inbox");
      const humanId = humanIdOf(actorArg);
      return db.transaction(
        async (tx) => {
          const personal = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.personalOwnerHumanId, humanId));
          const memberships = await tx
            .select({ workspaceId: workspaceMemberships.workspaceId })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.humanId, humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          const workspaceIds = [
            ...new Set([
              ...personal.map((row) => row.id),
              ...memberships.map((row) => row.workspaceId),
            ]),
          ];
          if (workspaceIds.length === 0) return [];
          const candidates = await tx
            .selectDistinct({ workspaceId: questions.workspaceId, projectId: questions.projectId })
            .from(questions)
            .innerJoin(issues, eq(issues.id, questions.issueId))
            .where(and(inArray(questions.workspaceId, workspaceIds), isNull(issues.deletedAt)));
          const candidateProjects = new Map<string, string[]>();
          for (const row of candidates) {
            const projectIds = candidateProjects.get(row.workspaceId) ?? [];
            projectIds.push(row.projectId);
            candidateProjects.set(row.workspaceId, projectIds);
          }

          const readable: string[] = [];
          const answerable = new Set<string>();
          for (const [workspaceId, projectIds] of candidateProjects) {
            const ceiling = await deps.projectAccessCeiling(tx, workspaceId, humanId, projectIds);
            for (const projectId of projectIds) {
              const level = ceiling.get(projectId) ?? null;
              if (
                level !== null &&
                deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)
              ) {
                readable.push(projectId);
                if (deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.contribute)) {
                  answerable.add(projectId);
                }
              }
            }
          }
          if (readable.length === 0) return [];

          const rows = await tx
            .select(questionColumns)
            .from(questions)
            .innerJoin(issues, eq(issues.id, questions.issueId))
            .innerJoin(projects, eq(projects.id, questions.projectId))
            .where(
              and(
                inArray(questions.workspaceId, workspaceIds),
                inArray(questions.projectId, readable),
                eq(questions.workspaceId, projects.workspaceId),
                isNull(issues.deletedAt),
              ),
            )
            .orderBy(desc(questions.createdAt))
            .limit(200);
          return rows.map((row) =>
            toQuestion(row, {
              number: row.issueNumber,
              title: row.issueTitle,
              projectKey: row.projectKey,
              canAnswer: answerable.has(row.projectId),
            }),
          );
        },
        { accessMode: "read only" },
      );
    },

    async issueHistory(actorArg, issueId) {
      if (actorArg === null) throw new InboxError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const [issue] = await tx
            .select({ projectId: issues.projectId, number: issues.number, title: issues.title })
            .from(issues)
            .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
            .limit(1);
          if (issue === undefined) throw new InboxError("issue_not_found");
          const access = await requireAccess(
            tx,
            actorArg,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            deps,
            "issue_not_found",
          );
          const canAnswer =
            actorArg.kind === "human" &&
            deps.projectAccessAtLeast(access.level, ProjectAccessLevel.enum.contribute);
          const rows = await tx
            .select(questionColumns)
            .from(questions)
            .innerJoin(issues, eq(issues.id, questions.issueId))
            .innerJoin(projects, eq(projects.id, questions.projectId))
            .where(eq(questions.issueId, issueId))
            .orderBy(desc(questions.createdAt));
          return rows.map((row) =>
            toQuestion(row, {
              number: issue.number,
              title: issue.title,
              projectKey: access.project.key,
              canAnswer,
            }),
          );
        },
        { accessMode: "read only" },
      );
    },

    questionDeadline,
    evaluateDeadline: (tx, issueId) =>
      evaluateDeadline(tx, issueId, deps.notifyActivity, deps.onActivity),

    async findDueQuestionIssueIds() {
      return db.transaction(
        async (tx) => {
          const due = await tx
            .select({ issueId: questions.issueId })
            .from(questions)
            .innerJoin(issues, eq(questions.issueId, issues.id))
            .where(
              and(
                eq(questions.status, QuestionStatus.enum.open),
                lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
                isNull(issues.deletedAt),
              ),
            )
            .orderBy(questions.issueId)
            .limit(100);
          return [...new Set(due.map((row) => row.issueId))];
        },
        { accessMode: "read only" },
      );
    },
  };
}
