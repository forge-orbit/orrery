# SMTP settings and email verification

System administrators manage installation-wide SMTP settings through the **Admin → SMTP settings** sidebar link (`/settings/smtp`) or the REST API, send a test email to their own address, and verify their email via the clickable `/settings/smtp?token=…` link or manual token form. The SMTP password is encrypted at rest with `ORRERY_ENCRYPTION_KEY` (AES-256-GCM, `v1:` prefix, ADR-0004) and never returned (`hasPassword` boolean only).

## Sub-features

- `smtp-ui` `/settings/smtp` form and Admin sidebar entry (`SMTP settings`, hidden from non-admins; non-admins see an admin-only alert on direct visit).
- `smtp-guard` `GET`, `PUT`, and `POST /api/settings/smtp/test` answer `401 not_signed_in` anonymously and `403 not_admin` for ordinary accounts; `POST /api/settings/email-verification` checks session + token ownership (`400 verification_token_invalid` for non-matching tokens).
- `smtp-save` `PUT /api/settings/smtp` replaces all fields (`password: null` clears a stored password; `security: "none"` with credentials is `400 insecure_smtp_credentials`; saving a password without `ORRERY_ENCRYPTION_KEY` is `409 encryption_key_missing`).
- `smtp-test-and-verify` `POST /api/settings/smtp/test` returns `200 {sentTo, message}` and sends `Verify your Orrery email` with a clickable `${PUBLIC_URL}/settings/smtp?token=…` link (when `emailVerified` is still `false`, opening the link pre-fills the form without consuming the token until clicking **Verify email** / POSTing `/api/settings/email-verification`; once `emailVerified` is `true`, the manual token form is hidden; reuse returns `400 verification_token_invalid`).
- `smtp-repair` a broken relay answers `502 smtp_unreachable` without breaking sign-in; saving a working relay recovers immediately.

## Preconditions

- Administrator created ([accounts](./accounts.md)) and signed in (`admin.jar`).
- `ORRERY_ENCRYPTION_KEY` set on `up` when testing password encryption.
- Mailpit started via `$SK/mailpit.sh up $RUN_DIR` (`MAILPIT_SMTP`, `MAILPIT_HTTP`).

## Recipe

```bash
J='content-type: application/json'; C=$RUN_DIR/admin.jar
# 1. Password encryption at rest (tls shape stored, never echoed):
curl -fsS -b "$C" -X PUT "$URL/api/settings/smtp" -H "$J" \
  -d "{\"host\":\"127.0.0.1\",\"port\":$MAILPIT_SMTP,\"security\":\"tls\",\"username\":\"postmaster\",\"password\":\"relay-needle-passphrase\",\"from\":\"orrery@orrery.test\"}"
docker exec "$CONTAINER" psql -U orrery -d orrery -Atc \
  "select left(smtp_password_encrypted,3), position('relay-needle' in coalesce(smtp_password_encrypted,'')) from instance_settings"
# Expect: v1:|0

# 2. Plain Mailpit relay + test email + clickable link token redemption:
curl -fsS -b "$C" -X PUT "$URL/api/settings/smtp" -H "$J" \
  -d "{\"host\":\"127.0.0.1\",\"port\":$MAILPIT_SMTP,\"security\":\"none\",\"username\":null,\"password\":null,\"from\":\"orrery@orrery.test\"}"
curl -fsS -b "$C" -X POST "$URL/api/settings/smtp/test"   # 200 {sentTo, message}
ID=$(curl -fsS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages" \
  | jq -r '[.messages[] | select(.Subject=="Verify your Orrery email")] | max_by(.Created) | .ID')
TEXT=$(curl -fsS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/message/$ID" | jq -r .Text)
echo "$TEXT" | grep -q '/settings/smtp?token='
TOKEN=$(echo "$TEXT" | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
curl -fsS -b "$C" -X POST "$URL/api/settings/email-verification" -H "$J" -d "{\"token\":\"$TOKEN\"}"   # 200 emailVerified:true
curl -sS -o /dev/null -w '%{http_code}\n' -b "$C" -X POST "$URL/api/settings/email-verification" -H "$J" -d "{\"token\":\"$TOKEN\"}"   # 400
```

Break the relay (`port: 1`) → confirm `502 smtp_unreachable` while `/api/auth/login` stays `200`, then restore Mailpit. Confirm the password, token, and encryption key never appear in `$RUN_DIR/server.log`.

## Gotchas

- `PUT /api/settings/smtp` requires explicit `password: null` to clear an existing password (omitting `password` is rejected by schema validation unless kept/provided).
- `left(smtp_password_encrypted, 3)` returns `v1:` (three characters including the colon).
- Restart persistence is covered by `tests/e2e/smtp.spec.ts` against the compose stack (`ORRERY_RESTART_CMD`).
