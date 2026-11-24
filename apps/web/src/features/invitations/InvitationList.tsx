import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
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
import type { InvitationSummary } from "@orrery/contract";
import { useState } from "react";
import { formatDateTime, formatFullDateTime, relativeTime } from "../../lib/time.ts";

const statusTokens: Record<
  InvitationSummary["status"],
  { label: string; color: "orange" | "green" | "red" | "gray" }
> = {
  pending: { label: "Pending", color: "orange" },
  accepted: { label: "Accepted", color: "green" },
  declined: { label: "Declined", color: "red" },
  expired: { label: "Expired", color: "gray" },
  revoked: { label: "Revoked", color: "red" },
};

function deliveryToken(delivery: InvitationSummary["delivery"]): {
  label: string;
  color: "green" | "red" | "gray";
} {
  if (delivery.status === "sent") return { label: "Email sent", color: "green" };
  if (delivery.status === "failed") return { label: "Email failed", color: "red" };
  return { label: "Not attempted", color: "gray" };
}

function grantLabel(invitation: InvitationSummary): string {
  return invitation.grants
    .map((grant) => {
      if (grant.kind === "installation_account") return "Installation account";
      if (grant.kind === "workspace_membership") return "Workspace member";
      return `${grant.projectName ?? "Project no longer in workspace"} (${grant.level})`;
    })
    .join(", ");
}

function targetLabel(invitation: InvitationSummary): string {
  return invitation.target.kind === "installation" ? "This installation" : invitation.target.name;
}

function terminalEvent(invitation: InvitationSummary): { label: string; at: string } | null {
  if (invitation.acceptedAt !== null) return { label: "Accepted", at: invitation.acceptedAt };
  if (invitation.declinedAt !== null) return { label: "Declined", at: invitation.declinedAt };
  if (invitation.revokedAt !== null) return { label: "Revoked", at: invitation.revokedAt };
  if (invitation.expiredAt !== null) return { label: "Expired", at: invitation.expiredAt };
  return null;
}

export interface InvitationListProps {
  invitations: InvitationSummary[];
  emptyMessage: string;
  emptyDescription?: string;
  busyId?: string;
  error?: string;
  embedded?: boolean;
  onResend?: (invitation: InvitationSummary) => Promise<void>;
  onRevoke?: (invitation: InvitationSummary) => Promise<void>;
}

