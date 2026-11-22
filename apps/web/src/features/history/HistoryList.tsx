import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Section } from "@astryxdesign/core/Section";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
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
import { Token } from "@astryxdesign/core/Token";
import type { HistoryEvent } from "@orrery/contract";
import { useState } from "react";
import { HumanAvatar } from "../../lib/avatar.tsx";
import { formatFullDateTime, relativeTime } from "../../lib/time.ts";

const labels: Record<string, string> = {
  workspace_created: "created the workspace",
  member_joined: "joined the workspace",
  owner_appointed: "appointed an owner",
  member_removed: "removed a member",
  owner_removed: "removed an owner",
  member_left: "left the workspace",
  owner_left: "left the workspace as an owner",
  create_projects_granted: "granted Create projects",
  create_projects_revoked: "revoked Create projects",
  invite_members_granted: "granted Invite members",
  invite_members_revoked: "revoked Invite members",
  remove_members_granted: "granted Remove members",
  remove_members_revoked: "revoked Remove members",
  manage_member_permissions_granted: "granted Manage member permissions",
  manage_member_permissions_revoked: "revoked Manage member permissions",
  project_transfer_authorized: "authorized a project transfer out",
  project_transfer_received: "received a transferred project",
  project_transferred_out: "transferred a project out",
  project_access_granted: "granted project access",
  project_access_level_changed: "changed project access",
  project_access_revoked: "revoked project access",
  agent_key_created: "created a credential for",
  agent_key_revoked: "revoked a credential for",
  agent_key_rotated: "rotated a credential for",
  project_created: "created the project",
  project_renamed: "renamed the project",
  project_fallback_policy_changed: "changed the project fallback policy",
  project_label_created: "created a project label",
  project_label_edited: "edited a project label",
  project_label_deleted: "deleted a project label",
  issue_created: "opened issue",
  issue_edited: "edited issue",
  issue_commented: "commented on issue",
  issue_review_handoff: "handed issue off for review",
  issue_closed: "closed issue",
  issue_reopened: "reopened issue",
  issue_stop_requested: "asked the agent to stop on issue",
  issue_session_expired: "lost its claim lease on issue",
  issue_dependency_added: "added a blocker to issue",
  issue_dependency_removed: "removed a blocker from issue",
  issue_link_added: "linked on issue",
  issue_link_removed: "unlinked from issue",
  issue_label_added: "labelled issue",
  issue_label_removed: "unlabelled issue",
  issue_parent_changed: "changed the parent of issue",
  issue_question_asked: "asked for input on issue",
  issue_question_answered: "answered a question on issue",
  issue_question_paused: "paused a question on issue",
  issue_question_fallback_used: "used an authorized fallback on issue",
  issue_question_follow_up: "added a follow-up to an authorized fallback on issue",
  issue_fallback_policy_override_changed: "changed the fallback policy override on issue",
  issue_deleted: "moved issue to trash",
  issue_restored: "restored issue from trash",
  knowledge_created: "created knowledge",
  knowledge_edited: "edited knowledge",
  installation_bootstrap: "bootstrapped the installation",
  installation_invitation_created: "invited",
  installation_invitation_accepted: "accepted an invitation from",
  installation_invitation_declined: "declined an invitation from",
  installation_invitation_expired: "let an invitation expire for",
  installation_invitation_revoked: "revoked an invitation for",
  account_deactivated: "deactivated",
  account_reactivated: "reactivated",
  workspace_ownership_recovered: "recovered workspace ownership for",
};

const kindTokens: Record<
  string,
  { label: string; color: "blue" | "orange" | "green" | "purple" | "gray" }
> = {
  project_activity: { label: "Activity", color: "blue" },
  project_access: { label: "Project access", color: "purple" },
  workspace_access: { label: "Workspace", color: "orange" },
  agent_credential: { label: "Agent key", color: "green" },
  installation_access: { label: "Installation", color: "gray" },
};

function kindMeta(kind: string) {
  return kindTokens[kind] ?? { label: kind.replaceAll("_", " "), color: "gray" as const };
}

function describe(event: HistoryEvent): string {
  const label = labels[event.type] ?? event.type.replaceAll("_", " ");
  const level =
    event.level !== null
      ? event.previousLevel === null || event.previousLevel === event.level
        ? ` (${event.level})`
        : ` (${event.previousLevel} to ${event.level})`
      : event.previousLevel !== null
        ? ` (was ${event.previousLevel})`
        : "";
  const target =
    event.subject === null || event.subject.displayName === event.actor.displayName
      ? ""
      : ` ${event.subject.displayName}`;
  return `${event.actor.displayName} ${label}${target}${level}`;
}

export function HistoryList({
  events,
  emptyMessage = "No events recorded yet.",
}: {
  events: HistoryEvent[];
  emptyMessage?: string;
}) {
  const [kindFilter, setKindFilter] = useState("all");
  const kinds: string[] = Array.from(new Set(events.map((event) => event.kind)));
  const activeFilter = kindFilter !== "all" && !kinds.includes(kindFilter) ? "all" : kindFilter;
  const visible =
    activeFilter === "all" ? events : events.filter((event) => event.kind === activeFilter);

  if (events.length === 0) {
    return (
      <Stack paddingInline={5} paddingBlock={8}>
        <EmptyState title={emptyMessage} headingLevel={2} />
      </Stack>
    );
  }

  return (
    <Section padding={3}>
      <Stack gap={3}>
        {kinds.length > 1 && (
          <Stack direction="horizontal" hAlign="between" vAlign="center" wrap="wrap" gap={2}>
            <Text type="supporting" color="secondary">
              Showing {visible.length} of {events.length} events
            </Text>
            <SegmentedControl
              size="sm"
              label="Filter history category"
              value={activeFilter}
              onChange={setKindFilter}
            >
              <SegmentedControlItem value="all" label={`All (${events.length})`} />
              {kinds.map((kind) => (
                <SegmentedControlItem key={kind} value={kind} label={kindMeta(kind).label} />
              ))}
            </SegmentedControl>
          </Stack>
        )}

        <Table aria-label="History events">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Event</TableHeaderCell>
              <TableHeaderCell>Category</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell>
              <TableHeaderCell>When</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((event) => {
              const description = describe(event);
              const showSummary =
                event.summary !== null &&
                event.type !== "installation_bootstrap" &&
                !description.includes(event.summary);
              const meta = kindMeta(event.kind);

              return (
                <TableRow
                  key={event.id}
                  data-event-kind={event.kind}
                  data-event-type={event.type}
                  data-event-id={event.id}
                >
                  <TableCell>
                    <Stack direction="horizontal" gap={1.5} vAlign="center">
                      <HumanAvatar
                        name={event.actor.displayName}
                        avatarUrl={event.actor.avatarUrl}
                        size="sm"
                      />
                      <Stack gap={0.5}>
                        <Text type="body" color="primary" data-event-description={description}>
                          {description}
                        </Text>
                        {showSummary && (
                          <Text type="supporting" color="secondary">
                            “{event.summary}”
                          </Text>
                        )}
                      </Stack>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Token label={meta.label} color={meta.color} size="sm" />
                  </TableCell>
                  <TableCell>
                    {event.scope.name !== null ? (
                      <Token label={event.scope.name} color="gray" size="sm" />
                    ) : (
                      <Text type="supporting" color="secondary">
                        —
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" color="secondary">
                      <time dateTime={event.createdAt} title={formatFullDateTime(event.createdAt)}>
                        {relativeTime(event.createdAt)}
                      </time>
                    </Text>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Stack>
    </Section>
  );
}
