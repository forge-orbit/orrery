import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import {
  type MyWorkActiveSession,
  type MyWorkAssignedIssue,
  type MyWorkQuestion,
  type MyWorkResponse,
} from "@orrery/contract";
import { type ReactNode, useRef } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { formatFullDateTime, relativeCountdown } from "../../lib/time.ts";
import { issueStatusLabels, PriorityBadge } from "../projects/index.ts";

const number = new Intl.NumberFormat();

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

export function MyWorkSections({ work }: { work: MyWorkResponse }) {
  return (
    <Stack gap={5}>
      <MyWorkSection
        title="Assigned to me"
        section="assigned-issues"
        count={work.assignedIssues.length}
      >
        {work.assignedIssues.length === 0 ? (
          <EmptyState
            title="Nothing assigned to you"
            description="Open issues assigned to you appear here across all your workspaces."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers aria-label="Assigned to me">
            {work.assignedIssues.map((issue) => (
              <AssignedIssueRow key={issue.id} issue={issue} />
            ))}
          </List>
        )}
      </MyWorkSection>

      <MyWorkSection
        title="My active agent sessions"
        section="active-sessions"
        count={work.activeAgentSessions.length}
        hasTopDivider
      >
        {work.activeAgentSessions.length === 0 ? (
          <EmptyState
            title="No active agent sessions"
            description="Live sessions running under your agents appear here as soon as they claim an issue."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers aria-label="My active agent sessions">
            {work.activeAgentSessions.map((session) => (
              <ActiveSessionRow key={session.sessionId} session={session} />
            ))}
          </List>
        )}
      </MyWorkSection>

      <MyWorkSection
        title="Needs input"
        section="needs-input"
        count={work.needsInputQuestions.length}
        hasTopDivider
      >
        {work.needsInputQuestions.length === 0 ? (
          <EmptyState
            title="No questions need your input"
            description="Open or paused questions on your projects appear here with a link to answer them."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers aria-label="Questions needing input">
            {work.needsInputQuestions.map((question) => (
              <QuestionRow key={question.id} question={question} />
            ))}
          </List>
        )}
      </MyWorkSection>
    </Stack>
  );
}

function MyWorkSection({
  title,
  section,
  count,
  hasTopDivider = false,
  children,
}: {
  title: string;
  section: string;
  count: number;
  hasTopDivider?: boolean;
  children: ReactNode;
}) {
  return (
    <Section
      data-my-work-section={section}
      variant="transparent"
      {...(hasTopDivider ? { dividers: ["top" as const] } : {})}
      padding={0}
      paddingBlockStart={hasTopDivider ? 5 : 0}
    >
      <Stack gap={3}>
        <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
          <Heading level={2} color="inherit">
            {title}
          </Heading>
          <Badge label={count} />
        </Stack>
        {children}
      </Stack>
    </Section>
  );
}

function AssignedIssueRow({ issue }: { issue: MyWorkAssignedIssue }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  return (
    <ListItem
      data-my-work-issue-id={issue.id}
      itemKey={issue.id}
      interactiveRef={linkRef}
      label={
        <Link ref={linkRef} to="/issues/$issueId" params={{ issueId: issue.id }}>
          <Stack as="span" direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
            <Text as="span" type="code" color="inherit">
              {issue.identifier}
            </Text>{" "}
            <Text as="span" type="body" weight="semibold" color="primary">
              {issue.title}
            </Text>
          </Stack>
        </Link>
      }
      description={
        <Stack as="span" direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
          <Text as="span" type="supporting" color="secondary">
            {issue.workspaceName} · {issue.projectName} · {issueStatusLabels[issue.status]}
          </Text>
          {issue.needsInput && <Token label="Needs input" color="orange" size="sm" />}
        </Stack>
      }
      endContent={<PriorityBadge priority={issue.priority} />}
    />
  );
}

