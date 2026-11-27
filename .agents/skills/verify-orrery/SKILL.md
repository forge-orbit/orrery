---
name: verify-orrery
description: Launch an isolated Orrery (Hono server + React web app + Postgres) and prove behavior by driving it the way a user or agent would — headless Chromium for the web UI, curl for REST/health, an MCP client for /mcp, and Mailpit for the mail features. Use when asked to verify, demo, screenshot or confirm that a change works in the real app, not just in unit tests.
---

# Verify Orrery

Orrery is one Node process (`apps/server`, port from `PORT`) that serves the REST API, MCP at `/mcp` (39 tools), and the built Astryx React web app, backed by Postgres. The user-facing surface spans `/setup`, `/signin`, `/register`, `/forgot-password`, `/reset-password`, `/account`, `/` (Workspaces dashboard), `/my-work`, `/inbox`, `/notifications`, `/device`, `/live/$runnerId/$dispatchId` (Live Session Studio), `/workspaces/$workspaceId`, `/projects/$projectId`, `/projects/$projectId/issues/new`, `/projects/$projectId/knowledge/new`, `/board/$projectId`, `/issues/$issueId`, `/trash/$projectId`, `/knowledge/$entryId`, `/settings/smtp`, `/history/*`, `/healthz`, `/readyz`, and `/mcp`. Read `features/README.md` for the current map and extend it when you add a feature.

## Requirements and sandbox

- Docker (for a throwaway `postgres:18` and, for the mail features, `axllent/mailpit:v1.34.0`), Node 26, pnpm, `curl`, `ss`, `jq`, and a Chromium (`/usr/bin/chromium`, or set `CHROMIUM_PATH`). `browse.mjs` resolves `@playwright/test` from `tests/e2e/package.json` first (with `PLAYWRIGHT_MODULE` override fallback).
- **Run every command below outside the Bash sandbox** (`dangerouslyDisableSandbox`). Docker's socket is blocked inside it, and a server started in one sandboxed command is unreachable from the next. The server and database bind loopback only.
- Other projects' containers may own ports 5432, 8080 and 8081. The helper picks random free ports and never touches them, so two runs can coexist.

## Launch

```bash
SK=.agents/skills/verify-orrery/scripts
BOOTSTRAP_SECRET=$(openssl rand -hex 24) ORRERY_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  $SK/orrery-verify.sh up        # ~10s; prints RUN_DIR=... and URL=http://localhost:<port>
```

