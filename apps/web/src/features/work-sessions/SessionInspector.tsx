import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Section } from "@astryxdesign/core/Section";
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
import { Token } from "@astryxdesign/core/Token";
import { ActivityDetailBlockV1, type SessionActivityDetail } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { AgentAvatar, HarnessBadge } from "../../lib/harness.tsx";
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
      <Stack data-activity-block-kind="key_value">
        <MetadataList>
          {block.items.map((item, index) => (
            <MetadataListItem key={`${item.key}-${index}`} label={item.key}>
              {item.value}
            </MetadataListItem>
          ))}
        </MetadataList>
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
        <Stack paddingBlockStart={1} data-activity-detail="">
          <CodeBlock
            code={JSON.stringify(detail, null, 2)}
            language="json"
            hasLanguageLabel={false}
            size="sm"
            width="100%"
            maxHeight={260}
          />
        </Stack>
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
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        label={`Copy ${label}`}
        tooltip={`Copy ${label}`}
        icon={<Icon icon={Copy} />}
        onClick={() => void onCopy()}
      />
    </Stack>
  );
}

export function SessionInspector({
  issueId,
  canContribute,
  initialOpen = false,
  initialSessionId,
  compact = false,
  liveStudioLink,
}: {
  issueId: string;
  canContribute: boolean;
  initialOpen?: boolean | undefined;
  initialSessionId?: string | undefined;
  /** Summary-only rendering for narrow surfaces such as the Board drawer. */
  compact?: boolean | undefined;
  liveStudioLink?: ReactNode | undefined;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(initialOpen);

  return (
    <Stack gap={2} data-session-inspector="" aria-label="Session inspector">
      <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" vAlign="center">
        <Heading level={2} color="inherit">
          Session inspector
        </Heading>
        <Button
          label={open ? "Hide session inspector" : "Show session inspector"}
          variant={open ? "ghost" : "secondary"}
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
          compact={compact}
          liveStudioLink={liveStudioLink}
        />
      </section>
    </Stack>
  );
}

export function SessionInspectorDetails({
  issueId,
  canContribute,
  open,
  initialSessionId,
  compact = false,
  liveStudioLink,
}: {
  issueId: string;
  canContribute: boolean;
  open: boolean;
  initialSessionId?: string | undefined;
  compact?: boolean | undefined;
  liveStudioLink?: ReactNode | undefined;
}) {
  const [pickedId, setPickedId] = useState<string | null>(initialSessionId ?? null);

  const sessions = useQuery({ ...sessionsQuery(issueId, open), enabled: open });
  const list = sessions.data ?? [];
  const selected =
    list.find((session) => session.id === pickedId) ??
    list.find((session) => session.status === "active") ??
    list[0];

  const activities = useQuery({
    ...sessionActivitiesQuery(
      issueId,
      selected?.id ?? "",
      open && !compact && selected?.status === "active",
    ),
    enabled: open && !compact && selected !== undefined,
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
    <Stack gap={3} paddingBlockStart={2}>
      {sessions.isPending && (
        <Text as="p" display="block" type="supporting" role="status">
          Loading work sessions…
        </Text>
      )}
      {sessions.isError && (
        <Banner status="error" role="alert" title="Could not load work sessions." />
      )}
      {sessions.isSuccess && selected === undefined && (
        <Stack gap={2}>
          <Text as="p" display="block" type="supporting" color="secondary">
            No work sessions recorded for this issue.
          </Text>
          {liveStudioLink}
        </Stack>
      )}
      {selected !== undefined && (
        <>
          <Selector
            label="Work session"
            id={`session-inspector-select-${issueId}`}
            size="sm"
            value={selected.id}
            onChange={setPickedId}
            options={list.map((session) => ({
              value: session.id,
              label: `${session.status} · ${formatDateTime(session.createdAt)}`,
            }))}
          />
          <Stack direction="horizontal" gap={1.5} vAlign="center" justify="between" wrap="wrap">
            <Stack direction="horizontal" gap={1.5} vAlign="center">
              <AgentAvatar name={run?.agentName ?? "Agent"} harness={run?.harness} size={16} />
              <Text type="body" weight="semibold" color="primary">
                {run?.agentName ?? "Agent work session"}
              </Text>
            </Stack>
            {displayStatus !== undefined && (
              <Token
                label={displayStatus}
                color={
                  displayStatus === "active"
                    ? "green"
                    : displayStatus === "stopping"
                      ? "orange"
                      : "gray"
                }
                size="sm"
                data-inspector-session-status={displayStatus}
              />
            )}
          </Stack>
          {liveStudioLink}
          {selected.progress !== "" && (
            <Text as="p" display="block" type="supporting" color="secondary">
              {selected.progress}
            </Text>
          )}
          {pendingQuestion !== undefined && (
            <Section variant="muted" padding={3} data-pending="true">
              <Stack gap={2}>
                <QuestionDetails question={pendingQuestion} nested />
                {canContribute && (
                  <Link to="/inbox" search={{ issue: issueId }} color="accent" hasUnderline>
                    Answer in Inbox
                  </Link>
                )}
              </Stack>
            </Section>
          )}
          <Divider />
          <MetadataList>
            <MetadataListItem label="Harness">
              <HarnessBadge harness={run?.harness} empty="Unknown" />
            </MetadataListItem>
            <MetadataListItem label="Model">{run?.model ?? "Unknown"}</MetadataListItem>
            <MetadataListItem label="Run">
              <ShortId value={selected.runId} label="run ID" />
            </MetadataListItem>
            <MetadataListItem label="Session">
              <ShortId value={selected.id} label="session ID" />
            </MetadataListItem>
            <TelemetryFacts
              inputTokens={selected.inputTokens}
              outputTokens={selected.outputTokens}
              costUsdMicros={selected.costUsdMicros}
            />
          </MetadataList>
          {!compact && (
            <>
              <Divider />
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
                <Stack as="ol" gap={2} data-activity-timeline="">
                  {activityList.map((activity) => (
                    <Stack
                      as="li"
                      key={activity.id}
                      data-activity-id={activity.id}
                      data-activity-kind={activity.kind}
                    >
                      <Card padding={2}>
                        <Stack gap={1.5}>
                          <Stack
                            direction="horizontal"
                            gap={1.5}
                            justify="between"
                            vAlign="center"
                            wrap="wrap"
                          >
                            <Token label={activity.kind} color="gray" size="sm" />
                            <Text type="supporting" color="secondary">
                              <time
                                dateTime={activity.createdAt}
                                title={formatFullDateTime(activity.createdAt)}
                              >
                                {formatDateTime(activity.createdAt)}
                              </time>
                            </Text>
                          </Stack>
                          <Text as="p" display="block" type="body" data-activity-summary="">
                            {activity.summary}
                          </Text>
                          {activity.detail !== null && renderDetail(activity.detail)}
                        </Stack>
                      </Card>
                    </Stack>
                  ))}
                </Stack>
              )}
            </>
          )}
        </>
      )}
    </Stack>
  );
}
