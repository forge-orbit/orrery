# Post-MVP product direction and non-goals

> **Status: Planned (discussion notes).** Everything in the candidate areas below is a post-MVP
> proposal, not shipped behavior. Each item requires an agreed GitHub issue labeled
> [`need discussion`](https://github.com/forge-orbit/orrery/labels/need%20discussion) before
> implementation, alongside existing post-MVP proposals
> ([#140](https://github.com/forge-orbit/orrery/issues/140),
> [#15](https://github.com/forge-orbit/orrery/issues/15), and
> [#14](https://github.com/forge-orbit/orrery/issues/14)).

With the MVP (M0–M4 and M6) complete, this document records the core properties that differentiate
Orrery from conventional project trackers, the highest-leverage post-MVP improvements that fit that
identity, and the non-goals we intentionally avoid.

## Core differentiation (what we protect)

Every post-MVP decision should preserve four structural advantages that define Orrery:

1. **Native human and agent execution protocol.** Conventional issue trackers treat automation as
   generic CRUD API tokens. Orrery models `Agent`, `Run`, `Harness`, `Work session`, and `Claim` as
   first-class entities: pull-based `/mcp` (with 1:1 REST parity behind NAT), atomic five-minute
   Claim leases enforced in Postgres, live human stop signals, ephemeral sidecar activity blocks,
   the Needs-input inbox with one-hour fallback policies, and harness/model/subagent/token-cost
   telemetry.
2. **Two-container operational simplicity.** Self-hosting Orrery takes one app container and
   Postgres 18 (plus optional Caddy TLS). Postgres handles transactional webhook outbox delivery,
   expiry sweeping, and workflow constraints directly — no Redis, message broker, separate worker
   fleet, object store, or collaborative sync server is required.
3. **Correctness and security by construction.** One Zod 4 schema package generates both OpenAPI
   3.1 and MCP tool JSON Schemas, errors use RFC 9457 Problem Details, Postgres constraints enforce
   invariants (single active Work session, Claim exclusivity, acyclic `blocked_by` edges), 36
   state-machine models are formally verified, API keys are scoped to one Workspace and capped by
   their owning Human's live permissions, and System administrators have no implicit access to
   Workspace data.
4. **Focused on continuous queues and review handoffs.** Fixed six-state workflows, cross-workspace
   **My work**, and the **Needs-input Inbox** optimize for teams supervising multiple agents across
   projects rather than managing sprint ceremony.

## Post-MVP candidate areas (planned)

These planned capabilities improve day-to-day human ergonomics and operational safety for teams
running multiple agents without adding infrastructure sprawl.

### Priority 1 — High-leverage ergonomics and agent guardrails

- **Command palette and keyboard-first navigation.** A global `Cmd+K` / `Ctrl+K` palette with
  keyboard-layout-independent shortcuts to jump directly to `<KEY>-<NUMBER>` issues, switch
  workspaces and projects, open the Needs-input inbox, and quick-create issues. Developers running
  agents from terminals benefit disproportionately from zero-mouse navigation.
- **Dense List view and Saved Views.** Add a compact List/Table layout toggle alongside the
  six-column Kanban board so projects with 100+ issues stay scannable, plus saved filter presets
  (for example: *Ready for agent*, *Blocked*, *Waiting on review*, *High priority*). Extends the
  view customization direction discussed in [#15](https://github.com/forge-orbit/orrery/issues/15).
- **Per-API-key rate limiting and request activity logs.** Autonomous coding agents can get stuck
  in tight retry loops. Adding per-key rate limits (with standard `X-RateLimit-Remaining` and
  `X-RateLimit-Reset` headers) and a bounded per-key request log protects self-hosted installations
  and makes debugging misbehaving harnesses straightforward.
- **Developer OAuth / SSO sign-in.** Support GitHub, GitLab, and generic OIDC authentication
  alongside email/password accounts to remove onboarding friction for engineering teams that
  already link pull requests and commits on issues.

### Priority 2 — Scale, triage, and supervision quality of life

- **Intake / Triage queue.** A lightweight pre-board intake stage (`pending`, `accepted`,
  `rejected`, `duplicate`, `snoozed` with automatic wake-up) where external bug reports, incoming
  automations, or agent-proposed follow-up issues wait for human approval before entering `todo`
  and becoming eligible for `ready_work`.
- **Notification preferences, snooze, and archive.** Per-event and per-project notification toggles
  plus snooze and archive states on `/notifications`, keeping signal high as concurrent agents
  generate review handoffs, mentions, and lease/deadline alerts.
- **Auto-archive and content version snapshots.** Optional project-level auto-archiving for stale
  `done` and `cancelled` issues to keep active boards fast over long histories, plus lightweight
  version history on issue descriptions and project knowledge entries so humans can diff or restore
  edits made by agents.
- **Bulk issue actions and non-blocking relations.** Multi-select bulk updates on the board/list
  (status, priority, labels, Trash) and lightweight `duplicate` / `relates_to` links alongside
  Orrery's acyclic `blocked_by` dependency graph.

### Workflow extensibility invariant

If future teams request custom display names for workflow columns, any customization must remain
anchored to Orrery's fixed semantic state groups (`backlog`, `todo`, `in_progress`, `review`,
`done`, `cancelled`). Keeping the underlying semantic groups fixed ensures `ready_work`,
`stop_session(outcome: "review" | "done")`, Postgres constraints, and cross-workspace **My work**
queries stay predictable across every project and harness.

## Explicit non-goals

To keep Orrery fast to deploy, easy to reason about, and sharp for human + agent collaboration, we
explicitly avoid:

- **Multi-service infrastructure sprawl.** No mandatory Redis/Valkey, RabbitMQ/Kafka, external
  background worker fleets, object-storage clusters, or separate real-time collaboration servers.
  Keep Postgres as the single durable coordination backbone.
- **A full collaborative wiki.** Rich multi-cursor document editing and Obsidian-style vaults (the
  dropped M5 Shared vault) pull focus away from issue execution. Project context stays lightweight
  Markdown knowledge optimized for both humans and agent retrieval
  ([#140](https://github.com/forge-orbit/orrery/issues/140)).
- **Heavy Scrum ceremony.** Timeboxed sprint cycles, story-point estimates, velocity/burndown
  charts, Gantt timelines, and personal sticky notes optimize for traditional human sprint planning
  rather than continuous agent queues and human review handoffs.
- **Unconstrained per-project state machines.** Arbitrary workflow graphs without fixed semantic
  anchors break cross-project MCP tooling and formal state-machine guarantees.
