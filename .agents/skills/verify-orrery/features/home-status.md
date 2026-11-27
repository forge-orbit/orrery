# Home, navigation shell, and error pages

The web app's `/` route loads `/readyz`, `/api/auth/session`, and `/api/setup/status`:

- **Fresh installation (signed out):** `/` redirects to `/setup` (heading `Set up Orrery`).
- **Setup complete (signed out):** `/` redirects to `/signin` (heading `Sign in`).
- **Signed in:** renders the Astryx sidebar shell (`Orrery` wordmark link, `Workspaces`, `My work`, `Inbox`, `Notifications` with unread badge, `Your workspaces`, and for system administrators `Admin` → `SMTP settings`, `Installation history`, plus account footer with `HumanAvatar`, `AppearancePicker`, `/account`, and Sign out) and the `Workspaces` dashboard (`heading:Workspaces`, `Signed in as <email>.`, `New workspace` drawer, `Your workspaces` cards, and `Installation administration` for admins).
- **Database down on reload:** loader fails and renders `Server: unreachable`.
- **Unknown client route (signed in):** SPA fallback (HTTP 200) renders heading `Page not found` with link `Go to your workspaces` (signed-out unknown routes redirect to `/signin?next=…`).

## Sub-features

- `home-fresh` `/` redirects to `/setup` while setup is open.
- `home-signed-out` `/` redirects to `/signin` after setup completes.
- `home-signed-in` Astryx `Workspaces` heading, account line, workspace cards, and sidebar links.
- `home-notfound` `Page not found` for an unknown client route with document status 200.
- `home-unreachable` `Server: unreachable` when a reload cannot reach the database.

## Driving it with browse.mjs

Preconditions: healthy instance, `doctor` exits 0.

- **Fresh:** `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-fresh --expect-role 'heading:Set up Orrery'`
- **Signed out (post-setup):** `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-signed-out --expect-role 'heading:Sign in'`
- **Signed in:**
  ```bash
  node $SK/browse.mjs $RUN_DIR /signin --allow-http 401 --slug home-signed-in \
    --fill "Email=admin@orrery.test" --fill "Password=browser-checked-admin-password" \
    --click-button "Sign in" --expect-role "heading:Workspaces" \
    --expect-text "Signed in as admin@orrery.test." \
    --expect-role "link:My work" --expect-role "link:Inbox" --expect-role "link:Notifications" --expect-role "link:SMTP settings"
  ```
- **Not found:** signed-out unknown routes redirect to `/signin?next=…`; verify `heading:Page not found` in an authenticated Playwright session on `/does-not-exist`.
- **Unreachable:** stop only `$CONTAINER`, then:
  `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --allow-http 500 --allow-http 503 --allow-console ZodError --slug home-unreachable --expect-text "Server: unreachable"`
  Always restart `$CONTAINER` afterwards and poll `/readyz` back to 200.

## Gotchas

- `/` no longer renders a `Server: ok (dev)` or `Server: degraded (dev)` banner; check `/healthz` and `/readyz` directly for health status (see [health](./health.md)).
- Signed-out pages legitimately answer 401 for `/api/auth/session`; pass `--allow-http 401` to `browse.mjs`.
- Vite dev (`pnpm dev`, :5173) is not what `up` runs; `up` verifies the production build served by the server.
