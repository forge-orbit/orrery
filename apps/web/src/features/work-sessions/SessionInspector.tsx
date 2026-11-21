import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { ActivityDetailBlockV1, type SessionActivityDetail } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState, type ReactNode } from "react";
import { HarnessBadge } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { TelemetryFacts } from "../../lib/telemetry.tsx";
import { formatDateTime, formatFullDateTime } from "../../lib/time.ts";
import { isPendingQuestion, issueQuestionsQuery, QuestionDetails } from "../inbox/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { sessionActivitiesQuery, sessionsQuery } from "./queries.ts";

type BlockType = ActivityDetailBlockV1["type"];
type BlockRenderer = (block: ActivityDetailBlockV1) => ReactNode;

/* eslint-disable react/no-array-index-key -- position disambiguates repeated telemetry values */
const blockRenderers: Record<BlockType, BlockRenderer> = {
  key_value: (block) =>
    block.type === "key_value" ? (
      <Stack as="dl" data-activity-block-kind="key_value" gap={0.5}>
        {block.items.map((item, index) => (
          <Fragment key={`${item.key}-${index}`}>
            <dt>{item.key}</dt>
            <dd>{item.value}</dd>
          </Fragment>
        ))}
      </Stack>
    ) : null,
  table: (block) =>
    block.type === "table" ? (
      <Stack width="100%" maxWidth="100%" isScrollable>
        <Table data-activity-block-kind="table">
          <TableHeader>
            <TableRow>
              {block.columns.map((column, index) => (
                <TableHeaderCell key={`${column}-${index}`}>{column}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row, rowIndex) => (
              <TableRow key={`${row.join("|")}-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={`${cell}-${cellIndex}`}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
    ) : null,
  checklist: (block) =>
    block.type === "checklist" ? (
      <Stack as="ul" data-activity-block-kind="checklist" gap={0.5}>
        {block.items.map((item, index) => (
          <Stack as="li" key={`${item.label}-${index}`} data-checked={String(item.checked)}>
            <Text type="inherit" color="inherit">
              {item.checked ? "✓" : "○"} {item.label}
            </Text>
          </Stack>
        ))}
      </Stack>
    ) : null,
  test_results: (block) =>
    block.type === "test_results" ? (
      <Stack gap={1} data-activity-block-kind="test_results">
        <Stack direction="horizontal" gap={1} wrap="wrap">
          <Badge variant="success" label={`${block.passed} passed`} />
          <Badge
            variant={block.failed > 0 ? "error" : "neutral"}
            label={`${block.failed} failed`}
          />
          {block.skipped !== undefined && (
            <Badge variant="neutral" label={`${block.skipped} skipped`} />
          )}
        </Stack>
        {block.cases !== undefined && block.cases.length > 0 && (
          <Stack as="ul" gap={0.5}>
            {block.cases.map((testCase, index) => (
              <Stack as="li" key={`${testCase.name}-${index}`} data-test-status={testCase.status}>
                <Stack gap={0.5}>
                  <Text type="inherit" color="inherit">
                    {testCase.name} — {testCase.status}
                  </Text>
                  {testCase.message !== undefined && (
                    <Text as="p" display="block" type="supporting" color="secondary">
                      {testCase.message}
                    </Text>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    ) : null,
};
/* eslint-enable react/no-array-index-key */

function JsonFallback({ detail }: { detail: unknown }) {
  return (
    <Stack data-activity-block="json">
      <Collapsible
        defaultIsOpen={false}
        trigger={
          <Text type="body" weight="semibold">
            Raw activity detail (JSON)
          </Text>
        }
      >
        <pre data-activity-detail="">{JSON.stringify(detail, null, 2)}</pre>
      </Collapsible>
    </Stack>
  );
}

function renderDetail(detail: SessionActivityDetail | null): ReactNode {
  const parsed = ActivityDetailBlockV1.safeParse(detail?.block);
  if (parsed.success) {
    const block = parsed.data;
    return <Stack data-activity-block={block.type}>{blockRenderers[block.type](block)}</Stack>;
  }
  return <JsonFallback detail={detail} />;
}

function ShortId({ value, label }: { value: string; label: string }) {
  const toast = useToast();

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      toast({ body: `Copied ${label}.` });
    } catch {
      toast({ body: `Could not copy ${label}.`, type: "error" });
    }
  }

  return (
    <Stack direction="horizontal" gap={1} vAlign="center" wrap="wrap">
      <code title={value}>{value.slice(0, 8)}</code>
      <Button type="button" variant="ghost" size="sm" label="Copy" onClick={() => void onCopy()} />
    </Stack>
  );
}

export function SessionInspector({
  issueId,
  canContribute,
  initialOpen = false,
  initialSessionId,
}: {
  issueId: string;
  canContribute: boolean;
  initialOpen?: boolean | undefined;
  initialSessionId?: string | undefined;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(initialOpen);

  return (
    <Card padding={3} data-session-inspector="" aria-label="Session inspector">
      <Stack direction="horizontal" gap={2} wrap="wrap" justify="start">
        <Heading level={2} color="inherit">
          Session inspector
        </Heading>
        <Button
          label={open ? "Hide session inspector" : "Show session inspector"}
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        />
      </Stack>
      <section id={panelId} hidden={!open}>
        <SessionInspectorDetails
          issueId={issueId}
          canContribute={canContribute}
          open={open}
          initialSessionId={initialSessionId}
        />
      </section>
    </Card>
  );
}

export function SessionInspectorDetails({
  issueId,
  canContribute,
  open,
  initialSessionId,
}: {
  issueId: string;
  canContribute: boolean;
  open: boolean;
  initialSessionId?: string | undefined;
}) {
  const [pickedId, setPickedId] = useState<string | null>(initialSessionId ?? null);

  const sessions = useQuery({ ...sessionsQuery(issueId, open), enabled: open });
  const list = sessions.data ?? [];
  const selected =
    list.find((session) => session.id === pickedId) ??
    list.find((session) => session.status === "active") ??
    list[0];

  const activities = useQuery({
    ...sessionActivitiesQuery(issueId, selected?.id ?? "", open && selected?.status === "active"),
    enabled: open && selected !== undefined,
  });
  const questions = useQuery({ ...issueQuestionsQuery(issueId), enabled: open });
  const runs = useQuery({
    ...workspaceRunsQuery(selected?.workspaceId ?? ""),
    enabled: open && selected !== undefined,
  });
  const run = runs.data?.find((entry) => entry.id === selected?.runId);
  const pendingQuestion = questions.data?.find(
    (question) => isPendingQuestion(question) && question.runId === selected?.runId,
  );
  const displayStatus =
    selected?.stopRequested && selected.status === "active" ? "stopping" : selected?.status;
  const activityList = activities.data ?? [];

  return (
    <Stack paddingBlockStart={2}>
      {sessions.isPending && (
        <Text as="p" display="block" type="supporting" role="status">
          Loading work sessions…
        </Text>
      )}
      {sessions.isError && (
        <Banner status="error" role="alert" title="Could not load work sessions." />
      )}
      {sessions.isSuccess && selected === undefined && (
        <Text as="p" display="block" type="supporting">
          No work sessions recorded for this issue.
        </Text>
      )}
      {selected !== undefined && (
        <>
          <Selector
            label="Work session"
            id={`session-inspector-select-${issueId}`}
            value={selected.id}
            onChange={setPickedId}
            options={list.map((session) => ({
              value: session.id,
              label: `${session.status} · ${formatDateTime(session.createdAt)}`,
            }))}
          />
          <Stack direction="horizontal" gap={1} vAlign="center" wrap="wrap">
            <strong>{run?.agentName ?? "Agent work session"}</strong>
            <Text type="inherit" color="inherit" data-inspector-session-status={displayStatus}>
              {displayStatus}
            </Text>
          </Stack>
          {selected.progress !== "" && (
            <Text as="p" display="block" type="supporting" color="secondary">
              {selected.progress}
            </Text>
          )}
          {pendingQuestion !== undefined && (
            <Card padding={3}>
              <QuestionDetails question={pendingQuestion} />
              {canContribute && (
                <Link to="/inbox" search={{ issue: issueId }} color="accent" hasUnderline>
                  Answer in Inbox
                </Link>
              )}
            </Card>
          )}
          <Stack as="dl" gap={0.5}>
            <dt>Harness</dt>
            <dd>
              <HarnessBadge harness={run?.harness} empty="Unknown" />
            </dd>
            <dt>Model</dt>
            <dd>{run?.model ?? "Unknown"}</dd>
            <dt>Run</dt>
            <dd>
              <ShortId value={selected.runId} label="run ID" />
            </dd>
            <dt>Session</dt>
            <dd>
              <ShortId value={selected.id} label="session ID" />
            </dd>
            <TelemetryFacts
              inputTokens={selected.inputTokens}
              outputTokens={selected.outputTokens}
              costUsdMicros={selected.costUsdMicros}
            />
          </Stack>
          <Heading level={3} color="inherit">
            Session activity
          </Heading>
          {activities.isPending && (
            <Text as="p" display="block" type="supporting" role="status">
              Loading session activity…
            </Text>
          )}
          {activities.isError && (
            <Banner status="error" role="alert" title="Could not load session activity." />
          )}
          {activities.isSuccess && activityList.length === 0 ? (
            <Text as="p" display="block" type="supporting" color="secondary">
              No activities recorded yet.
            </Text>
          ) : (
            <Stack as="ol" data-activity-timeline="">
              {activityList.map((activity) => (
                <Stack
                  as="li"
                  key={activity.id}
                  data-activity-id={activity.id}
                  data-activity-kind={activity.kind}
                >
                  <time
                    dateTime={activity.createdAt}
                    title={formatFullDateTime(activity.createdAt)}
                  >
                    {formatDateTime(activity.createdAt)}
                  </time>
                  <strong>{activity.kind}</strong>
                  <Stack data-activity-summary="">{activity.summary}</Stack>
                  {activity.detail !== null && renderDetail(activity.detail)}
                </Stack>
              ))}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
