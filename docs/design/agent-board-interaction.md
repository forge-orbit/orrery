# Agent board interaction

> **Status: partially implemented (MVP complete).** Sections 1–3 and 5 shipped across M2–M4 and M6 ([#3](https://github.com/forge-orbit/orrery/issues/3), [#4](https://github.com/forge-orbit/orrery/issues/4), [#5](https://github.com/forge-orbit/orrery/issues/5), [#7](https://github.com/forge-orbit/orrery/issues/7)). Section 4 (the M5 Obsidian-like vault link index) was dropped when [M5 (#6)](https://github.com/forge-orbit/orrery/issues/6) was closed as not planned; lightweight doc↔issue linking is tracked post-MVP in [#140](https://github.com/forge-orbit/orrery/issues/140).

## Context

Orrery tracks local coding agents (Claude Code CLI, Codex CLI, Cursor) running on team members' machines. Agents connect over MCP or REST, claim issues atomically with renewable five-minute leases, report runs and subagents, and ask humans questions through the needs-input inbox ([Identity and work sessions spec](./mvp-spec.md)).

By contrast, Plane's commercial Agent Runs model is **push/webhook-driven**: a human `@mentions` or assigns a bot user on an issue, Plane sends an HMAC-signed webhook to an external HTTP server, and the agent posts back ephemeral `thought`/`action` activities (shown in a sidecar inspector) alongside permanent comments.

Orrery should **keep its pull/MCP + atomic claim-lease core** — local agents behind NAT do not expose public webhook endpoints, and Orrery's claim exclusivity, subagent attribution, and fallback policies already solve harder coordination problems. However, four concrete patterns from Plane materially improve how agents connect to the board and vault without compromising Orrery's lightweight self-hosted design.

## 1. Ephemeral session telemetry vs. permanent comments

Currently, a work session stores a single mutable `progress` summary while issue discussions live in `issue_comments`. Without a structured split, active agents either spam the comment thread with noisy step-by-step updates or appear opaque until they finish.

**Planned change (M3 #4, M4 #5, #15):**

- Separate **ephemeral session activities** from **permanent issue comments**:
  - **Session activities (`thought`, `action`, `status`)**: append-only telemetry tied to a `work_session` (and optional child worker / run), using a simple typed payload (`kind: "thought" | "action" | "status"`, `summary`, and optional structured `detail` JSON). Rendered live in a **sidecar inspector** on the issue view and agents panel, never mixed into the permanent comment feed.
  - **Permanent comments**: reserved for human↔agent conversation, handoff summaries, review notes, and final responses.
- Keep session activities independent of the claim lease (like `progress` today), so an expired or interrupted session still preserves its execution trail for debugging.
- Keep `detail` extensible so the structured block renderer proposed in [#15](https://github.com/forge-orbit/orrery/issues/15) can plug into `action` entries and final comments later without blocking MVP.
- **Live updates (agreed):** poll via TanStack Query every 3–5 seconds for MVP (no SSE/WebSocket connection state yet; upgradeable later).

## 2. Human stop/cancel signal via heartbeat

Today, if a human watches an active agent take the wrong direction on the board, the only ways to stop it are revoking its API key or waiting five minutes for the lease to expire.

**Planned change (M3 #4, M4 #5):**

- Add a human-initiated **stop request** on an active `work_session` (recording `stopRequestedAt`, `stopRequestedBy`, and an optional reason), available to humans with Contribute or Manage access on the project.
- Surface the session as **`stopping`** on the board and agents panel until the agent acknowledges it or the lease expires.
- Return `stopRequested: true` (and the reason) in the response to `renew` / heartbeat and `report_progress` calls so pull-based MCP agents detect the cancellation cleanly, flush a brief handoff summary, and end the session.
- Keep the existing five-minute lease as the hard backstop: if the agent ignores or misses the stop signal, the lease still expires normally in database time.

## 3. Board assignment as a pull-queue hint *(superseded by [ADR-0013](../adr/0013-human-only-issue-assignees-and-owner-delegation.md))*

> **Superseded:** Issue [#276](https://github.com/forge-orbit/orrery/issues/276) and [ADR-0013](../adr/0013-human-only-issue-assignees-and-owner-delegation.md) replace polymorphic human/agent assignees with human-only `assignee_human_id`, allow any **Agent** owned by the assigned **Human** to claim or be dispatched the issue, and replace agent-assignee pull-queue routing with owner-human scoping plus **Label** filtering (`ready-for-agent` default for `--auto-claim`).

Today, `list_ready_work` returns open issues without an active session that are not in Needs input. Humans have no board-level way to steer a specific issue toward a specific registered agent.

**Planned change (M2 #3, M3 #4, M4 #5):**

- Allow an issue's assignee on the board to be a **human or a registered agent** in the workspace.
- Treat agent assignment as a **pull-queue hint**, not a server-side launch trigger:
  - Assigning an issue to an agent does not start a process or send a webhook.
  - `list_ready_work` supports filtering and prioritizing issues assigned to the calling agent (as well as unassigned ready issues).
- Keep the atomic claim lease authoritative: assignment never replaces a claim, and two sessions still cannot claim the same issue.
- **Strict claim policy (agreed):** an agent may claim an issue only if it is unassigned or assigned to that agent. Claims on issues assigned to a human or to another registered agent are rejected until reassigned.

## 4. Structured backlink index for the Vault *(dropped with M5 #6 → post-MVP #140)*

Plane maintains a dedicated link/mention log (`PageLog`) for forward links, backlinks, and issue references so graph and backlink lookups are indexed SQL queries rather than full-text scans.

**Decision (superseded):**

- [M5 (#6)](https://github.com/forge-orbit/orrery/issues/6) (the Obsidian-like vault with `[[wikilinks]]` and folder paths) was dropped as not planned.
- Lightweight explicit doc↔issue linking on top of existing `knowledge_entries` (without Obsidian `[[wikilinks]]` or vault syntax) is tracked as a post-MVP proposal in [#140](https://github.com/forge-orbit/orrery/issues/140).

## 5. Agent-ready queue primitives (blocking, ordering, links)

Three small data-model primitives from Plane directly improve autonomous agent execution without adding Agile ceremony:

- **Blocking dependencies (`blocked_by`, M2 #3 / M3 #4):** Store directed `issue_dependencies(issue_id, blocked_by_issue_id)` edges (preventing self-links and cycles). `list_ready_work` excludes any issue that has an open blocker, so agents never claim downstream work prematurely.
- **Priority and float `sort_order` (M2 #3 / M4 #5):** Add `priority` (`urgent | high | medium | low | none`) and a floating-point `sort_order` to `issues`. Dragging a card on the board updates one row, and `list_ready_work` orders ready issues deterministically (assigned-to-self first, then priority, then `sort_order`).
- **Structured `issue_links` (M2 #3 / M6 #7):** Store external links (`url`, `title`, `kind: pr | commit | doc | link`) in a dedicated `issue_links` table so agents and humans attach PRs and branches cleanly over REST and MCP instead of burying URLs in Markdown comments.

## Explicitly deferred (post-MVP)

- **`@mention` comment triggers and outbound webhooks:** For local agents running on laptops, `@mentioning` an offline agent in a comment creates a broken expectation ("I mentioned it and nothing happened"), and reliable webhooks require SSRF validation, HMAC signing, retry queues, and delivery logs. Revisit only when hosted/always-on remote agents are in scope.
- **Custom project workflows / state groups:** Plane's `StateGroup` model supports arbitrary custom states per project. For MVP, Orrery's fixed workflow (`Backlog → Todo → In progress → Needs input → Review → Done`) is a deliberate advantage for agents because every project exposes predictable state transitions without per-project state discovery.
- **Human-centric PM ceremony:** Cycles (sprints), modules, external intake portals, saved rich-filter views (deferred to v1.1 #15), estimates/story points, draft issues, reactions, votes, stickies, and CRDT live servers stay out of MVP.

## Related issues

- [#4 — M3: Agent API and sessions](https://github.com/forge-orbit/orrery/issues/4)
- [#5 — M4: Board, agents panel and needs-input inbox](https://github.com/forge-orbit/orrery/issues/5)
- [#6 — M5: Shared vault (closed, not planned)](https://github.com/forge-orbit/orrery/issues/6)
- [#140 — Post-MVP agent-memory upgrades for project knowledge](https://github.com/forge-orbit/orrery/issues/140)
- [#15 — Agent-customizable UI and rich content](https://github.com/forge-orbit/orrery/issues/15)
- Delivery slices: [#82](https://github.com/forge-orbit/orrery/issues/82) (human stop signal), [#83](https://github.com/forge-orbit/orrery/issues/83) (ephemeral session activities & sidecar), [#84](https://github.com/forge-orbit/orrery/issues/84) (agent assignment & board/agents panel), [#86](https://github.com/forge-orbit/orrery/issues/86) (blocking dependencies in ready work), [#87](https://github.com/forge-orbit/orrery/issues/87) (structured issue links), [#88](https://github.com/forge-orbit/orrery/issues/88) (priority & `sortOrder` ordering)
