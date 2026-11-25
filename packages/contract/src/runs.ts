import { z } from "zod";
import { Timestamp } from "./common.ts";










export const RunEventType = z
  .enum(["run_started", "run_heartbeat", "run_ended", "child_started", "child_ended"])
  .meta({ id: "RunEventType" });
export type RunEventType = z.infer<typeof RunEventType>;

export const RunStatus = z.enum(["active", "ended"]).meta({ id: "RunStatus" });
export type RunStatus = z.infer<typeof RunStatus>;

/** Why a run ended: an explicit `run_ended`, or a stale heartbeat with no live work session. */
export const RunEndReason = z.enum(["reported", "stale"]).meta({ id: "RunEndReason" });
export type RunEndReason = z.infer<typeof RunEndReason>;




export const RunKey = z
  .object({
    harness: z.string().trim().min(1).max(120),
    nativeSessionId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "RunKey" });
export type RunKey = z.infer<typeof RunKey>;




export const RunChildRef = z
  .object({
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    agentType: z.string().trim().min(1).max(200).nullable().optional(),
    runId: z.string().trim().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "RunChildRef" });
export type RunChildRef = z.infer<typeof RunChildRef>;




export const RunReportInput = z
  .object({
    event: RunEventType.default("run_heartbeat"),
    
    
    
    runKey: RunKey.nullable().optional(),
    runId: z.string().trim().min(1).max(200).nullable().optional(),
    
    
    model: z.string().trim().min(1).max(200).nullable().optional(),
    harnessVersion: z.string().trim().min(1).max(200).nullable().optional(),
    reported: z
      .object({
        model: z.string().trim().min(1).max(200).nullable().optional(),
        harnessVersion: z.string().trim().min(1).max(200).nullable().optional(),
      })
      .optional(),
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    agentType: z.string().trim().min(1).max(200).nullable().optional(),
    child: RunChildRef.optional(),
    checkIn: z
      .object({ sequence: z.number().int().min(0), at: Timestamp.optional() })
      .optional(),
    at: Timestamp.optional(),
  })
  .meta({ id: "RunReportInput" });
export type RunReportInput = z.infer<typeof RunReportInput>;



export const RunHookEvent = RunReportInput.extend({
  schema: z.literal("orrery.run.hook.v1"),
  runKey: RunKey,
}).meta({ id: "RunHookEvent" });
export type RunHookEvent = z.infer<typeof RunHookEvent>;




export const RunReportResponse = z
  .object({
    runId: z.string().nullable(),
    accepted: z.boolean(),
    observedAt: Timestamp,
    model: z.string().nullable(),
    harness: z.string().nullable(),
  })
  .meta({ id: "RunReportResponse" });
export type RunReportResponse = z.infer<typeof RunReportResponse>;

export const Run = z
  .object({
    id: z.string(),
    agentId: z.string(),
    workspaceId: z.string(),
    harness: z.string().nullable(),
    harnessVersion: z.string().nullable(),
    nativeSessionId: z.string().nullable(),
    model: z.string().nullable(),
    status: RunStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    endedReason: RunEndReason.nullable(),
    lastHeartbeatAt: Timestamp.nullable(),
  })
  .meta({ id: "Run" });
export type Run = z.infer<typeof Run>;




export const RunModelChange = z
  .object({
    id: z.string(),
    runId: z.string(),
    fromModel: z.string().nullable(),
    toModel: z.string(),
    reportedAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: "RunModelChange" });
export type RunModelChange = z.infer<typeof RunModelChange>;



export const RunChild = z
  .object({
    id: z.string(),
    runId: z.string(),
    agentId: z.string().nullable(),
    agentType: z.string().nullable(),
    childRunId: z.string().nullable(),
    model: z.string().nullable(),
    status: RunStatus,
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: "RunChild" });
export type RunChild = z.infer<typeof RunChild>;



export const RunDetail = Run.extend({
  agentName: z.string(),
  modelHistory: z.array(RunModelChange),
  children: z.array(RunChild),
}).meta({ id: "RunDetail" });
export type RunDetail = z.infer<typeof RunDetail>;

export const RunsResponse = z.object({ runs: z.array(RunDetail) }).meta({ id: "RunsResponse" });
export type RunsResponse = z.infer<typeof RunsResponse>;
