import { randomUUID } from "node:crypto";
import type {
  CancelCommandPayload,
  InputResolvedCommandPayload,
  RunnerCommandKind,
  RunnerCommandPayload,
} from "@orrery/contract";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { runnerCommands, runnerDispatches, runners } from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";

/** Commands expire in database time; a disconnected runner never sees a stale one. */
export const RUNNER_COMMAND_TTL_SECONDS = 60 * 60;

/** Only the fields needed to bind a command to its Dispatch attempt. */
export type DispatchSeed = {
  id: string;
  dispatchAttemptId: string;
};

export type IssueCommandInput =
  | { issueId: string; kind: "cancel"; reason: string }
  | {
      issueId: string;
      kind: "input_resolved";
      questionId: string;
      resolution: "answered" | "fallback_used";
      answer: string | null;
    };

export type EnqueueRunnerCommandInput = {
  runnerId: string;
  dispatch: DispatchSeed;
  kind: RunnerCommandKind;
  payload: RunnerCommandPayload;
  ttlSeconds?: number | undefined;
};

export type SeqAllocator = { next: (runnerId: string) => number };

/**
 * Global lock order (issues -> runners -> runner_dispatches): every outbox
 * writer locks the affected dispatch rows in ascending id order after the
 * runner rows are held, so `acceptDispatch` and cancel cascades cannot AB-BA.
 */
export async function lockDispatchRows(tx: DbTransaction, dispatchIds: readonly string[]) {
  const ordered = [...new Set(dispatchIds)].toSorted();
  if (ordered.length === 0) return;
  await tx
    .select({ id: runnerDispatches.id })
    .from(runnerDispatches)
    .where(inArray(runnerDispatches.id, ordered))
    .orderBy(asc(runnerDispatches.id))
    .for("update");
}

/**
 * Lock every target runner row once, ascending by id (the global lock order),
 * then derive each runner's next command sequence under that lock. Concurrent
 * writers for the same runner therefore cannot collide on (runner_id, seq).
 */
export async function allocateCommandSeqs(
  tx: DbTransaction,
  runnerIds: readonly string[],
): Promise<SeqAllocator> {
  const ordered = [...new Set(runnerIds)].toSorted();
  const next = new Map<string, number>(ordered.map((id) => [id, 1]));
  if (ordered.length === 0) return { next: (runnerId) => next.get(runnerId) ?? 1 };

  await tx
    .select({ id: runners.id })
    .from(runners)
    .where(inArray(runners.id, ordered))
    .orderBy(asc(runners.id))
    .for("update");
  const rows = await tx
    .select({
      runnerId: runnerCommands.runnerId,
      maxSeq: sql<number | null>`max(${runnerCommands.seq})`,
    })
    .from(runnerCommands)
    .where(inArray(runnerCommands.runnerId, ordered))
    .groupBy(runnerCommands.runnerId);
  for (const row of rows) next.set(row.runnerId, (row.maxSeq ?? 0) + 1);
  return {
    next: (runnerId) => {
      const value = next.get(runnerId) ?? 1;
      next.set(runnerId, value + 1);
      return value;
    },
  };
}

/** Insert one command, advance the dispatch's down cursor, and ring the doorbell. */
export async function insertRunnerCommand(
  tx: DbTransaction,
  input: EnqueueRunnerCommandInput & { seq: number; dispatchLocked?: boolean },
) {
  if (input.dispatchLocked !== true) await lockDispatchRows(tx, [input.dispatch.id]);
  const ttl = input.ttlSeconds ?? RUNNER_COMMAND_TTL_SECONDS;
  const [row] = await tx
    .insert(runnerCommands)
    .values({
      id: randomUUID(),
      runnerId: input.runnerId,
      dispatchId: input.dispatch.id,
      dispatchAttemptId: input.dispatch.dispatchAttemptId,
      seq: input.seq,
      kind: input.kind,
      payload: input.payload,
      createdAt: sql`statement_timestamp()`,
      expiresAt: sql`statement_timestamp() + make_interval(secs => ${ttl})`,
    })
    .returning();
  await tx
    .update(runnerDispatches)
    .set({ lastDownSeq: sql`greatest(${runnerDispatches.lastDownSeq}, ${input.seq})` })
    .where(eq(runnerDispatches.id, input.dispatch.id));
  // ID-only doorbell: JSON payloads stay in the durable outbox, well below the
  // 8 KB pg_notify limit. NOTIFY is delivered on COMMIT with this transaction.
  await tx.execute(sql`select pg_notify('runner_commands', ${input.runnerId})`);
  return row;
}

