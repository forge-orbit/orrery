import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/Code";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
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
import {
  type Project,
  type ProjectActivityType,
  type Webhook,
  type WebhookDeliveryStatus,
  type WebhookEvent,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { TextField } from "../../lib/fields.tsx";
import {
  createWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhook,
} from "./commands.ts";
import { webhookDeliveriesQuery, webhooksQueryKey, workspaceWebhooksQuery } from "./queries.ts";

const MAX_WEBHOOKS = 20;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});

const eventLabels: Record<WebhookEvent, string> = {
  "webhook.test": "Webhook test",
  project_created: "Project created",
  project_renamed: "Project renamed",
  project_fallback_policy_changed: "Project fallback policy changed",
  project_label_created: "Project label created",
  project_label_edited: "Project label edited",
  project_label_deleted: "Project label deleted",
  issue_created: "Issue created",
  issue_edited: "Issue edited",
  issue_commented: "Issue commented",
  issue_review_handoff: "Issue review handoff",
  issue_closed: "Issue closed",
  issue_reopened: "Issue reopened",
  issue_dependency_added: "Issue dependency added",
  issue_dependency_removed: "Issue dependency removed",
  issue_link_added: "Issue link added",
  issue_link_removed: "Issue link removed",
  issue_label_added: "Issue label added",
  issue_label_removed: "Issue label removed",
  issue_parent_changed: "Issue parent changed",
  issue_question_asked: "Question asked",
  issue_question_answered: "Question answered",
  issue_question_paused: "Question paused",
  issue_question_fallback_used: "Question fallback used",
  issue_question_follow_up: "Question follow-up",
  issue_fallback_policy_override_changed: "Issue fallback policy override changed",
  issue_stop_requested: "Issue stop requested",
  issue_session_expired: "Work session expired",
  issue_deleted: "Issue moved to Trash",
  issue_restored: "Issue restored from Trash",
  knowledge_created: "Knowledge created",
  knowledge_edited: "Knowledge edited",
};

const eventGroups: readonly {
  title: string;
  events: readonly ProjectActivityType[];
}[] = [
  {
    title: "Project",
    events: ["project_created", "project_renamed", "project_fallback_policy_changed"],
  },
  {
    title: "Issues",
    events: [
      "issue_created",
      "issue_edited",
      "issue_commented",
      "issue_review_handoff",
      "issue_closed",
      "issue_reopened",
      "issue_parent_changed",
      "issue_dependency_added",
      "issue_dependency_removed",
      "issue_link_added",
      "issue_link_removed",
      "issue_deleted",
      "issue_restored",
    ],
  },
  {
    title: "Labels",
    events: [
      "project_label_created",
      "project_label_edited",
      "project_label_deleted",
      "issue_label_added",
      "issue_label_removed",
    ],
  },
  {
    title: "Questions & sessions",
    events: [
      "issue_question_asked",
      "issue_question_answered",
      "issue_question_paused",
      "issue_question_fallback_used",
      "issue_question_follow_up",
      "issue_fallback_policy_override_changed",
      "issue_stop_requested",
      "issue_session_expired",
    ],
  },
  {
    title: "Knowledge",
    events: ["knowledge_created", "knowledge_edited"],
  },
];

const deliveryStatusTokens: Record<
  WebhookDeliveryStatus,
  { label: string; color: "green" | "red" | "blue" | "yellow" }
> = {
  delivered: { label: "Delivered", color: "green" },
  failed: { label: "Failed", color: "red" },
  delivering: { label: "Delivering", color: "blue" },
  pending: { label: "Pending", color: "yellow" },
};

type BusyAction = { id: string; kind: "test" | "toggle" | "rotate" | "delete" } | null;

function describeWebhookError(error: unknown, fallback: string): { title: string; detail: string } {
  if (error instanceof ApiProblemError) {
    if (error.code === "encryption_key_missing") {
      return {
        title: "Encryption key not configured",
        detail:
          "Set ORRERY_ENCRYPTION_KEY on the server before creating webhooks or rotating signing secrets.",
      };
    }
    if (error.code === "webhook_limit_reached") {
      return {
        title: "Webhook limit reached",
        detail: `Each workspace can have at most ${MAX_WEBHOOKS} webhooks. Delete an unused webhook to add another.`,
      };
    }
    return {
      title: error.problem.title || fallback,
      detail: error.message,
    };
  }
  return { title: fallback, detail: "Check your connection and try again." };
}

function relativeTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const date = new Date(iso);
  return dateTimeFormatter.format(date);
}

