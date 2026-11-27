# Installation and workspace invitations

System administrators invite new humans to the installation via the **Installation administration** section on `/` (`Invite person` → `Send installation invitation`, plus `Resend` and `Revoke`) or via REST. The installation emails a 7-day `/register?token=…` link; opening it is inert until the invitee submits `Register` (creating the account, `Personal` workspace, and verified-email mark in one transaction) or `Decline invitation`. Workspace invitations (`/workspace-invitation?token=…`) are owned by [workspaces](./workspaces.md) and support preview, accept, new-account registration, and decline.

## Sub-features

- `invite-admin-ui-and-api` `GET /api/invitations/installation` (eagerly expires overdue rows), `POST /api/invitations/installation` (`201`, `409 account_exists` / `invitation_pending` / `smtp_unconfigured`), `POST /api/invitations/installation/{invitationId}/resend` (rotates token), and `POST /api/invitations/installation/{invitationId}/revoke`.
- `invite-register-and-decline` `POST /api/invitations/installation/registration` (`200 {email, emailVerified: true}`, `400 invitation_invalid` on reuse, `403 inviter_not_authorized`, `409 account_exists`) and `POST /api/invitations/installation/decline` (`204`).
- `invite-browser` `/register?token=…` (`Password`, `Register`, `Decline invitation` with confirmation dialog) and `/workspace-invitation?token=…` (4 branches: signed-out new account `Create account and join`, signed-out existing account `Sign in`, signed-in email mismatch `Sign out and switch account`, signed-in match `Accept invitation` / `Decline invitation` with confirmation dialog). Workspace `Invite member` also offers `Known people` autocomplete (`GET /api/workspaces/{workspaceId}/human-suggestions`).

## Preconditions

- Administrator signed in (`admin.jar`), Mailpit running (`mailpit.sh up $RUN_DIR`), and SMTP saved pointing at `127.0.0.1:$MAILPIT_SMTP`.

## Recipe

```bash
J='content-type: application/json'; C=$RUN_DIR/admin.jar
curl -fsS -b "$C" -X POST "$URL/api/invitations/installation" -H "$J" -d '{"email":"newcomer@orrery.test"}'
INV_ID=$(curl -fsS -b "$C" "$URL/api/invitations/installation" | jq -r '.[] | select(.email=="newcomer@orrery.test" and .status=="pending") | .id')
curl -fsS -b "$C" -X POST "$URL/api/invitations/installation/$INV_ID/resend" >/dev/null
MSG_ID=$(curl -fsS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages" \
  | jq -r '[.messages[] | select(.Subject=="Your Orrery invitation" and .To[0].Address=="newcomer@orrery.test")] | max_by(.Created) | .ID')
TOKEN=$(curl -fsS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/message/$MSG_ID" \
  | jq -r .Text | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
curl -fsS -X POST "$URL/api/invitations/installation/registration" -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"invited-newcomer-password\"}"   # 200 emailVerified:true
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/invitations/installation/registration" -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"invited-newcomer-password\"}"   # 400 invitation_invalid
```

Also verify `POST /api/invitations/installation/decline` (`204`) and `POST /api/invitations/installation/{id}/revoke` on fresh invites, and redact any consumed token from `$RUN_DIR/evidence/` if captured with `browse.mjs`.

## Gotchas

- `POST /api/invitations/installation` returns `{email, status}` — read the invitation `id` from `GET /api/invitations/installation` before calling `resend` or `revoke`.
- Never leave live or consumed tokens in `$RUN_DIR/evidence/` or `$RUN_DIR/server.log`.
