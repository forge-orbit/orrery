import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Issue } from "./projects.ts";







export const WorkSessionStatus = z
  .enum(["active", "completed", "released", "expired"])
  .meta({ id: "WorkSessionStatus" });
export type WorkSessionStatus = z.infer<typeof WorkSessionStatus>;



export const WorkSessionOutcome = z
  .enum(["completed", "released"])
  .meta({ id: "WorkSessionOutcome" });
export type WorkSessionOutcome = z.infer<typeof WorkSessionOutcome>;





export const SessionTelemetry = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsdMicros: z.number().int().nonnegative().optional(),
  })
  .meta({ id: "SessionTelemetry" });
export type SessionTelemetry = z.infer<typeof SessionTelemetry>;




export const WorkCompletionOutcome = z
  .enum(["review", "done"])
  .meta({ id: "WorkCompletionOutcome" });
export type WorkCompletionOutcome = z.infer<typeof WorkCompletionOutcome>;

export const WorkSession = z
  .object({
    id: z.string(),
    agentId: z.string(),
    runId: z.string(),
    workspaceId: z.string(),
    issueId: z.string(),
    status: WorkSessionStatus,
    
    
    leaseExpiresAt: Timestamp,
    
    progress: z.string(),
    progressUpdatedAt: Timestamp.nullable(),
    
    
    
    stopRequested: z.boolean(),
    stopRequestedAt: Timestamp.nullable(),
    stopReason: z.string().nullable(),
    
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsdMicros: z.number().int().nonnegative().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: "WorkSession" });
export type WorkSession = z.infer<typeof WorkSession>;

export const WorkSessionResponse = z
  .object({ session: WorkSession })
  .meta({ id: "WorkSessionResponse" });
export type WorkSessionResponse = z.infer<typeof WorkSessionResponse>;

export const WorkSessionsResponse = z
  .array(WorkSession)
  .meta({ id: "WorkSessionsResponse" });
export type WorkSessionsResponse = z.infer<typeof WorkSessionsResponse>;




export const ActiveWorkSession = WorkSession.extend({ projectId: z.string() }).meta({
  id: "ActiveWorkSession",
});
export type ActiveWorkSession = z.infer<typeof ActiveWorkSession>;

export const ActiveWorkSessionsResponse = z
  .array(ActiveWorkSession)
  .meta({ id: "ActiveWorkSessionsResponse" });
export type ActiveWorkSessionsResponse = z.infer<typeof ActiveWorkSessionsResponse>;




export const ClaimWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "ClaimWorkSessionInput" });
export type ClaimWorkSessionInput = z.infer<typeof ClaimWorkSessionInput>;





const SessionFence = z.string().trim().min(1).max(200);



export const RenewWorkSessionInput = SessionTelemetry.extend({
  issueId: z.string().trim().min(1).max(200),
  sessionId: SessionFence.optional(),
}).meta({ id: "RenewWorkSessionInput" });
export type RenewWorkSessionInput = z.infer<typeof RenewWorkSessionInput>;

export const ReportProgressInput = SessionTelemetry.extend({
  issueId: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  sessionId: SessionFence.optional(),
}).meta({ id: "ReportProgressInput" });
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;






export const StopWorkSessionInput = SessionTelemetry.extend({
  issueId: z.string().trim().min(1).max(200),
  outcome: z
    .union([WorkSessionOutcome, WorkCompletionOutcome])
    .default("completed"),
  sessionId: SessionFence.optional(),
}).meta({ id: "StopWorkSessionInput" });
export type StopWorkSessionInput = z.infer<typeof StopWorkSessionInput>;
export type StopOutcome = z.infer<typeof StopWorkSessionInput>["outcome"];

export const GetWorkSessionInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "GetWorkSessionInput" });
export type GetWorkSessionInput = z.infer<typeof GetWorkSessionInput>;




export const RequestStopWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    reason: z
      .string()
      .trim()
      .max(2000)
      .optional()
      
      
      .transform((value) => (value === undefined || value === "" ? undefined : value)),
  })
  .meta({ id: "RequestStopWorkSessionInput" });
export type RequestStopWorkSessionInput = z.infer<typeof RequestStopWorkSessionInput>;





export const ResumeWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "ResumeWorkSessionInput" });
export type ResumeWorkSessionInput = z.infer<typeof ResumeWorkSessionInput>;

export const ReacquireWorkSessionInput = ResumeWorkSessionInput;
export type ReacquireWorkSessionInput = z.infer<typeof ReacquireWorkSessionInput>;




export const ResumeDisposition = z
  .enum(["active", "expired", "ended", "none"])
  .meta({ id: "ResumeDisposition" });
export type ResumeDisposition = z.infer<typeof ResumeDisposition>;