function formatScopeProjects(webhook: Webhook, projectById: ReadonlyMap<string, Project>): string {
  if (webhook.allProjects) return "All projects";
  if (webhook.projectIds.length === 0) return "No projects";
  return webhook.projectIds
    .map((id) => projectById.get(id)?.key ?? "Unavailable project")
    .join(", ");
}

function formatScopeEvents(webhook: Webhook): string {
  if (webhook.allEvents) return "All events";
  if (webhook.events.length === 0) return "No events";
  if (webhook.events.length <= 2) {
    return webhook.events.map((event) => eventLabels[event]).join(", ");
  }
  return `${webhook.events.length} events`;
}

export function WebhooksSection({
  workspaceId,
  projects,
}: {
  workspaceId: string;
  projects: readonly Project[];
}) {
  const { data } = useSuspenseQuery(workspaceWebhooksQuery(workspaceId));
  const hooks = data.items;
  const queryClient = useQueryClient();
  const toast = useToast();

  const [revealedSecret, setRevealedSecret] = useState<{
    secret: string;
    url: string;
    reason: "created" | "rotated";
  }>();
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<{ title: string; detail: string }>();
  const [busy, setBusy] = useState<BusyAction>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<Webhook | null>(null);
  const [deliveriesHookId, setDeliveriesHookId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Webhook | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<Webhook | null>(null);

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const deliveriesHook = hooks.find((hook) => hook.id === deliveriesHookId) ?? null;
  const atLimit = hooks.length >= MAX_WEBHOOKS;
  const autoDisabledHooks = hooks.filter(
    (hook) => !hook.enabled && hook.disabledReason === "consecutive_failures",
  );

  async function invalidateWebhooks() {
    await queryClient.invalidateQueries({ queryKey: webhooksQueryKey(workspaceId) });
  }

  async function copySecret(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ body: "Signing secret copied to clipboard." });
    } catch {
      toast({
        body: "Could not access the clipboard. Select and copy the signing secret manually.",
        type: "error",
      });
    }
  }

  async function toggleEnabled(hook: Webhook, enabled: boolean) {
    setBusy({ id: hook.id, kind: "toggle" });
    setActionError(undefined);
    try {
      await updateWebhook(workspaceId, hook.id, { enabled });
      await invalidateWebhooks();
      toast({ body: enabled ? "Webhook enabled." : "Webhook disabled." });
    } catch (error) {
      setActionError(
        describeWebhookError(
          error,
          enabled ? "Could not enable webhook" : "Could not disable webhook",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function onSendTest(hook: Webhook) {
    setBusy({ id: hook.id, kind: "test" });
    setActionError(undefined);
    try {
      await sendTestWebhook(workspaceId, hook.id);
      await queryClient.invalidateQueries({
        queryKey: webhookDeliveriesQuery(workspaceId, hook.id).queryKey,
      });
      setDeliveriesHookId(hook.id);
      toast({ body: "Test delivery enqueued." });
    } catch (error) {
      setActionError(describeWebhookError(error, "Could not send test delivery"));
    } finally {
      setBusy(null);
    }
  }

  async function onConfirmRotate() {
    if (confirmRotate === null) return;
    const target = confirmRotate;
    setBusy({ id: target.id, kind: "rotate" });
    setActionError(undefined);
    try {
      const rotated = await rotateWebhookSecret(workspaceId, target.id);
      setConfirmRotate(null);
      setRevealedSecret({ secret: rotated.signingSecret, url: rotated.url, reason: "rotated" });
      setCopied(false);
      await invalidateWebhooks();
      toast({ body: "Signing secret rotated." });
    } catch (error) {
      setConfirmRotate(null);
      setActionError(describeWebhookError(error, "Could not rotate signing secret"));
    } finally {
      setBusy(null);
    }
  }

  async function onConfirmDelete() {
    if (confirmDelete === null) return;
    const target = confirmDelete;
    setBusy({ id: target.id, kind: "delete" });
    setActionError(undefined);
    try {
      await deleteWebhook(workspaceId, target.id);
      if (deliveriesHookId === target.id) setDeliveriesHookId(null);
      setConfirmDelete(null);
      await invalidateWebhooks();
      toast({ body: "Webhook deleted." });
    } catch (error) {
      setConfirmDelete(null);
      setActionError(describeWebhookError(error, "Could not delete webhook"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap={3}>
      {revealedSecret !== undefined && (
        <Section padding={3}>
          <Stack role="status" data-webhook-secret-banner="" gap={2}>
            <Banner
              status="warning"
              title={
                revealedSecret.reason === "created"
                  ? "Copy this signing secret now"
                  : "Signing secret rotated — copy the new secret now"
              }
              description={`Shown once for ${revealedSecret.url}. It cannot be recovered later; use it to verify X-Orrery-Signature-256.`}
              collapsible={false}
            />
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
              <Code data-webhook-secret="">{revealedSecret.secret}</Code>
              <Stack direction="horizontal" gap={2} wrap="wrap" align="center">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  label={copied ? "Copied" : "Copy secret"}
                  icon={<Icon icon={copied ? "check" : "copy"} />}
                  onClick={() => void copySecret(revealedSecret.secret)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Dismiss"
                  onClick={() => {
                    setRevealedSecret(undefined);
                    setCopied(false);
                  }}
                />
              </Stack>
            </Stack>
          </Stack>
        </Section>
      )}

      {actionError !== undefined && (
        <Banner
          container="section"
          status="error"
          title={actionError.title}
          description={actionError.detail}
          collapsible={false}
          isDismissable
          onDismiss={() => setActionError(undefined)}
        />
      )}

      {autoDisabledHooks.length > 0 && (
        <Banner
          container="section"
          status="error"
          title={
            autoDisabledHooks.length === 1
              ? "1 webhook auto-disabled after consecutive failures"
              : `${autoDisabledHooks.length} webhooks auto-disabled after consecutive failures`
          }
          description="Webhooks pause automatically after 10 consecutive exhausted delivery failures. Fix the endpoint and click Re-enable to resume deliveries."
          collapsible={false}
        />
      )}

      <Section padding={3}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Heading level={2} color="inherit">
                Outgoing webhooks
              </Heading>
              <Text type="supporting">
                {hooks.length} / {MAX_WEBHOOKS}
              </Text>
            </Stack>
            {hooks.length > 0 && (
              <Button
                type="button"
                label="Add webhook"
                icon={<Icon icon={Plus} />}
                variant="primary"
                size="sm"
                isDisabled={atLimit}
                onClick={() => {
                  setEditingHook(null);
                  setActionError(undefined);
                  setFormOpen(true);
                }}
              />
            )}
          </Stack>

          {atLimit && (
            <Banner
              status="info"
              title="Workspace webhook limit reached"
              description={`This workspace has all ${MAX_WEBHOOKS} allowed webhooks. Delete an unused webhook before adding a new one.`}
              collapsible={false}
            />
          )}

          {hooks.length === 0 ? (
            <EmptyState
              title="No outgoing webhooks yet"
              description="Send signed HTTP notifications to external services whenever project activity happens in this workspace."
              headingLevel={3}
              actions={
                <Button
                  type="button"
                  label="Add webhook"
                  icon={<Icon icon={Plus} />}
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setEditingHook(null);
                    setActionError(undefined);
                    setFormOpen(true);
                  }}
                />
              }
            />
          ) : (
            <Table aria-label="Workspace webhooks">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Endpoint</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Scope</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hooks.map((hook) => {
                  const autoDisabled =
                    !hook.enabled && hook.disabledReason === "consecutive_failures";
                  const rowBusy = busy?.id === hook.id;
                  const sendingTest = rowBusy && busy.kind === "test";
                  const toggling = rowBusy && busy.kind === "toggle";
                  return (
                    <TableRow
                      key={hook.id}
                      data-webhook-id={hook.id}
                      data-webhook-enabled={String(hook.enabled)}
                    >
                      <TableCell>
                        <Stack gap={0}>
                          <code data-webhook-url>{hook.url}</code>
                          {hook.description !== "" && (
                            <Text type="supporting">{hook.description}</Text>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack gap={0}>
                          <Token
                            size="sm"
                            color={hook.enabled ? "green" : autoDisabled ? "red" : "gray"}
                            label={
                              hook.enabled ? "Active" : autoDisabled ? "Auto-disabled" : "Disabled"
                            }
                            data-webhook-status=""
                          />
                          {hook.consecutiveFailures > 0 && (
                            <Text type="supporting">
                              {hook.consecutiveFailures} failure
                              {hook.consecutiveFailures === 1 ? "" : "s"}
                            </Text>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack gap={0}>
                          <Text type="supporting" color="primary">
                            {formatScopeProjects(hook, projectById)}
                          </Text>
                          <Text type="supporting">{formatScopeEvents(hook)}</Text>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="horizontal" gap={1} vAlign="center" wrap="wrap">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            label="Send test"
                            icon={<Icon icon={Send} />}
                            isLoading={sendingTest}
                            isDisabled={rowBusy}
                            onClick={() => void onSendTest(hook)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            label="Deliveries"
                            icon={<Icon icon="clock" />}
                            onClick={() => setDeliveriesHookId(hook.id)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            label="Rotate secret"
                            icon={<Icon icon={RefreshCw} />}
                            isDisabled={rowBusy}
                            onClick={() => setConfirmRotate(hook)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant={autoDisabled ? "primary" : "secondary"}
                            label={hook.enabled ? "Disable" : "Re-enable"}
                            isLoading={toggling}
                            isDisabled={rowBusy}
                            onClick={() => void toggleEnabled(hook, !hook.enabled)}
                          />
                          <IconButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            label="Edit"
                            tooltip="Edit webhook"
                            icon={<Icon icon={Pencil} />}
                            isDisabled={rowBusy}
                            onClick={() => {
                              setEditingHook(hook);
                              setActionError(undefined);
                              setFormOpen(true);
                            }}
                          />
                          <IconButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            label="Delete"
                            tooltip="Delete webhook"
                            icon={<Icon icon={Trash2} color="error" />}
                            isDisabled={rowBusy}
                            onClick={() => setConfirmDelete(hook)}
                          />
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Section>

      <Drawer
        isOpen={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingHook(null);
        }}
        purpose="form"
        label={editingHook === null ? "Add webhook" : "Edit webhook"}
        width="32rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title={editingHook === null ? "Add webhook" : "Edit webhook"}
              subtitle="Signed with HMAC-SHA256 over timestamp and metadata-only v1 JSON."
              onOpenChange={(open) => {
                setFormOpen(open);
                if (!open) setEditingHook(null);
              }}
              hasDivider
            />
          }
        >
          <LayoutContent>
            {formOpen && (
              <WebhookForm
                key={editingHook?.id ?? "new"}
                workspaceId={workspaceId}
                projects={projects}
                initial={editingHook}
                onCancel={() => {
                  setFormOpen(false);
                  setEditingHook(null);
                }}
                onCreated={(created) => {
                  setFormOpen(false);
                  setEditingHook(null);
                  setRevealedSecret({
                    secret: created.signingSecret,
                    url: created.url,
                    reason: "created",
                  });
                  setCopied(false);
                  toast({ body: "Webhook created." });
                }}
                onUpdated={() => {
                  setFormOpen(false);
                  setEditingHook(null);
                  toast({ body: "Webhook updated." });
                }}
              />
            )}
          </LayoutContent>
        </Layout>
      </Drawer>

      <Drawer
        isOpen={deliveriesHook !== null}
        onOpenChange={(open) => {
          if (!open) setDeliveriesHookId(null);
        }}
        purpose="info"
        label="Webhook deliveries"
        width="44rem"
      >
        {deliveriesHook !== null && (
          <WebhookDeliveriesDrawer
            workspaceId={workspaceId}
            webhook={deliveriesHook}
            onClose={() => setDeliveriesHookId(null)}
            onSendTest={() => void onSendTest(deliveriesHook)}
            sendingTest={busy?.id === deliveriesHook.id && busy.kind === "test"}
          />
        )}
      </Drawer>

      <AlertDialog
        isOpen={confirmRotate !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRotate(null);
        }}
        title="Rotate signing secret?"
        description="Rotating generates a new whsec_ signing secret immediately. Any receiver verifying X-Orrery-Signature-256 with the previous secret will reject deliveries until updated."
        actionLabel="Rotate secret"
        actionVariant="primary"
        isActionLoading={
          confirmRotate !== null && busy?.id === confirmRotate.id && busy.kind === "rotate"
        }
        onAction={() => void onConfirmRotate()}
      />

      <AlertDialog
        isOpen={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title="Delete webhook?"
        description={
          confirmDelete !== null
            ? `Delete ${confirmDelete.url} and its delivery history? Pending deliveries will stop immediately and cannot be recovered.`
            : "Delete this webhook?"
        }
        actionLabel="Delete webhook"
        actionVariant="destructive"
        isActionLoading={
          confirmDelete !== null && busy?.id === confirmDelete.id && busy.kind === "delete"
        }
        onAction={() => void onConfirmDelete()}
      />
    </Stack>
  );
}

function WebhookForm({
  workspaceId,
  projects,
  initial,
  onCancel,
  onCreated,
  onUpdated,
}: {
  workspaceId: string;
  projects: readonly Project[];
  initial: Webhook | null;
  onCancel: () => void;
  onCreated: (created: { url: string; signingSecret: string }) => void;
  onUpdated: () => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [allProjects, setAllProjects] = useState(initial?.allProjects ?? true);
  const [projectIds, setProjectIds] = useState<string[]>(initial?.projectIds ?? []);
  const [allEvents, setAllEvents] = useState(initial?.allEvents ?? true);
  const [events, setEvents] = useState<ProjectActivityType[]>(initial?.events ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string }>();

  function toggleProject(id: string, checked: boolean) {
    setProjectIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id),
    );
  }

  function toggleEvent(event: ProjectActivityType, checked: boolean) {
    setEvents((prev) =>
      checked ? [...new Set([...prev, event])] : prev.filter((item) => item !== event),
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      if (initial === null) {
        const created = await createWebhook(workspaceId, {
          url: url.trim(),
          description: description.trim(),
          allProjects,
          projectIds: allProjects ? [] : projectIds,
          allEvents,
          events: allEvents ? [] : events,
        });
        await queryClient.invalidateQueries({ queryKey: webhooksQueryKey(workspaceId) });
        onCreated(created);
      } else {
        await updateWebhook(workspaceId, initial.id, {
          url: url.trim(),
          description: description.trim(),
          allProjects,
          projectIds: allProjects ? [] : projectIds,
          allEvents,
          events: allEvents ? [] : events,
          enabled,
        });
        await queryClient.invalidateQueries({ queryKey: webhooksQueryKey(workspaceId) });
        onUpdated();
      }
    } catch (cause) {
      setError(
        describeWebhookError(
          cause,
          initial === null ? "Could not create webhook" : "Could not update webhook",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={3}>
        {error !== undefined && (
          <Banner
            status="error"
            title={error.title}
            description={error.detail}
            collapsible={false}
          />
        )}

        <TextField
          id="webhook-url"
          label="Endpoint URL"
          type="url"
          value={url}
          onChange={setUrl}
          placeholder="https://hooks.example.com/orrery"
          description="HTTPS is required by default. HTTP and private LAN addresses require ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true."
          required
          maxLength={2048}
          width="100%"
        />

        <TextField
          id="webhook-description"
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Optional note, e.g. Slack release notifications"
          maxLength={500}
          width="100%"
        />

        {initial !== null && (
          <CheckboxInput
            label="Enabled"
            description={
              initial.disabledReason === "consecutive_failures" && !initial.enabled
                ? "Re-enabling clears the auto-disabled state and resets consecutive failures."
                : "Disabled webhooks stop receiving new deliveries."
            }
            value={enabled}
            onChange={setEnabled}
          />
        )}

        <Stack gap={2}>
          <Heading level={3} color="inherit">
            Project scope
          </Heading>
          <CheckboxInput
            label="All projects in this workspace"
            description="Include current and future projects in this workspace."
            value={allProjects}
            onChange={setAllProjects}
          />
          {!allProjects && (
            <Stack gap={1} paddingInlineStart={4}>
              {projects.length === 0 ? (
                <Text as="p" display="block" type="supporting">
                  No projects exist in this workspace yet.
                </Text>
              ) : (
                projects.map((project) => (
                  <CheckboxInput
                    key={project.id}
                    size="sm"
                    label={`${project.key} — ${project.name}`}
                    value={projectIds.includes(project.id)}
                    onChange={(checked) => toggleProject(project.id, checked)}
                  />
                ))
              )}
              {projectIds.length === 0 && (
                <Text as="p" display="block" type="supporting">
                  No projects selected — this webhook will not match any activity until a project is
                  selected or All projects is enabled.
                </Text>
              )}
            </Stack>
          )}
        </Stack>

        <Stack gap={2}>
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Heading level={3} color="inherit">
              Event scope
            </Heading>
            {!allEvents && <Text type="supporting">{events.length} selected</Text>}
          </Stack>
          <CheckboxInput
            label="All project activity events"
            description="Deliver every project, issue, work session, question, and knowledge event."
            value={allEvents}
            onChange={setAllEvents}
          />
          {!allEvents && (
            <Stack gap={3} paddingInlineStart={4}>
              {eventGroups.map((group) => (
                <Stack key={group.title} gap={1}>
                  <Text type="label" color="secondary">
                    {group.title}
                  </Text>
                  {group.events.map((eventType) => (
                    <CheckboxInput
                      key={eventType}
                      size="sm"
                      label={eventLabels[eventType]}
                      value={events.includes(eventType)}
                      onChange={(checked) => toggleEvent(eventType, checked)}
                    />
                  ))}
                </Stack>
              ))}
              {events.length === 0 && (
                <Text as="p" display="block" type="supporting">
                  No events selected — this webhook will not match any activity until at least one
                  event is selected or All events is enabled.
                </Text>
              )}
            </Stack>
          )}
        </Stack>

        <Stack direction="horizontal" gap={2}>
          <Button
            type="submit"
            variant="primary"
            label={initial === null ? "Create webhook" : "Save changes"}
            isLoading={saving}
            isDisabled={saving || url.trim() === ""}
          />
          <Button
            type="button"
            variant="secondary"
            label="Cancel"
            isDisabled={saving}
            onClick={onCancel}
          />
        </Stack>
      </Stack>
    </form>
  );
}

function WebhookDeliveriesDrawer({
  workspaceId,
  webhook,
  onClose,
  onSendTest,
  sendingTest,
}: {
  workspaceId: string;
  webhook: Webhook;
  onClose: () => void;
  onSendTest: () => void;
  sendingTest: boolean;
}) {
  const deliveries = useQuery(webhookDeliveriesQuery(workspaceId, webhook.id, true));
  const items = deliveries.data?.items ?? [];

  return (
    <Layout
      height="auto"
      header={
        <DrawerHeader
          title="Recent deliveries"
          subtitle={webhook.url}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          hasDivider
        />
      }
    >
      <LayoutContent>
        <Stack gap={3} data-webhook-deliveries="">
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Button
              type="button"
              size="sm"
              variant="primary"
              label="Send test"
              isLoading={sendingTest}
              isDisabled={sendingTest}
              onClick={onSendTest}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Refresh"
              isLoading={deliveries.isFetching}
              onClick={() => void deliveries.refetch()}
            />
            <Text type="supporting">Latest 50 · auto-refreshes every 5s</Text>
          </Stack>

          {deliveries.isPending ? (
            <Text as="p" display="block" type="supporting" role="status">
              Loading deliveries…
            </Text>
          ) : deliveries.isError ? (
            <Banner
              status="error"
              title="Could not load deliveries"
              description={
                deliveries.error instanceof ApiProblemError
                  ? deliveries.error.message
                  : "Check your connection and try again."
              }
              collapsible={false}
              endContent={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Retry"
                  onClick={() => void deliveries.refetch()}
                />
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              title="No deliveries yet"
              description="Send a test event or wait for matching project activity to inspect delivery attempts."
              headingLevel={3}
            />
          ) : (
            <Table aria-label="Latest webhook deliveries">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Event</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Response</TableHeaderCell>
                  <TableHeaderCell>Attempts</TableHeaderCell>
                  <TableHeaderCell>Time</TableHeaderCell>
                  <TableHeaderCell>Error</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((delivery) => {
                  const statusToken = deliveryStatusTokens[delivery.status];
                  const timestamp = delivery.deliveredAt ?? delivery.createdAt;
                  const responseSummary =
                    delivery.lastStatusCode !== null
                      ? delivery.lastDurationMs !== null
                        ? `${delivery.lastStatusCode} · ${delivery.lastDurationMs} ms`
                        : String(delivery.lastStatusCode)
                      : delivery.lastDurationMs !== null
                        ? `${delivery.lastDurationMs} ms`
                        : "—";
                  return (
                    <TableRow
                      key={delivery.id}
                      data-delivery-id={delivery.id}
                      data-delivery-status={delivery.status}
                    >
                      <TableCell>
                        <Stack gap={0}>
                          <Text type="label" color="primary">
                            {eventLabels[delivery.event]}
                          </Text>
                          <Text type="supporting">
                            <code>{delivery.event}</code>
                          </Text>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Token size="sm" color={statusToken.color} label={statusToken.label} />
                      </TableCell>
                      <TableCell>
                        <Text type="supporting" color="primary">
                          {responseSummary}
                        </Text>
                      </TableCell>
                      <TableCell>{String(delivery.attemptCount)}</TableCell>
                      <TableCell>
                        <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
                          {relativeTime(timestamp)}
                        </time>
                      </TableCell>
                      <TableCell>
                        {delivery.lastError !== null ? (
                          <Text type="supporting" color="inherit">
                            {delivery.lastError}
                          </Text>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Stack>
      </LayoutContent>
    </Layout>
  );
}