export function InvitationList({
  invitations,
  emptyMessage,
  emptyDescription,
  busyId,
  error,
  embedded = false,
  onResend,
  onRevoke,
}: InvitationListProps) {
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const [pendingRevoke, setPendingRevoke] = useState<InvitationSummary>();

  const pendingCount = invitations.filter((item) => item.status === "pending").length;
  const visible =
    filter === "pending" ? invitations.filter((item) => item.status === "pending") : invitations;
  const showActions = onResend !== undefined || onRevoke !== undefined;

  if (invitations.length === 0) {
    const empty = (
      <EmptyState
        title={emptyMessage}
        {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
        isCompact
        headingLevel={3}
      />
    );
    if (embedded) return empty;
    return (
      <Section padding={3}>
        <Stack gap={2}>
          <Heading level={3} color="inherit">
            Invitation history
          </Heading>
          {empty}
        </Stack>
      </Section>
    );
  }

  const content = (
    <Stack gap={3}>
      <Stack direction="horizontal" gap={2} hAlign="between" vAlign="center" wrap="wrap">
        <Heading level={3} color="inherit">
          Invitation history
        </Heading>
        {invitations.length > 1 && (
          <SegmentedControl
            size="sm"
            label="Filter invitations"
            value={filter}
            onChange={(value) => {
              if (value === "all" || value === "pending") setFilter(value);
            }}
          >
            <SegmentedControlItem value="all" label={`All (${invitations.length})`} />
            <SegmentedControlItem value="pending" label={`Pending (${pendingCount})`} />
          </SegmentedControl>
        )}
      </Stack>

      {error !== undefined && (
        <Banner
          status="error"
          role="alert"
          title="Could not update invitation"
          description={error}
        />
      )}

      {visible.length === 0 ? (
        <EmptyState
          title="No pending invitations"
          description="Switch to All to see accepted, expired, or revoked invitations."
          isCompact
          headingLevel={4}
          actions={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Show all"
              onClick={() => setFilter("all")}
            />
          }
        />
      ) : (
        <Table aria-label="Invitation history">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Recipient</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Delivery</TableHeaderCell>
              <TableHeaderCell>Timeline</TableHeaderCell>
              {showActions && <TableHeaderCell>Actions</TableHeaderCell>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((invitation) => {
              const status = statusTokens[invitation.status];
              const delivery = deliveryToken(invitation.delivery);
              const terminal = terminalEvent(invitation);
              const isRowBusy = busyId === invitation.id;
              const canResend =
                (invitation.status === "pending" || invitation.status === "expired") &&
                onResend !== undefined;
              const canRevoke = invitation.status === "pending" && onRevoke !== undefined;

              return (
                <TableRow
                  key={invitation.id}
                  data-invitation-id={invitation.id}
                  data-invitation-status={invitation.status}
                  data-delivery-status={invitation.delivery.status ?? "unknown"}
                >
                  <TableCell>
                    <Stack gap={0.5}>
                      <Text type="body" weight="semibold" color="primary">
                        {invitation.email}
                      </Text>
                      <Text type="supporting" color="secondary">
                        Invited by {invitation.invitedBy.email} · {targetLabel(invitation)}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {grantLabel(invitation)}
                      </Text>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Token label={status.label} color={status.color} size="sm" />
                  </TableCell>
                  <TableCell>
                    <Stack gap={0.5} hAlign="start">
                      <Token label={delivery.label} color={delivery.color} size="sm" />
                      {invitation.delivery.attemptedAt !== null && (
                        <Text type="supporting" color="secondary">
                          <time
                            dateTime={invitation.delivery.attemptedAt}
                            title={formatFullDateTime(invitation.delivery.attemptedAt)}
                          >
                            {relativeTime(invitation.delivery.attemptedAt)}
                          </time>
                        </Text>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack gap={0.5}>
                      <Text type="supporting" color="secondary">
                        Created{" "}
                        <time
                          dateTime={invitation.createdAt}
                          title={formatFullDateTime(invitation.createdAt)}
                        >
                          {formatDateTime(invitation.createdAt)}
                        </time>
                      </Text>
                      {terminal !== null ? (
                        <Text type="supporting" color="secondary">
                          {terminal.label}{" "}
                          <time dateTime={terminal.at} title={formatFullDateTime(terminal.at)}>
                            {formatDateTime(terminal.at)}
                          </time>
                        </Text>
                      ) : (
                        <Text type="supporting" color="secondary">
                          Expires{" "}
                          <time
                            dateTime={invitation.expiresAt}
                            title={formatFullDateTime(invitation.expiresAt)}
                          >
                            {formatDateTime(invitation.expiresAt)}
                          </time>
                        </Text>
                      )}
                    </Stack>
                  </TableCell>
                  {showActions && (
                    <TableCell>
                      {canResend || canRevoke ? (
                        <Stack direction="horizontal" gap={1} wrap="wrap">
                          {canResend && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void onResend(invitation)}
                              isDisabled={busyId !== undefined}
                              isLoading={isRowBusy}
                              label="Resend"
                              variant="secondary"
                            />
                          )}
                          {canRevoke && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setPendingRevoke(invitation)}
                              isDisabled={busyId !== undefined}
                              label="Revoke"
                              variant="destructive"
                            />
                          )}
                        </Stack>
                      ) : (
                        <Text type="supporting" color="secondary">
                          —
                        </Text>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {onRevoke !== undefined && (
        <AlertDialog
          isOpen={pendingRevoke !== undefined}
          onOpenChange={(open) => {
            if (!open) setPendingRevoke(undefined);
          }}
          title="Revoke invitation?"
          description={
            pendingRevoke === undefined
              ? "Revoke this invitation?"
              : `The pending invitation link sent to ${pendingRevoke.email} will stop working immediately.`
          }
          actionLabel="Revoke invitation"
          actionVariant="destructive"
          isActionLoading={pendingRevoke !== undefined && busyId === pendingRevoke.id}
          onAction={() => {
            if (pendingRevoke === undefined) return;
            const target = pendingRevoke;
            setPendingRevoke(undefined);
            void onRevoke(target);
          }}
        />
      )}
    </Stack>
  );

  if (embedded) return content;

  return <Section padding={3}>{content}</Section>;
}
