# My work and in-app notifications

Signed-in humans have two cross-workspace attention surfaces:
- **My work (`/my-work`, `GET /api/my-work`)**: aggregates open non-deleted assigned issues (`Read`), active work sessions running under the human's agents (`Read`, live DB-time lease), and open/paused `needs_input` questions on `Contribute`/`Manage` projects. Human session only (`401` if signed out or deactivated).
- **In-app notifications (`/notifications`, `GET /api/notifications`, `POST /api/notifications/{id}/read`, `POST /api/notifications/read-all`)**: human-only alerts populated atomically for `handoff`, `needs_input` (asked/paused), `session_expired` (from the 60s sweeper or lazy expiry), and `issue_mentioned` (`@handle`). Filtered live in SQL against current project access (including transfers), active membership, active human, and non-trashed issues, with lossless microsecond keyset pagination (`400 invalid_cursor` on malformed cursor), hourly retention pruning (90d read / 180d unread), and a sidebar unread badge. Invalid/revoked bearer keys return `401`; valid agent keys return `403`.

## Sub-features

- `my-work-aggregation` `GET /api/my-work` returns `{assignedIssues, activeAgentSessions, needsInputQuestions}` and excludes revoked grants, suspended memberships, deactivated accounts, terminal/trashed issues, and lapsed leases immediately.
- `notifications-feed` `GET /api/notifications?unreadOnly=true&limit=…&cursor=…` returns `{items, unreadCount, nextCursor}` with `issue.identifier` (`<KEY>-<N>`).
- `notifications-read` `POST /api/notifications/{id}/read` (`204`, idempotent; `404` if unowned/inaccessible) and `POST /api/notifications/read-all` (`200 {markedCount}`).
- `notifications-auth` unauthenticated or invalid/revoked bearer → `401`; valid agent bearer → `403 agents_cannot_use_notifications`.

## Recipe

```bash
A=$RUN_DIR/admin.jar
# My work (human session):
curl -fsS -b "$A" "$URL/api/my-work" | jq -c '{assigned: (.assignedIssues|length), sessions: (.activeAgentSessions|length), questions: (.needsInputQuestions|length)}'

# Notifications auth parity (K2 from agents.md):
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer invalid-token" "$URL/api/notifications"   # 401
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $K2" "$URL/api/notifications"            # 403

# Human feed, single mark-read, and mark-all-read (after question + handoff in work-sessions-and-inbox.md):
NOTIFS=$(curl -fsS -b "$A" "$URL/api/notifications")
echo "$NOTIFS" | jq -c '{unreadCount, kinds: [.items[].kind], id: .items[0].issue.identifier}'
N1=$(echo "$NOTIFS" | jq -r '.items[0].id')
curl -sS -o /dev/null -w '%{http_code}\n' -b "$A" -X POST "$URL/api/notifications/$N1/read"   # 204
curl -fsS -b "$A" -X POST "$URL/api/notifications/read-all" | jq -c '{markedCount}'
```

## Gotchas

- `/notifications` is live in the sidebar (polls every 15s via TanStack Query) with an unread badge (`data-notifications-link`).
- `/my-work` is live in the sidebar and polls every 4 seconds (`refetchInterval: 4000`) via TanStack Query.
