ALTER TABLE "runner_dispatches" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_option_lengths" CHECK (length("runner_dispatches"."harness") <= 64 and length("runner_dispatches"."model") <= 200 and length("runner_dispatches"."effort") <= 64);