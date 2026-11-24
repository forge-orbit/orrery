import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AnswerQuestionInput,
  AskForInputInput,
  InboxResponse,
  IssueQuestionParams,
  Question,
  QuestionParams,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { agentErrorStatus, isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import { assertDispatchBodyAllowed, assertDispatchRestAllowed } from "../agents/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { InboxError, type InboxErrorKind, type InboxService } from "./service.ts";

const askBody = AskForInputInput;
const answerBody = AnswerQuestionInput;
const questionParams = QuestionParams;
const issueParams = IssueQuestionParams;

const ask = createRoute({
  method: "post",
  path: "/api/questions",
  summary: "Ask the team a blocking question",
  description:
    "An agent with a live claim asks a question, proposes a fallback and sets its issue to Needs input. The agent's owner is emailed after the question commits. The agent cannot authorize its own fallback: at the one-hour deadline a require_human question pauses and releases the claim, while a fallback_allowed question resolves to fallback_used, clears Needs input and keeps a checking-in worker's claim.",
  request: {
    body: { required: true, content: { "application/json": { schema: askBody } } },
  },
  responses: {
    201: {
      description: "The open question",
      content: { "application/json": { schema: Question } },
    },
    400: problem("The question is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to ask"),
    404: problem("No such issue or run is in scope for this agent"),
    409: problem("No live claim, or this issue already has an open question"),
  },
});

const inbox = createRoute({
  method: "get",
  path: "/api/inbox",
  summary: "The human input inbox",
  description:
    "Open, paused and resolved questions for projects the signed-in human can read, newest first. Agent keys are refused: only humans use the inbox, and only Contribute or Manage may answer.",
  responses: {
    200: {
      description: "The questions",
      content: { "application/json": { schema: InboxResponse } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Agent keys cannot use the human inbox"),
  },
});

const answer = createRoute({
  method: "post",
  path: "/api/questions/{questionId}/answer",
  summary: "Answer a question in the inbox",
  description:
    "A human with Contribute or Manage answers a question. Answering before the one-hour deadline, or after a paused question, resolves it exactly once and clears Needs input. An answer on or after the deadline to a fallback_allowed question is stored as a follow-up: it never reverses the authorized fallback, reopens the issue, or restores Needs input. Agents and sibling runs are refused, as are Readers and unrelated members.",
  request: {
    params: questionParams,
    body: { required: true, content: { "application/json": { schema: answerBody } } },
  },
  responses: {
    200: {
      description: "The resolved question",
      content: { "application/json": { schema: Question } },
    },
    400: problem("The answer is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Only humans with Contribute or Manage on the project may answer"),
    404: problem("No such question is in scope for the caller"),
    409: problem("This question has already been resolved"),
  },
});

const issueHistory = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/questions",
  summary: "An issue's question history",
  description:
    "Every question asked about an issue and its resolution, newest first. The question and its resolution also appear in the project's history feed. Needs no claim.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's questions",
      content: { "application/json": { schema: InboxResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in, or the agent key is invalid or revoked"),
    403: problem("Read access is required to inspect this issue"),
    404: problem("No such issue is in scope for the caller"),
  },
});

export const routes = [ask, inbox, answer, issueHistory];

const statusFor = {
  not_signed_in: 401,
  agents_cannot_use_inbox: 403,
  agents_cannot_answer: 403,
  issue_not_found: 404,
  project_not_found: 404,
  run_not_found: 404,
  session_required: 409,
  insufficient_access: 403,
  question_not_found: 404,
  question_open: 409,
  question_not_open: 409,
  question_resolved: 409,
} as const satisfies Record<InboxErrorKind, number>;

function isKind<K extends readonly InboxErrorKind[]>(
  error: InboxError,
  kinds: K,
): error is InboxError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

function failure<K extends readonly InboxErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, {
      status: agentErrorStatus(error.kind),
      code: error.kind,
      title: error.message,
    });
  }
  if (error instanceof InboxError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const askKinds = [
  "not_signed_in",
  "issue_not_found",
  "run_not_found",
  "session_required",
  "insufficient_access",
  "question_open",
  "question_not_open",
] as const;
const inboxKinds = ["not_signed_in", "agents_cannot_use_inbox"] as const;
const answerKinds = [
  "not_signed_in",
  "issue_not_found",
  "agents_cannot_answer",
  "insufficient_access",
  "question_not_found",
  "question_resolved",
] as const;
const historyKinds = ["not_signed_in", "issue_not_found", "insufficient_access"] as const;

export function createInboxRest(
  service: InboxService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await authenticate(c.req.raw);
    if (identity !== null) {
      assertDispatchRestAllowed(identity, c.req.method, c.req.path);
      return { kind: "agent", identity };
    }
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };
  const agentActor = async (c: Context) => {
    const identity = await authenticate(c.req.raw);
    if (identity === null) return null;
    assertDispatchRestAllowed(identity, c.req.method, c.req.path);
    return { kind: "agent" as const, identity };
  };

  app.openapi(ask, async (c) => {
    try {
      const body = c.req.valid("json");
      const actor = await agentActor(c);
      if (actor !== null) {
        const target = { issueId: body.issueId, runId: body.runId };
        const extraSessionId = Reflect.get(body, "sessionId");
        if (typeof extraSessionId === "string") {
          assertDispatchBodyAllowed(actor.identity, { ...target, sessionId: extraSessionId });
        } else {
          assertDispatchBodyAllowed(actor.identity, target);
        }
      }
      return c.json(await service.ask(actor, body), 201);
    } catch (error) {
      return failure(c, error, askKinds);
    }
  });

  app.openapi(inbox, async (c) => {
    try {
      return c.json(await service.list(await workActor(c)), 200);
    } catch (error) {
      return failure(c, error, inboxKinds);
    }
  });

  app.openapi(answer, async (c) => {
    try {
      return c.json(
        await service.answer(
          await workActor(c),
          c.req.valid("param").questionId,
          c.req.valid("json").answer,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, answerKinds);
    }
  });

  app.openapi(issueHistory, async (c) => {
    try {
      return c.json(
        await service.issueHistory(await workActor(c), c.req.valid("param").issueId),
        200,
      );
    } catch (error) {
      return failure(c, error, historyKinds);
    }
  });

  return app;
}