export async function enqueueRunnerCommand(tx: DbTransaction, input: EnqueueRunnerCommandInput) {
  const seqs = await allocateCommandSeqs(tx, [input.runnerId]);
  return insertRunnerCommand(tx, { ...input, seq: seqs.next(input.runnerId) });
}

const activeStates = ["pending", "active", "uncertain"] as const;

/**
 * Enqueue a cancel for every active or pending dispatch on the given runners,
 * and settle those dispatches, inside the caller's transaction.
 */
export async function cancelDispatchesForRunners(
  tx: DbTransaction,
  runnerIds: readonly string[],
  reason: string,
): Promise<number> {
  if (runnerIds.length === 0) return 0;
  const dispatches = await tx
    .select({
      id: runnerDispatches.id,
      runnerId: runnerDispatches.runnerId,
      dispatchAttemptId: runnerDispatches.dispatchAttemptId,
      issueId: runnerDispatches.issueId,
    })
    .from(runnerDispatches)
    .where(
      and(
        inArray(runnerDispatches.runnerId, [...runnerIds]),
        inArray(runnerDispatches.state, [...activeStates]),
      ),
    )
    .orderBy(asc(runnerDispatches.id));
  if (dispatches.length === 0) return 0;

  // runners (ascending) are locked by allocateCommandSeqs; now lock every
  // affected dispatch row in one ascending pass before any command is written.
  const seqs = await allocateCommandSeqs(
    tx,
    dispatches.map((row) => row.runnerId),
  );
  await lockDispatchRows(
    tx,
    dispatches.map((row) => row.id),
  );
  for (const row of dispatches) {
    const payload: CancelCommandPayload = {
      dispatchId: row.id,
      dispatchAttemptId: row.dispatchAttemptId,
      issueId: row.issueId,
      reason,
    };
    await insertRunnerCommand(tx, {
      runnerId: row.runnerId,
      dispatch: { id: row.id, dispatchAttemptId: row.dispatchAttemptId },
      seq: seqs.next(row.runnerId),
      kind: "cancel",
      payload,
      dispatchLocked: true,
    });
  }
  await tx
    .update(runnerDispatches)
    .set({ state: "ended", endedAt: sql`statement_timestamp()` })
    .where(
      inArray(
        runnerDispatches.id,
        dispatches.map((row) => row.id),
      ),
    );
  return dispatches.length;
}

/**
 * Seam used by work-sessions and inbox: resolve a command for the issue's live
 * dispatch inside the very transaction that records the domain decision.
 */
export async function enqueueCommandForIssue(tx: DbTransaction, input: IssueCommandInput) {
  const [dispatch] = await tx
    .select({
      id: runnerDispatches.id,
      runnerId: runnerDispatches.runnerId,
      dispatchAttemptId: runnerDispatches.dispatchAttemptId,
      issueId: runnerDispatches.issueId,
    })
    .from(runnerDispatches)
    .where(
      and(
        eq(runnerDispatches.issueId, input.issueId),
        inArray(runnerDispatches.state, [...activeStates]),
      ),
    )
    .orderBy(desc(runnerDispatches.createdAt))
    .limit(1);
  if (dispatch === undefined) return;

  if (input.kind === "cancel") {
    // A repeated Stop request must not produce a second unacknowledged cancel.
    const [pendingCancel] = await tx
      .select({ id: runnerCommands.id })
      .from(runnerCommands)
      .where(
        and(
          eq(runnerCommands.dispatchAttemptId, dispatch.dispatchAttemptId),
          eq(runnerCommands.kind, "cancel"),
          isNull(runnerCommands.ackedAt),
          gt(runnerCommands.expiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (pendingCancel !== undefined) return;
    const payload: CancelCommandPayload = {
      dispatchId: dispatch.id,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      issueId: dispatch.issueId,
      reason: input.reason,
    };
    await enqueueRunnerCommand(tx, {
      runnerId: dispatch.runnerId,
      dispatch: { id: dispatch.id, dispatchAttemptId: dispatch.dispatchAttemptId },
      kind: "cancel",
      payload,
    });
    return;
  }

  const payload: InputResolvedCommandPayload = {
    dispatchId: dispatch.id,
    dispatchAttemptId: dispatch.dispatchAttemptId,
    issueId: dispatch.issueId,
    questionId: input.questionId,
    resolution: input.resolution,
    answer: input.answer ?? "",
  };
  await enqueueRunnerCommand(tx, {
    runnerId: dispatch.runnerId,
    dispatch: { id: dispatch.id, dispatchAttemptId: dispatch.dispatchAttemptId },
    kind: "input_resolved",
    payload,
  });
}