`up` starts a uniquely named Postgres container, builds the web app into `$RUN_DIR/web-dist` (the repo's `apps/web/dist` is untouched), starts `node src/main.ts` with `WEB_DIST`, and waits until `/readyz` is ok. Migrations run at startup. Keep `RUN_DIR` and `URL`; pass `RUN_DIR` to every other command. Use the `localhost` URL as printed: MCP rejects any other Host (`PUBLIC_URL` is set to it).

- `BOOTSTRAP_SECRET` (at least 32 characters) opens `/setup`. Without it setup is closed: `POST /api/setup/admin` answers 403 `setup_unavailable`, although `/setup` still renders and home still links it.
- `ORRERY_ENCRYPTION_KEY` (canonical base64 of 32 bytes) is required to store an SMTP password. Without it, saving one answers 409 `encryption_key_missing`.
- Both are read at startup; set them on the `up` command, not after.

The API/MCP contract changes only through code, so for a change to a route or tool also run `pnpm gen` and check `git diff contract/`.

## Doctor

```bash
$SK/orrery-verify.sh doctor $RUN_DIR
```

Read-only. Checks: server pid is ours and running, the port is owned by that pid, the Postgres container is running, `/healthz` and `/readyz` return `status: ok`, `/` serves the web app, the web build belongs to this run. Exit 0 means worth driving. Run it first whenever anything looks off; if the port is owned by another process, do not drive it.

## Drive

- **Web UI** (headless Chromium, stable handles are ARIA roles/names):
  ```bash
  node $SK/browse.mjs $RUN_DIR <path> \
    [--click-link <name>] [--fill "Label=value"] [--click-button <name>] \
    [--expect-role role:Name] [--expect-text "text"] \
    [--allow-http 401] [--allow-console ZodError] [--slug <name>]
  ```
  e.g. `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-fresh --expect-role 'heading:Set up Orrery'` (signed-out `/` redirects to `/setup` on a fresh instance or `/signin` after bootstrap). It fails (exit 1) on a missing expectation, any console error, page error, failed request or HTTP status >= 400. `--allow-http` (repeatable) marks a status as expected: signed-out routes legitimately answer 401 for `/api/auth/session`, and the database-down page answers 500/503. `--allow-console` (repeatable) ignores a console error containing the value; the database-down reload shows the designed `Server: unreachable` page and logs a `ZodError`. `--slug` names the evidence files, so one path can be captured in several states. `--fill` is repeatable (`label=value`) and runs before `--click-button`; test credentials only, they are visible in the process list. For anything it does not cover, write a one-off Playwright script the same way: `getByRole`/`getByLabel`, never coordinates.
- **REST / health**: `curl -fsS $URL/healthz`, `$URL/readyz`. New routes are listed in `contract/openapi.json`. For the database-down drill, stop only `$CONTAINER` from `$RUN_DIR/env`, and give `/readyz` up to 40s (`curl -m 40`) for the connection timeout.
- **MCP**: `ORRERY_URL=$URL pnpm --filter @orrery/e2e exec vitest run server.test.ts` runs the black-box health, SPA fallback and MCP handshake checks (4 tests); or use an MCP client against `$URL/mcp`. The full `pnpm test:e2e` is the compose suite (vitest plus Playwright, including Mailpit) and is not this harness.
- **Mail features**: `$SK/mailpit.sh up $RUN_DIR` starts a uniquely named Mailpit catcher and prints `MAILPIT_SMTP` and `MAILPIT_HTTP`. From the host-run server, use `127.0.0.1:$MAILPIT_SMTP` as the SMTP host; read caught mail at `http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages`. `down` removes it.
- **Database state**: `docker exec $CONTAINER psql -U orrery -d orrery -c '<read-only query>'`; `CONTAINER` is in `$RUN_DIR/env`.
- **Server logs**: JSON lines in `$RUN_DIR/server.log`. Check them after a drive for unexpected `error`/`warn` entries.

Per-feature recipes live in `features/`. Pick the matching file; if the change touches a feature that is not mapped, drive it by hand and add a file.

## Evidence

Everything goes to `$RUN_DIR/evidence/` (`/tmp/orrery-verify/<run>/evidence/`): `browse.mjs` writes `<slug>.png`, `<slug>.aria.txt` and `<slug>.json` (URL, status, assertion results, console problems). Save curl and test output there too (`... | tee $RUN_DIR/evidence/<name>.txt`).

A live token is a secret: never leave one in evidence. If a drive consumes it, redact it from the saved JSON/ARIA anyway (`sed -i "s/$TOKEN/<consumed-token>/g" ...`). Session cookies stay in `$RUN_DIR/*.jar`, never in `evidence/`.

Standards for a proof:

- Exercise the real user path: a browser page, an HTTP request, an MCP client. Not the service layer, not a test-only endpoint.
- Capture the action and the resulting state, and verify side effects (DB rows, logs) as well as what is visible.
- No mocks. Postgres is real; Mailpit is a real SMTP catcher.
- State the build under test: `git rev-parse --short HEAD`, whether the tree is dirty, and `RUN_DIR`. Note `version` in `/healthz` is `dev` for a source run, so it does not identify the commit.

## Restart persistence

The isolated harness does not restart the server; `kill -TERM` is not a supported drive and the launch script records no restart command. The committed Playwright specs cover restart persistence when `ORRERY_RESTART_CMD` is set (`bootstrap.spec.ts`, `smtp.spec.ts`), against the compose stack. Treat restart as `verified-unreachable` here, with that prerequisite, rather than inventing a relaunch.

## Cleanup

```bash
$SK/orrery-verify.sh down $RUN_DIR
```

Stops only the recorded server pid (after checking it is still our `src/main.ts`), force-removes the run's Postgres container and volume, removes the run's Mailpit container if `mailpit.env` recorded one, and deletes `$RUN_DIR/web-dist`. It never kills by name and keeps `$RUN_DIR/evidence`, `server.log` and `env`. Run `down` after every attempt, including failed ones. Confirm with `docker ps -a --filter name=orrery-verify-` and `ls $RUN_DIR/evidence`.