export const ResumeWorkSessionResult = z
  .object({
    runId: z.string(),
    issueId: z.string(),
    disposition: ResumeDisposition,
    
    
    session: WorkSession.nullable(),
  })
  .meta({ id: "ResumeWorkSessionResult" });
export type ResumeWorkSessionResult = z.infer<typeof ResumeWorkSessionResult>;


export const ResumeWorkSessionResponse = z
  .object({ resume: ResumeWorkSessionResult })
  .meta({ id: "ResumeWorkSessionResponse" });
export type ResumeWorkSessionResponse = z.infer<typeof ResumeWorkSessionResponse>;






export const ReadyWorkResponse = z.array(Issue).meta({ id: "ReadyWorkResponse" });
export type ReadyWorkResponse = z.infer<typeof ReadyWorkResponse>;





export const ReadyWorkFilter = z
  .enum(["all", "assignedToMe", "unassigned"])
  .meta({ id: "ReadyWorkFilter" });
export type ReadyWorkFilter = z.infer<typeof ReadyWorkFilter>;

/** Project label names an issue must all carry; matched case-insensitively. */
export const LabelFilter = z
  .array(z.string().trim().min(1).max(200))
  .meta({ id: "LabelFilter" });
export type LabelFilter = z.infer<typeof LabelFilter>;

export const ReadyWorkInput = z
  .object({
    projectId: z.string().trim().min(1).max(200),
    filter: ReadyWorkFilter.optional(),
    labels: LabelFilter.optional(),
  })
  .meta({ id: "ReadyWorkInput" });
export type ReadyWorkInput = z.infer<typeof ReadyWorkInput>;

export const WorkSessionsListInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "WorkSessionsListInput" });
export type WorkSessionsListInput = z.infer<typeof WorkSessionsListInput>;





export const SessionActivityKind = z
  .enum(["thought", "action", "status"])
  .meta({ id: "SessionActivityKind" });
export type SessionActivityKind = z.infer<typeof SessionActivityKind>;




export const ActivityDetailBlockV1 = z
  .discriminatedUnion("type", [
    z.object({
      version: z.literal(1),
      type: z.literal("key_value"),
      items: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
    z.object({
      version: z.literal(1),
      type: z.literal("table"),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
    z.object({
      version: z.literal(1),
      type: z.literal("checklist"),
      items: z.array(z.object({ label: z.string(), checked: z.boolean() })),
    }),
    z.object({
      version: z.literal(1),
      type: z.literal("test_results"),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative().optional(),
      cases: z
        .array(
          z.object({
            name: z.string(),
            status: z.enum(["passed", "failed", "skipped"]),
            message: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ])
  .meta({ id: "ActivityDetailBlockV1" });
export type ActivityDetailBlockV1 = z.infer<typeof ActivityDetailBlockV1>;







export const SessionActivityDetail = z
  .looseObject({ block: ActivityDetailBlockV1.optional() })
  .refine((value) => JSON.stringify(value).length <= 64_000, {
    message: "Activity detail must be at most 64000 characters when serialized.",
  })
  .meta({ id: "SessionActivityDetail" });
export type SessionActivityDetail = z.infer<typeof SessionActivityDetail>;

export const SessionActivity = z
  .object({
    id: z.string(),
    workSessionId: z.string(),
    
    
    runId: z.string(),
    kind: SessionActivityKind,
    summary: z.string(),
    detail: SessionActivityDetail.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "SessionActivity" });
export type SessionActivity = z.infer<typeof SessionActivity>;

export const SessionActivitiesResponse = z
  .array(SessionActivity)
  .meta({ id: "SessionActivitiesResponse" });
export type SessionActivitiesResponse = z.infer<typeof SessionActivitiesResponse>;




export const LogSessionActivityInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    kind: SessionActivityKind,
    summary: z.string().trim().min(1).max(20_000),
    detail: SessionActivityDetail.optional(),
    sessionId: SessionFence.optional(),
  })
  .meta({ id: "LogSessionActivityInput" });
export type LogSessionActivityInput = z.infer<typeof LogSessionActivityInput>;

export const ListSessionActivitiesInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    sessionId: SessionFence,
  })
  .meta({ id: "ListSessionActivitiesInput" });
export type ListSessionActivitiesInput = z.infer<typeof ListSessionActivitiesInput>;


export const LogSessionActivityResponse = z
  .object({ activity: SessionActivity })
  .meta({ id: "LogSessionActivityResponse" });
export type LogSessionActivityResponse = z.infer<typeof LogSessionActivityResponse>;

export const ListSessionActivitiesResponse = z
  .object({ activities: SessionActivitiesResponse })
  .meta({ id: "ListSessionActivitiesResponse" });
export type ListSessionActivitiesResponse = z.infer<typeof ListSessionActivitiesResponse>;
