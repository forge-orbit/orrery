ALTER TABLE "issues" DROP CONSTRAINT "issues_assignee_pair";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_assignee_type";--> statement-breakpoint
DROP INDEX "issues_assignee";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_human_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_human_id_humans_id_fk" FOREIGN KEY ("assignee_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_assignee_human" ON "issues" USING btree ("assignee_human_id");--> statement-breakpoint
-- #281: backfill before the polymorphic columns drop. A human assignee keeps
-- their id; an agent assignee becomes its owner human. Rows whose id no longer
-- resolves (no human, no agent) fall back to unassigned instead of failing the
-- new foreign key. project_activity.changes is untouched, so legacy agent
-- assignee diffs stay readable.
UPDATE "issues" SET "assignee_human_id" = "assignee_id"
WHERE "assignee_type" = 'human'
  AND EXISTS (SELECT 1 FROM "humans" h WHERE h."id" = "issues"."assignee_id");--> statement-breakpoint
UPDATE "issues" SET "assignee_human_id" = (
  SELECT a."human_id" FROM "agents" a WHERE a."id" = "issues"."assignee_id"
)
WHERE "assignee_type" = 'agent'
  AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = "issues"."assignee_id");--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "assignee_type";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "assignee_id";