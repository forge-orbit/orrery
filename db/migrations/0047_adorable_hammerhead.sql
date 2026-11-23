ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "humans" ADD COLUMN "handle" text;--> statement-breakpoint
CREATE UNIQUE INDEX "humans_handle_unique" ON "humans" USING btree (lower("handle"));--> statement-breakpoint
ALTER TABLE "humans" ADD CONSTRAINT "humans_handle_valid" CHECK ("humans"."handle" ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' and char_length("humans"."handle") between 2 and 39);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('handoff', 'needs_input', 'session_expired', 'issue_mentioned'));