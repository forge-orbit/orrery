import { z } from "zod";
import { Timestamp } from "./common.ts";
import { ProjectKey } from "./projects.ts";










export const QuestionStatus = z
  .enum(["open", "answered", "paused", "fallback_used"])
  .meta({ id: "QuestionStatus" });
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const Question = z
  .object({
    id: z.string(),
    issueId: z.string(),
    issueNumber: z.int().positive(),
    issueTitle: z.string(),
    projectId: z.string(),
    projectKey: ProjectKey,
    workspaceId: z.string(),
    agentId: z.string(),
    runId: z.string(),
    question: z.string(),
    proposedFallback: z.string(),
    status: QuestionStatus,
    
    
    
    authorizedFallback: z.string().nullable(),
    
    
    responseDeadlineAt: Timestamp,
    answer: z.string().nullable(),
    answeredByHumanId: z.string().nullable(),
    answeredAt: Timestamp.nullable(),
    
    
    followUp: z.string().nullable(),
    followUpByHumanId: z.string().nullable(),
    followUpAt: Timestamp.nullable(),
    resolvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    /** Whether the signed-in caller may answer this question. */
    canAnswer: z.boolean(),
  })
  .meta({ id: "Question" });
export type Question = z.infer<typeof Question>;

export const QuestionResponse = z.object({ question: Question }).meta({ id: "QuestionResponse" });
export type QuestionResponse = z.infer<typeof QuestionResponse>;

export const InboxResponse = z.array(Question).meta({ id: "InboxResponse" });
export type InboxResponse = z.infer<typeof InboxResponse>;



export const AskForInputInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(20_000),
    proposedFallback: z.string().trim().min(1).max(20_000),
  })
  .meta({ id: "AskForInputInput" });
export type AskForInputInput = z.infer<typeof AskForInputInput>;

export const AnswerQuestionInput = z
  .object({ answer: z.string().trim().min(1).max(20_000) })
  .meta({ id: "AnswerQuestionInput" });
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

export const QuestionParams = z
  .object({ questionId: z.string().min(1).max(200) })
  .meta({ id: "QuestionParams" });
export type QuestionParams = z.infer<typeof QuestionParams>;

export const IssueQuestionParams = z
  .object({ issueId: z.string().min(1).max(200) })
  .meta({ id: "IssueQuestionParams" });
export type IssueQuestionParams = z.infer<typeof IssueQuestionParams>;
