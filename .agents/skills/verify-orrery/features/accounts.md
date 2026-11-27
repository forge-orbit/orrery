# Bootstrap, sign-in, account profile, avatars, and password recovery

The first system administrator is created at `/setup` with `BOOTSTRAP_SECRET`, closing setup forever in one transaction. Sign-in at `/signin` sets the HttpOnly `orrery_session` cookie; `/api/auth/session` resolves `{email, handle, displayName, emailVerified, avatarUrl}`. Signed-in humans manage their profile (`displayName`, `@mention` `handle`), profile photo (`PUT`/`DELETE /api/account/avatar`, served at `GET /api/humans/{humanId}/avatar`), password (revoking other browser sessions), appearance, and sign-out at `/account`. Password recovery uses `/forgot-password` → Mailpit single-use token → `/reset-password`, plus `apps/server/src/recovery-cli.ts` for administrator local recovery without SMTP.

## Sub-features

- `setup-lifecycle` `GET /api/setup/status` (`false` → `true`); wrong secret `401 invalid_secret`; valid POST `201`; repeat POST `409 setup_complete`; missing `BOOTSTRAP_SECRET` `403 setup_unavailable`; before bootstrap all non-`/setup` routes redirect to `/setup`; after completion `/setup` redirects to `/signin` (and if already signed in, `/signin` chains to `/`).
- `signin-and-session` `/signin` posts to `/api/auth/login` (`401 invalid_credentials` on wrong password); `GET /api/auth/session` returns `{email, handle, displayName, emailVerified, avatarUrl}` or `401 not_signed_in`; `POST /api/auth/logout` clears the session.
- `account-profile` `/account` (`Profile`, `Password`, `Appearance`, `Session`): `PATCH /api/account/profile` (`displayName` + `handle`, `409 handle_taken`, `Save profile`), `PUT /api/account/avatar` / `DELETE /api/account/avatar` (`Remove photo`), `POST /api/account/password` (`Update password`), and `Sign out`.
- `password-recovery` `/signin` links `Forgot your password?` → `/forgot-password` (`POST /api/auth/password-reset/request`, uniform response) → Mailpit reset link → `/reset-password` (`POST /api/auth/password-reset/confirm`, single-use, invalidates browser sessions while keeping agent keys live).

## Preconditions

- Fresh instance with `BOOTSTRAP_SECRET` (at least 32 chars); `doctor $RUN_DIR` exits 0.
- For password recovery, Mailpit up and SMTP configured (see [settings](./settings.md)).

## Recipe

1. Verify `/api/setup/status` (`false`), wrong secret (`401`), bootstrap (`201`), repeat (`409`), and `/` signed-out redirect to `/signin`.
2. Run the committed Playwright spec (`4 passed, 1 skipped` without `ORRERY_RESTART_CMD`):
   ```bash
   ORRERY_URL=$URL ORRERY_SETUP_SECRET=$SECRET CHROMIUM_PATH=/usr/bin/chromium \
     pnpm --filter @orrery/e2e exec playwright test bootstrap.spec.ts
   ```
3. Sign in via `browse.mjs /signin` (`--fill "Email=..." --fill "Password=..." --click-button "Sign in" --expect-role "heading:Workspaces"`).
4. Profile & password via REST (`admin.jar`):
   ```bash
   curl -fsS -b $RUN_DIR/admin.jar -X PATCH "$URL/api/account/profile" -H 'content-type: application/json' \
     -d '{"displayName":"Admin User"}'
   curl -fsS -b $RUN_DIR/admin.jar "$URL/api/auth/session"   # includes displayName
   ```
5. Recovery via REST + Mailpit: `POST /api/auth/password-reset/request` for a verified email, read the reset token from Mailpit, redeem via `POST /api/auth/password-reset/confirm`, and prove old session cookies return `401`.
6. Verify `humans`, `workspaces`, and `instance_setup` rows in Postgres and confirm neither `$SECRET` nor any password appears in `$RUN_DIR/server.log`.

## Gotchas

- `/` redirects signed-out users directly to `/setup` or `/signin`; it never renders `"Sign in to continue."`.
- Restart persistence skips without `ORRERY_RESTART_CMD` (compose stack only).
- Keep session cookie jars in `$RUN_DIR`, never in `$RUN_DIR/evidence/`.
