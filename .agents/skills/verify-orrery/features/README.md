# Orrery verification map

The maintained source for verifying Orrery's user-facing behavior. Read this index, then use the matching feature file as the recipe. Keep this map in sync as features land (`/maintain-verification-skill`).

## Baseline preconditions

- Instance started by this run with `scripts/orrery-verify.sh up` (see `../SKILL.md`), fresh database, no seed data.
- For `/setup`, `BOOTSTRAP_SECRET` (at least 32 characters) was set on the `up` command. For a stored SMTP password, `ORRERY_ENCRYPTION_KEY` was set too.
- For the mail features (settings, invitations, password recovery, needs-input email), `scripts/mailpit.sh up $RUN_DIR` started the catcher; use the printed `MAILPIT_SMTP` and `MAILPIT_HTTP`.
- `scripts/orrery-verify.sh doctor $RUN_DIR` exits 0.
- Never drive an instance this run did not start (another Orrery may be on :8080).
- Run `up`, drives, and `down` outside any sandbox that blocks Docker or tears down background child processes between commands (if your runner terminates background processes on command exit, run `up`, the drive, and `down` in one shell command with `trap ... EXIT`).

## Driving conventions

- Start every recipe from `SK=.agents/skills/verify-orrery/scripts`, `. $RUN_DIR/env` (sets `URL` and `CONTAINER`), and for mail features `. $RUN_DIR/mailpit.env` (sets `MAILPIT_SMTP` and `MAILPIT_HTTP`).
- Browser: `node $SK/browse.mjs $RUN_DIR <path> ...` with ARIA roles and visible text, never coordinates. Forms: `--fill "Label=value"` then `--click-button "Name"`. Expected failures: `--allow-http 401` (signed-out session checks), `--allow-http 500 --allow-http 503 --allow-console ZodError` (database-down reload). Name evidence with `--slug`.
- HTTP: `curl` against `$URL` exactly as printed by `up` (host `localhost`).
- Mail: read caught messages at `http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages`; SMTP settings point at `127.0.0.1:$MAILPIT_SMTP`.
- Save every artifact to `$RUN_DIR/evidence/` and name the feature ID in the file name.

## Proof and skip reporting

- UI proof: screenshot plus ARIA snapshot plus the `.json` assertions from `browse.mjs`, with zero unallowed console problems.
- HTTP proof: command, status code and body.
- Report an unreachable path with the attempted command and the unmet precondition; do not substitute another entry point. Restart persistence is the known case: it needs `ORRERY_RESTART_CMD` and the compose stack, not this harness.

## Features

- [Bootstrap, sign-in, account profile, avatars, and password recovery](./accounts.md): `/setup`, `/signin`, `/account` (`displayName`, `@mention` `handle`, avatar upload/removal, password change, sign-out), `/forgot-password`, `/reset-password`, and `recovery-cli.ts`.
- [Home, navigation shell, and error pages](./home-status.md): `/` signed-out redirects (`/setup` / `/signin`), signed-in Astryx `Workspaces` dashboard and sidebar (`Workspaces`, `My work`, `Inbox`, `Notifications`, `Admin`), `Server: unreachable`, and signed-in `Page not found`.
- [Health endpoints](./health.md): `/healthz` liveness and `/readyz` Postgres + object-storage readiness, including degraded state and recovery.
- [MCP endpoint](./mcp.md): stateless Streamable HTTP `/mcp` with Host-header guard, 39 registered tools across projects/runs/work-sessions/inbox, and Bearer agent-key authentication.
- [Installation and workspace invitations](./invitations.md): admin invitation list/send/resend/revoke on `/`, Mailpit delivery, `/register?token=…` registration and decline, and cross-link to `/workspace-invitation?token=…`.
- [SMTP settings and email verification](./settings.md): `/settings/smtp` UI and REST, Admin sidebar nav, encrypted SMTP password (`v1:` prefix), clickable `?token=` verification email, and relay repair.
- [Workspaces, webhooks, transfers, and ownership recovery](./workspaces.md): shared workspaces, `Projects`/`Trash`/`Agents`/`Runs`/`Runners`/`Members`/`Webhooks` tabs, `Member permissions` drawer, human suggestions, voluntary leave, project transfers, and admin ownership recovery.
- [Agents, API keys, rotation, and runs](./agents.md): agent registration, workspace-scoped keys with `keyHint` previews, overlapping key rotation, owner/self revocation, dispatch tokens, `Agents` workspace tab, and `runs` hook/MCP check-in.
- [Projects, six-state board, attachments, labels, subtasks, links, dependencies, knowledge, and Trash](./projects.md): `KEY-N` identifiers, six-state workflow, GFM + Mermaid + `@mention` rendering, project-scoped attachments, dedicated `/issues/new` & `/knowledge/new` pages, labels, 1-level subtasks, typed links, acyclic dependencies, 30-day Trash for projects/issues/knowledge, and access levels.
- [Work sessions and Needs-input inbox](./work-sessions-and-inbox.md): five-minute claim leases, `ready_work`, renew/progress/stop/resume/reacquire, stop requests, ephemeral `v1` session activities, token/cost telemetry, and 1-hour `Needs input` questions + fallback policy (`/inbox`).
- [My work and in-app notifications](./my-work-and-notifications.md): cross-workspace `/my-work` (`GET /api/my-work`) and `/notifications` UI + `/api/notifications` (proactive sweeper, `handoff`/`needs_input`/`session_expired`/`issue_mentioned`, unread sidebar badge, keyset pagination, mark-read, mark-all-read).
- [History and account deactivation](./history-and-admin.md): scoped audit logs (`/history/installation`, `/history/workspace/$workspaceId`, `/history/project/$projectId`) with `HumanAvatar` and category filters, and admin account deactivation/reactivation.
- [Local Runners, device enrollment, and Live Session Studio](./runners.md): `/device` host approval, workspace `Runners` fleet tab, `Delegate to Runner` modal, and `/live/$runnerId/$dispatchId` Live Session Studio cockpit.
