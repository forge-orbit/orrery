---
status: accepted
---

# Soft-delete issues and knowledge entries with 30-day in-place tombstone scrubbing

Teams need a safety net against accidental issue deletion, especially on boards shared with autonomous agents. At the same time, Orrery enforces strict database-level audit integrity: `project_activity` requires a non-null `issue_id` foreign key for every `issue_*` event, and project issue numbering (`ORR-42`) must never be reused or broken.

Deleting an issue is a **human-only** operation (`Contribute` or `Manage`; agents cannot delete issues) that sets `deleted_at` rather than removing the row. Soft-deleting an issue that holds an active work session is rejected (`409`) until the session is stopped or released. Soft-deleted issues are excluded from the board, search, `list_ready_work`, and `blocked_by` checks. A Project manager (`Manage`) can restore a soft-deleted issue within 30 days. After 30 days, a background sweep scrubs mutable content in place — clearing the issue body, deleting its comments, links, labels, and dependencies, and setting `purged_at` so it can no longer be restored — while retaining the minimal tombstoned `issues` row.

Hard-deleting rows after 30 days was rejected because it would force either cascading deletes through `project_activity` (destroying audit history) or relaxing the `project_activity_target_matches_type` constraint with `ON DELETE SET NULL`. Retaining a scrubbed tombstone keeps every database invariant, audit reference, and historical issue number intact while still removing user content after the retention window.

Knowledge entries follow the same rules on their own columns: `knowledge_entries.deleted_at`, `deleted_by_human_id`, and `purged_at` with the same CHECK constraints, `knowledge_deleted` / `knowledge_restored` activity events, and one shared purge sweep. Deleting is human-only (`Contribute` or `Manage`), restoring requires `Manage`, deleted entries disappear from `list_knowledge` and `get_knowledge`, and the purge scrubs the title and body in place. Attachment rows stay referenced (and `syncReferences` is skipped) until the purge, when `purgeHolders` releases them so the object-storage sweep can reclaim the blobs. There is no MCP delete tool: agents cannot trash knowledge.
