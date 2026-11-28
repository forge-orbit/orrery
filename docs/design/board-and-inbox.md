# Board, agents panel, needs-input inbox, and My work

Product and engineering decisions are agreed for M4 ([#5](https://github.com/forge-orbit/orrery/issues/5)), building on [Identity, workspaces, and agent work sessions](./mvp-spec.md), [Agent board interaction](./agent-board-interaction.md), [Projects and issues](./projects-and-issues.md), and [Agent API and sessions](./agent-api-and-sessions.md).

## Problem Statement

Humans need one place to see and steer all human and agent work: staging work on a six-column workflow board, filtering by labels and human assignees, inspecting structured `v1` session activity blocks and optional session cost in the sidecar inspector, rendering GFM Markdown and Mermaid diagrams safely in issue bodies and comments, and viewing all of their personal work and pending agent questions across workspaces in a single "My work" view.

## Solution

Provide the M4 human steering surfaces and supporting read endpoints:

- A six-column project board (`Backlog`, `Todo`, `In progress`, `Review`, `Done`, `Cancelled`) plus a derived `Needs input` indicator/filter, project key (`ORR-42`) badges, label filters, a human-only assignee filter (`Any assignee`, `Unassigned`, `Human`), one-level subtask display (with an open-subtask warning on parent close), and trash management (soft-delete and Project manager restore). Agent execution is surfaced through live **Work session** indicators, never through assignee options.
- Safe GFM Markdown + Mermaid diagram rendering in issue bodies and comments (no raw HTML), and built-in renderers for the four `v1` `work_session_activities.detail.block` types (`key_value`, `table`, `checklist`, `test_results`) with a collapsible JSON fallback in the sidecar session inspector.
- Optional token usage and cost display on the agents panel and session inspector (hidden when `null`).
- A cross-workspace "My work" endpoint and view aggregating the signed-in human's open assigned issues, active work sessions running under their registered agents, and open/paused `needs_input` questions on projects where they hold `Contribute` or `Manage`.

## User Stories

### Six-column board, labels, subtasks, and trash

1. As a human member, I want to view and filter a project's issues across the six workflow states (`backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`) and by `needs_input`, assignee (a Human, Unassigned, or any assignee — never an Agent), priority, and label, so that I can steer project work from one board or list. Active Agent execution stays visible through live Work session indicators.
2. As a human contributor, I want every issue card and detail page to display its `<PROJECT_KEY>-<NUMBER>` identifier (such as `ORR-42`), so that I can reference issues consistently.
3. As a human contributor, I want to see one-level subtasks on the parent issue and receive a non-blocking confirmation warning if I close a parent issue that still has open subtasks, so that unfinished subtasks are not overlooked.
4. As a human contributor, I want to move an unclaimed issue to trash, and as a project manager (`Manage`), I want to view the project's 30-day trash and restore soft-deleted issues, so that mistakes are easy to undo.

### Rich content, sidecar inspector, and cost display

5. As a human member, I want issue descriptions and comments to render GFM Markdown (tables, task lists, code blocks) and fenced `mermaid` diagrams without rendering raw HTML, so that documentation and diagrams are readable and safe from XSS.
6. As a human member, I want the sidecar session inspector to render `v1` `detail.block` payloads (`key_value`, `table`, `checklist`, `test_results`) as structured UI components and fall back to a collapsible JSON viewer for other JSON payloads, so that agent execution telemetry is easy to scan.
7. As a human member, I want the agents panel and session inspector to display reported `input_tokens`, `output_tokens`, and formatted USD cost (`cost_usd_micros`) when present and hide them when `null`, so that cost visibility never shows fake zeroes.

### Cross-workspace "My work" view

8. As a signed-in human, I want a single cross-workspace "My work" page showing:
   - Open (non-deleted, non-terminal) issues assigned to me across all projects I can read,
   - Active work sessions currently running under my registered agents, and
   - Open or paused `needs_input` questions on projects where I hold `Contribute` or `Manage` access,
   so that I have one daily home screen across all my workspaces.

## Implementation Decisions

### Cross-workspace "My work" API

- Add an authenticated REST endpoint (`GET /api/my-work`) returning three lists scoped strictly by the caller's current effective workspace and project permissions (excluding deactivated memberships or revoked grants):
  1. `assignedIssues`: non-deleted issues with `status NOT IN ('done', 'cancelled')` assigned to `caller.humanId` on projects where the caller has at least `Read`.
  2. `activeAgentSessions`: active `work_sessions` belonging to agents owned by `caller.humanId` on projects where the caller has at least `Read`, including issue identifier (`<KEY>-<NUMBER>`), title, harness/model, `stopRequestedAt`, and optional token/cost fields.
  3. `needsInputQuestions`: `questions` with `status IN ('open', 'paused')` on non-deleted issues in projects where the caller has `Contribute` or `Manage`.

### Board, issue detail, and inspector behavior

- Keep live updates on the board, agents panel, needs-input inbox, and "My work" view on 3–5 second TanStack Query polling for MVP.
- **Assignees are human-only:** the board's assignee filter offers `Any assignee`, `Unassigned`, and `Human` (no `Any agent`), and the issue list's assignee filter offers `Any human`, `Unassigned`, and named humans. Live Agent execution shows up as a session-state badge and working-Agent avatar on cards, and in the sidecar inspector, so filters never mix accountability with execution.
- Render Markdown through a strict GFM + Mermaid pipeline that strips or escapes raw HTML.
- Implement a renderer registry for `work_session_activities.detail.block` (`version: 1`) handling `key_value`, `table`, `checklist`, and `test_results`, with an automatic collapsible JSON fallback for any unversioned or unrecognized `detail` object.
- Visual layout, navigation shell, and component styling for M4 screens will follow the MVP UI design spec before slicing `area:ui` implementation tickets.

## Testing Decisions

- **Real-Postgres service tests**:
  - `my-work` query: returns only non-deleted, non-terminal issues assigned to the human, active sessions for the human's agents, and open/paused questions on projects where the human has `Contribute` or `Manage`; verifies immediate exclusion when project access is revoked or a workspace membership is suspended.
- **Black-box e2e & Playwright browser tests** (once UI tickets are built):
  - Verify six-column board transitions, `<KEY>-<NUMBER>` display, label filtering, subtask creation and parent-close warning, soft-delete/restore flow, Mermaid and `v1` activity block rendering (plus XSS non-execution for raw HTML), optional cost badge display, and the cross-workspace "My work" view.

## Out of Scope

- WebSockets or Server-Sent Events (3–5s polling is used for MVP).
- Custom ` ```orrery-ui ` DSL, user-saved filter views, personal layout reordering, and plugin slots (`#15` Levels 2–4, deferred to v1.1+).

## Further Notes

- Spec for [#5 — \[MVP\] M4: Board, agents panel and needs-input inbox](https://github.com/forge-orbit/orrery/issues/5).
- Backend API slice (`GET /api/my-work`) can be ticketed immediately; frontend `area:ui` tickets for M4 should be sliced after the UI design grill.
