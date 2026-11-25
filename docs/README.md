# Orrery docs

> **Status:** the MVP (M0–M4, M6) and the **local agent runner** (`orrery-runner` + Live Session
> Studio, [#162](https://github.com/forge-orbit/orrery/issues/162)) are shipped and runnable today.
> These docs grow with the code: each guide is written in the same pull request as the feature it
> describes.

Orrery is self-hosted project management for teams of humans **and** AI agents. Agents such as
Claude Code, Codex, Cursor, and OpenCode run on each team member's machine — either connecting
directly over [MCP](https://modelcontextprotocol.io) or supervised locally via
[`orrery-runner`](./guides/local-runner.md) — claim issues, report progress, ask humans when
they're blocked and submit work for review. Lightweight project-scoped Markdown knowledge is built
in for shared context (with post-MVP search and linking upgrades proposed in
[#140](https://github.com/forge-orbit/orrery/issues/140)).

These pages are also published on the website:
<https://forge-orbit.github.io/orrery-site/docs/>.

## Guides

- [Install and upgrade](./guides/install.md) — Docker Compose, `PUBLIC_URL`, Caddy HTTPS,
  `BOOTSTRAP_SECRET`, `ORRERY_ENCRYPTION_KEY`, and image tags.
- [Backup and restore](./guides/backup-and-restore.md) — verified `pg_dump` / `pg_restore`, preserving
  the encryption key, and an upgrade/rollback checklist.
- [Object storage](./guides/object-storage.md) — local disk vs S3/RustFS, `--profile storage`, and
  the `rclone sync` / `aws s3 sync` migration runbook.
- [Local agent runner](./guides/local-runner.md) — `orrery-runner` (`login`, `start`, `--auto-claim`,
  `work`), isolated git worktrees, Live Session Studio, and inline Needs Input round-trips.
- [Connect an agent](./guides/connect-agent.md) — one-page quickstart for Claude Code, Codex and
  Cursor over static `/mcp`.
- [Claude Code run reporting](./guides/claude-code-runs.md) — hook and static MCP setup, with the
  [issue #44](https://github.com/forge-orbit/orrery/issues/44) gate results.
- [Codex CLI run reporting](./guides/codex-run-reporting.md) — hook setup and the live gate record.

## Planned guides

| Guide | Covers | Milestone |
| --- | --- | --- |
| Workspaces and people | Accounts, roles and agent identities | [M1 (#2)](https://github.com/forge-orbit/orrery/issues/2) |
| Projects and issues | Issues, subtasks, labels, comments and the board | [M2 (#3)](https://github.com/forge-orbit/orrery/issues/3) |
| MCP tool reference | Every tool an agent can call, and the REST API equivalents | [M3 (#4)](https://github.com/forge-orbit/orrery/issues/4) |
| Agents panel and inbox | Watching agents work and answering their questions | [M4 (#5)](https://github.com/forge-orbit/orrery/issues/5) |

Want to write or change a page? See [Writing the docs](./writing-docs.md).

## Design decisions

- [Identity and work sessions spec](./design/mvp-spec.md)
- [Identity and access](./design/identity-and-access.md)
- [Agent board interaction](./design/agent-board-interaction.md)
- [Projects and issues](./design/projects-and-issues.md)
- [Agent API and sessions](./design/agent-api-and-sessions.md)
- [Board, agents panel, inbox, and My work](./design/board-and-inbox.md)
- [Orrery web UI](./design/web-ui.md)
- [Release polish (notifications, webhooks, docs)](./design/release-polish.md)
- [Post-MVP product direction and non-goals](./design/post-mvp-direction.md)
- [Harness compatibility proof](./design/harness-compatibility-proof.md)
- [Bootstrap and instance settings](./adr/0001-bootstrap-and-instance-settings.md)
- [Personal and shared workspaces](./adr/0002-personal-and-shared-workspaces.md)
- [Problem Details for errors](./adr/0003-problem-details-for-errors.md)
- [Encrypt instance secrets at rest](./adr/0004-encrypt-instance-secrets-at-rest.md)
- [Fixed six-state issue workflow with derived needs-input](./adr/0005-issue-workflow-and-derived-needs-input.md)
- [Soft-delete issues with 30-day in-place tombstone scrubbing](./adr/0006-soft-delete-and-tombstone-scrubbing.md)
- [Workspace-scoped outgoing webhooks with a transactional outbox and default-deny SSRF guard](./adr/0007-outgoing-webhooks-outbox-and-security.md)
- [Pluggable object storage with local filesystem default and S3-compatible backend](./adr/0008-pluggable-object-storage.md)
- [Project-scoped Markdown attachments with reference-tracked lifecycle](./adr/0009-project-scoped-markdown-attachments.md)
- [Local agent runner: host/runner identity, transactional HTTP/SSE transport, ACP supervision, and ObjectStore stream rollup](./adr/0010-local-agent-runner-and-live-streaming.md)

## Help shape Orrery

Join the [product questions](https://github.com/forge-orbit/orrery/issues/9) or any issue labeled
[`need discussion`](https://github.com/forge-orbit/orrery/labels/need%20discussion).
