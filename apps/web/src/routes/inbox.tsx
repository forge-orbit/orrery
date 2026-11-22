import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { Question } from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  answerQuestion,
  inboxQuery,
  isPendingQuestion,
  issueQuestionsQuery,
  QuestionDetails,
} from "../features/inbox/index.ts";
import {
  IssueMentionTextArea,
  issueQuery,
  issuesQuery,
  projectQuery,
} from "../features/projects/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import { ApiProblemError } from "../lib/api.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/inbox")({
  validateSearch: (search: Record<string, unknown>): { issue?: string } =>
    typeof search.issue === "string" ? { issue: search.issue } : {},
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(inboxQuery);
  },
  component: InboxPage,
  errorComponent: () => (
    <Stack gap={5}>
      <PageHeader title="Inbox" />
      <Banner
        container="section"
        status="error"
        role="alert"
        title="Could not load the inbox"
        description="Check your connection and try reloading."
      />
    </Stack>
  ),
});

function InboxPage() {
  const { issue } = Route.useSearch();
  const { data: questions } = useSuspenseQuery({ ...inboxQuery, refetchInterval: 4000 });
  const visible =
    issue === undefined ? questions : questions.filter((question) => question.issueId === issue);
  const open = visible.filter(isPendingQuestion);
  const resolved = visible.filter((question) => !isPendingQuestion(question));

  return (
    <Stack gap={5} maxWidth="64rem">
      <PageHeader
        title="Inbox"
        badge={open.length > 0 ? `${open.length} pending` : undefined}
        subtitle="Questions from agents waiting for your direction."
      />
      {issue !== undefined && (
        <Banner
          status="info"
          title="Filtered to one issue"
          description="Showing questions associated with the selected issue."
          endContent={
            <Link to="/inbox" search={{}} color="accent" hasUnderline>
              Show all
            </Link>
          }
        />
      )}
      <QuestionList
        title="Needs an answer"
        questions={open}
        emptyTitle="No questions need an answer"
        emptyDescription="When an agent asks for input on one of your projects, it appears here."
      />
      <QuestionList
        title="Resolved"
        questions={resolved}
        emptyTitle="No resolved questions"
        emptyDescription="Answered questions and fallback outcomes appear here for reference."
      />
    </Stack>
  );
}

function QuestionList({
  title,
  questions,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  questions: Question[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <Section variant="transparent" padding={0}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
          <Heading level={2} color="inherit">
            {title}
          </Heading>
          <Badge label={questions.length} />
        </Stack>
        {questions.length === 0 ? (
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            isCompact
            headingLevel={3}
          />
        ) : (
          <Stack as="ul" gap={3}>
            {questions.map((question) => (
              <QuestionCard key={question.id} question={question} />
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}

function QuestionCard({ question }: { question: Question }) {
  const { data: issue } = useQuery(issueQuery(question.issueId));
  const { data: project } = useQuery(projectQuery(question.projectId));
  const { data: runs = [] } = useQuery(workspaceRunsQuery(question.workspaceId));
  const run = runs.find((entry) => entry.id === question.runId);
  const pending = isPendingQuestion(question);

  return (
    <Stack as="li" data-question-id={question.id}>
      <Card data-pending={pending ? "true" : "false"} padding={4}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} justify="between" align="center" wrap="wrap">
            <Link
              to="/issues/$issueId"
              params={{ issueId: question.issueId }}
              search={{ inspector: true }}
              weight="semibold"
              color="primary"
            >
              <Stack as="span" direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                {project !== undefined && issue !== undefined && (
                  <Text as="span" type="code" color="secondary">
                    {project.key}-{issue.number}
                  </Text>
                )}
                <Text as="span" type="body" weight="semibold" color="primary">
                  {issue?.title ?? "View issue"}
                </Text>
              </Stack>
            </Link>
            {run !== undefined && (
              <Text type="supporting" color="secondary">
                Asked by {run.agentName}
              </Text>
            )}
          </Stack>
          <QuestionDetails question={question} />
          {pending && project !== undefined && project.accessLevel !== "read" && (
            <>
              <Divider />
              <AnswerForm question={question} />
            </>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

function AnswerForm({ question }: { question: Question }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: projectIssues = [] } = useQuery(issuesQuery(question.projectId));
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const resolved = await answerQuestion(question.id, answer);
      queryClient.setQueryData(inboxQuery.queryKey, (current: Question[] | undefined) =>
        current?.map((item) => (item.id === resolved.id ? resolved : item)),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuestionsQuery(question.issueId).queryKey }),
      ]);
      setAnswer("");
      toast({ body: "Answer sent." });
    } catch (cause) {
      setError(
        cause instanceof ApiProblemError
          ? cause.message
          : "Could not submit the answer. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} aria-label="Answer agent question">
      <Stack gap={3}>
        <IssueMentionTextArea
          label="Answer"
          id={`answer-${question.id}`}
          htmlName="answer"
          value={answer}
          onChange={setAnswer}
          rows={3}
          required
          issues={projectIssues}
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack hAlign="start">
          <Button type="submit" variant="primary" label="Answer question" isLoading={submitting} />
        </Stack>
      </Stack>
    </form>
  );
}
