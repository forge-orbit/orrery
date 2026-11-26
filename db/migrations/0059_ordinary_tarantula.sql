UPDATE "runners" SET "harness_catalog" = '{"harnesses":[],"probedAt":"1970-01-01T00:00:00.000Z"}'::jsonb WHERE "harness_catalog" is null;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "harness_catalog" SET DEFAULT '{"harnesses":[],"probedAt":"1970-01-01T00:00:00.000Z"}'::jsonb;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "harness_catalog" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "execution_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_option_lengths" CHECK (length("runner_dispatches"."harness") <= 64 and length("runner_dispatches"."model") <= 200 and length("runner_dispatches"."effort") <= 64);