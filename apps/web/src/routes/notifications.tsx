import { Button } from "@astryxdesign/core/Button";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { useToast } from "@astryxdesign/core/Toast";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  markAllNotificationsRead,
  markNotificationRead,
  NotificationsEmptyState,
  NotificationsErrorState,
  NotificationsList,
  NotificationsLoadingState,
  notificationUnreadCountQuery,
  notificationsPageQuery,
  notificationsQueryKey,
} from "../features/notifications/index.ts";
import { ApiProblemError } from "../lib/api.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/notifications")({
  validateSearch: (search: Record<string, unknown>): { unreadOnly: boolean } => ({
    unreadOnly: search.unreadOnly === "true" || search.unreadOnly === true,
  }),
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loaderDeps: ({ search: { unreadOnly } }) => ({ unreadOnly }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(notificationsPageQuery(deps.unreadOnly)),
  component: NotificationsPage,
  errorComponent: ({ error }) => (
    <Stack gap={5}>
      <PageHeader title="Notifications" />
      <NotificationsErrorState error={error} />
    </Stack>
  ),
});

function NotificationsPage() {
  const { unreadOnly } = Route.useSearch();
  const queryClient = useQueryClient();
  const toast = useToast();
  const feed = useInfiniteQuery(notificationsPageQuery(unreadOnly));
  const { data: polledUnreadCount } = useQuery(notificationUnreadCountQuery);
  const unreadCount = feed.data?.pages[0]?.unreadCount ?? polledUnreadCount ?? 0;
  const [pendingReadIds, setPendingReadIds] = useState<ReadonlySet<string>>(new Set());

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
  };
  const readOne = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: invalidate,
    onError: (error) => {
      toast({
        body:
          error instanceof ApiProblemError
            ? error.message
            : "Could not mark the notification read.",
        type: "error",
      });
      void invalidate();
    },
  });
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: invalidate });

  async function onRead(id: string) {
    if (pendingReadIds.has(id)) return;
    setPendingReadIds((current) => new Set(current).add(id));
    try {
      // Stop the 15s poll from overwriting the optimistic decrement below.
      await queryClient.cancelQueries({ queryKey: notificationUnreadCountQuery.queryKey });
      queryClient.setQueryData<number>(notificationUnreadCountQuery.queryKey, (current) =>
        Math.max(0, (current ?? unreadCount) - 1),
      );
      // The Link handles navigation; marking read happens in the background.
      await readOne.mutateAsync(id);
    } catch {
      // readOne reports its own error and refetches the authoritative count.
    } finally {
      setPendingReadIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function onMarkAll() {
    if (readAll.isPending) return;
    try {
      const result = await readAll.mutateAsync();
      toast({
        body: `Marked ${result.markedCount} notification${result.markedCount === 1 ? "" : "s"} read.`,
      });
    } catch (error) {
      toast({
        body:
          error instanceof ApiProblemError ? error.message : "Could not mark notifications read.",
        type: "error",
      });
    }
  }

  const notifications = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap={5} data-notifications-page="">
      <PageHeader
        title="Notifications"
        subtitle="Handoffs, questions needing input, and expired work sessions across your projects."
        badge={unreadCount > 0 ? `${unreadCount} unread` : undefined}
        actions={
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Stack
              as="nav"
              direction="horizontal"
              gap={2}
              align="center"
              aria-label="Filter notifications"
            >
              <Link
                to="/notifications"
                search={{ unreadOnly: true }}
                color={unreadOnly ? "accent" : "secondary"}
                weight={unreadOnly ? "semibold" : "medium"}
                hasUnderline={unreadOnly}
                aria-current={unreadOnly ? "page" : undefined}
              >
                Unread
              </Link>
              <Link
                to="/notifications"
                search={{ unreadOnly: false }}
                color={unreadOnly ? "secondary" : "accent"}
                weight={unreadOnly ? "medium" : "semibold"}
                hasUnderline={!unreadOnly}
                aria-current={unreadOnly ? undefined : "page"}
              >
                All
              </Link>
            </Stack>
            <Button
              label="Mark all read"
              variant="secondary"
              size="sm"
              isDisabled={unreadCount === 0 || readAll.isPending}
              isLoading={readAll.isPending}
              onClick={() => void onMarkAll()}
            />
          </Stack>
        }
      />
      {feed.isPending ? (
        <NotificationsLoadingState />
      ) : feed.isError && feed.data === undefined ? (
        <NotificationsErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : (
        <Section variant="transparent" padding={0}>
          {notifications.length === 0 ? (
            <NotificationsEmptyState
              unreadOnly={unreadOnly}
              action={
                unreadOnly ? (
                  <Link to="/notifications" search={{ unreadOnly: false }}>
                    Show all notifications
                  </Link>
                ) : (
                  <Link to="/my-work">Go to My work</Link>
                )
              }
            />
          ) : (
            <>
              <NotificationsList
                notifications={notifications}
                onRead={onRead}
                pendingReadIds={pendingReadIds}
              />
              {(feed.isFetchNextPageError || feed.hasNextPage) && (
                <Stack gap={2} hAlign="center" paddingBlockStart={4}>
                  {feed.isFetchNextPageError ? (
                    <NotificationsErrorState
                      error={feed.error}
                      isCompact
                      onRetry={() => void feed.fetchNextPage()}
                    />
                  ) : (
                    <Button
                      label="Load more"
                      variant="secondary"
                      isLoading={feed.isFetchingNextPage}
                      isDisabled={feed.isFetchingNextPage}
                      onClick={() => void feed.fetchNextPage()}
                    />
                  )}
                </Stack>
              )}
            </>
          )}
        </Section>
      )}
    </Stack>
  );
}