function ActiveSessionRow({ session }: { session: MyWorkActiveSession }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const telemetry = [
    session.inputTokens === null ? undefined : `${number.format(session.inputTokens)} input tokens`,
    session.outputTokens === null
      ? undefined
      : `${number.format(session.outputTokens)} output tokens`,
    session.costUsdMicros === null
      ? undefined
      : `${currency.format(session.costUsdMicros / 1_000_000)} cost`,
  ].filter((part) => part !== undefined);

  return (
    <ListItem
      data-my-work-session-id={session.sessionId}
      itemKey={session.sessionId}
      interactiveRef={linkRef}
      label={
        <Link
          ref={linkRef}
          to="/issues/$issueId"
          params={{ issueId: session.issueId }}
          search={{ inspector: true, session: session.sessionId }}
        >
          <Stack as="span" direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
            <Text as="span" type="code" color="inherit">
              {session.issueIdentifier}
            </Text>{" "}
            <Text as="span" type="body" weight="semibold" color="primary">
              {session.issueTitle}
            </Text>
          </Stack>
        </Link>
      }
      description={
        <Stack as="span" gap={0.5}>
          <Stack as="span" direction="horizontal" gap={1} vAlign="center" wrap="wrap">
            <Text as="span" type="supporting" color="secondary">
              {session.workspaceName} · {session.projectName} · {session.agentName} · Harness{" "}
            </Text>
            <Text as="span" type="supporting" color="secondary">
              <HarnessBadge harness={session.harness} empty="unknown" />
            </Text>
            <Text as="span" type="supporting" color="secondary">
              {" "}
              · Model {session.model ?? "unknown"}
              {telemetry.length > 0 ? ` · ${telemetry.join(" · ")}` : ""}
            </Text>
          </Stack>
          {session.progress !== "" && (
            <Text as="span" type="supporting" color="secondary">
              {session.progress}
            </Text>
          )}
        </Stack>
      }
      endContent={
        session.stopRequestedAt === null ? undefined : (
          <Token label="Stop requested" color="orange" size="sm" data-session-status="stopping" />
        )
      }
    />
  );
}

function QuestionRow({ question }: { question: MyWorkQuestion }) {
  return (
    <ListItem
      data-my-work-question-id={question.id}
      itemKey={question.id}
      label={
        <Stack as="span" direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
          <Token
            label={question.status === "paused" ? "Paused" : "Needs input"}
            color="orange"
            size="sm"
          />{" "}
          <Text as="span" type="body" weight="semibold" color="primary">
            {question.question}
          </Text>
        </Stack>
      }
      description={
        <Text as="span" type="supporting" color="secondary">
          {question.workspaceName} · {question.projectName} · {question.issueIdentifier}{" "}
          {question.issueTitle} · {question.agentName} · Due{" "}
          <time
            dateTime={question.responseDeadlineAt}
            title={formatFullDateTime(question.responseDeadlineAt)}
          >
            {relativeCountdown(question.responseDeadlineAt)}
          </time>
        </Text>
      }
      endContent={
        <Link to="/inbox" search={{ issue: question.issueId }} color="accent" hasUnderline>
          Answer in Inbox
        </Link>
      }
    />
  );
}

export function MyWorkErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const problem = error instanceof ApiProblemError ? error.problem : undefined;

  return (
    <Stack gap={5} data-my-work-error="">
      <Heading level={1} color="inherit">
        My work
      </Heading>
      <Banner
        container="section"
        status="error"
        role="alert"
        title={problem?.title ?? "Could not load My work"}
        description={
          problem === undefined
            ? "Check your connection and try again."
            : (problem.errors?.[0]?.detail ?? problem.detail)
        }
        collapsible={false}
        endContent={
          onRetry === undefined ? undefined : (
            <Button type="button" size="sm" variant="secondary" label="Retry" onClick={onRetry} />
          )
        }
      />
    </Stack>
  );
}
