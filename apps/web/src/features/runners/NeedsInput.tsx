import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useToast } from "@astryxdesign/core/Toast";
import type { Question } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TextAreaField } from "../../lib/fields.tsx";
import { answerQuestion, inboxQuery, issueQuestionsQuery } from "../inbox/index.ts";
import { createDispatch } from "./commands.ts";
import { issueDispatchesQueryKey, studioNowQuery } from "./queries.ts";
import { formatCountdown } from "./stream.ts";

/**
 * Leaf clock: only this component re-renders on each tick, so the surrounding
 * Studio (and its stream cards) is untouched by the one-second countdown.
 */
export function NeedsInputCountdown({
  responseDeadlineAt,
  active,
}: {
  responseDeadlineAt: string;
  active: boolean;
}) {
  const { data: now } = useQuery({ ...studioNowQuery(), enabled: active });
  if (!active || now === undefined) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(responseDeadlineAt) - now) / 1000));
  return (
    <Token
      label={`Due in ${formatCountdown(seconds)}`}
      size="sm"
      color="orange"
      data-needs-input-deadline=""
    />
  );
}

/** Inline composer for an open question on the issue being supervised. */
export function NeedsInputComposer({ question, issueId }: { question: Question; issueId: string }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<"answer" | "fallback" | undefined>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const submit = useMutation({
    mutationFn: (text: string) => answerQuestion(question.id, text.trim()),
    onSuccess: async () => {
      setAnswer("");
      setError(undefined);
      setPendingAction(undefined);
      toast({ body: "Answer sent to the agent." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuestionsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not send the answer.");
      setPendingAction(undefined);
    },
  });

  function answerWith(text: string, action: "answer" | "fallback"): void {
    if (text.trim() === "") return;
    setError(undefined);
    setPendingAction(action);
    submit.mutate(text);
  }

  return (
    <Card padding={3} variant="orange" data-needs-input-card="" data-question-id={question.id}>
      <Stack gap={2}>
        <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center" justify="between">
          <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
            <Heading level={3} color="inherit">
              Needs Input
            </Heading>
            <Token label="Question open" size="sm" color="orange" data-needs-input-status="" />
            <NeedsInputCountdown
              responseDeadlineAt={question.responseDeadlineAt}
              active={question.status === "open"}
            />
          </Stack>
          <Text type="supporting" color="secondary">
            {question.projectKey}-{question.issueNumber}
          </Text>
        </Stack>
        <Text as="p" display="block" type="body" weight="semibold" data-needs-input-question="">
          {question.question}
        </Text>
        {question.proposedFallback !== "" && (
          <Stack gap={0.5}>
            <Text type="supporting" weight="semibold" color="secondary">
              Proposed fallback
            </Text>
            <Text as="p" display="block" type="body" data-needs-input-fallback="">
              {question.proposedFallback}
            </Text>
          </Stack>
        )}
        {question.canAnswer ? (
          <Stack gap={2}>
            <TextAreaField
              label="Your answer"
              id={`needs-input-answer-${question.id}`}
              htmlName="answer"
              value={answer}
              onChange={setAnswer}
              rows={3}
              maxLength={20_000}
              placeholder="Tell the agent what to do next"
              data-needs-input-answer=""
              width="100%"
            />
            {error !== undefined && (
              <Banner
                status="error"
                role="alert"
                title="Answer not sent"
                description={error}
                collapsible={false}
              />
            )}
            <Stack direction="horizontal" gap={2} wrap="wrap">
              <Button
                type="button"
                variant="primary"
                size="sm"
                label="Submit answer"
                isDisabled={submit.isPending || answer.trim() === ""}
                isLoading={submit.isPending && pendingAction === "answer"}
                data-needs-input-submit=""
                onClick={() => answerWith(answer, "answer")}
              />
              {question.proposedFallback !== "" && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  label="Use proposed fallback"
                  isDisabled={submit.isPending}
                  isLoading={submit.isPending && pendingAction === "fallback"}
                  data-needs-input-fallback-submit=""
                  onClick={() => answerWith(question.proposedFallback, "fallback")}
                />
              )}
            </Stack>
          </Stack>
        ) : (
          <Text type="supporting" color="secondary">
            You need Contribute access to answer this question.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/**
 * A require_human deadline paused the work session and released its claim.
 * Answering the question first clears `issues.needsInput`; only then can a new
 * Dispatch be created — creating one while Needs input is set is a 409.
 */
export function PausedNeedsInput({
  question,
  issueId,
  runnerId,
  workspaceId,
  isOwner,
}: {
  question: Question;
  issueId: string;
  runnerId: string;
  workspaceId: string;
  isOwner?: boolean | undefined;
}) {
  const [confirm, setConfirm] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate({ from: "/live/$runnerId/$dispatchId" });
  const canRedispatch = question.canAnswer && isOwner !== false;
  const redispatch = useMutation({
    mutationFn: async () => {
      // The paused question keeps the issue in Needs input, so a dispatch
      // created before this answer would be rejected with 409 issue_not_claimable.
      // Track answeredQuestionId so retrying after a failed createDispatch does
      // not re-post the already-answered question (which would 409).
      if (answeredQuestionId !== question.id) {
        await answerQuestion(question.id, answer.trim());
        setAnsweredQuestionId(question.id);
      }
      return createDispatch(issueId, { runnerId });
    },
    onSuccess: async (dispatch) => {
      setConfirm(false);
      setError(undefined);
      toast({ body: "Question answered and a new dispatch was created." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueDispatchesQueryKey(issueId) }),
        queryClient.invalidateQueries({ queryKey: issueQuestionsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey }),
      ]);
      void navigate({
        to: "/live/$runnerId/$dispatchId",
        params: { runnerId: dispatch.runnerId, dispatchId: dispatch.id },
        search: { issueId, ...(workspaceId === "" ? {} : { workspaceId }) },
      });
    },
    onError: async (cause: unknown) => {
      setConfirm(false);
      setError(cause instanceof Error ? cause.message : "Could not re-dispatch this issue.");
      await queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
    },
  });

  return (
    <Card padding={3} variant="orange" data-needs-input-paused="" data-question-id={question.id}>
      <Stack gap={2}>
        <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
          <Heading level={3} color="inherit">
            Needs Input · Paused
          </Heading>
          <Token
            label="Deadline passed"
            size="sm"
            color="orange"
            data-needs-input-status="paused"
          />
        </Stack>
        <Text as="p" display="block" type="body" data-needs-input-question="">
          {question.question}
        </Text>
        {question.proposedFallback !== "" && (
          <Stack gap={0.5}>
            <Text type="supporting" weight="semibold" color="secondary">
              Proposed fallback (not authorized)
            </Text>
            <Text as="p" display="block" type="body" data-needs-input-fallback="">
              {question.proposedFallback}
            </Text>
          </Stack>
        )}
        <Text type="supporting" color="secondary">
          The one-hour deadline passed without an answer. The work session claim was released and
          the Runner preserved its local worktree. Answer the question and explicitly confirm a
          fresh dispatch to resume work.
        </Text>
        {error !== undefined && (
          <Banner
            status="error"
            role="alert"
            title="Re-dispatch failed"
            description={error}
            collapsible={false}
          />
        )}
        {canRedispatch ? (
          <Stack gap={2}>
            <TextAreaField
              label="Your answer"
              id={`needs-input-paused-answer-${question.id}`}
              htmlName="answer"
              value={answer}
              onChange={setAnswer}
              rows={3}
              maxLength={20_000}
              placeholder="Tell the new agent how to proceed"
              data-needs-input-paused-answer=""
              width="100%"
            />
            {question.proposedFallback !== "" && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                label="Use proposed fallback"
                isDisabled={redispatch.isPending}
                data-needs-input-paused-fallback=""
                onClick={() => setAnswer(question.proposedFallback)}
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="primary"
              label="Re-dispatch"
              isDisabled={redispatch.isPending || answer.trim() === ""}
              isLoading={redispatch.isPending}
              data-needs-input-redispatch=""
              onClick={() => setConfirm(true)}
            />
          </Stack>
        ) : (
          <Text type="supporting" color="secondary" data-needs-input-readonly="">
            You need Contribute access and Runner host ownership to answer and re-dispatch this
            issue.
          </Text>
        )}
        <AlertDialog
          isOpen={confirm}
          onOpenChange={setConfirm}
          title="Re-dispatch this issue?"
          description="Your answer clears Needs input, then a new Runner session starts on this issue. The parked agent is not resumed; its worktree is preserved on the Runner host."
          actionLabel="Re-dispatch"
          actionVariant="primary"
          isActionLoading={redispatch.isPending}
          data-needs-input-redispatch-confirm=""
          onAction={() => redispatch.mutate()}
        />
      </Stack>
    </Card>
  );
}
