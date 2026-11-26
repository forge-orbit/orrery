ALTER TABLE "runner_dispatches" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_options_bounded" CHECK (("runner_dispatches"."harness" is null or char_length("runner_dispatches"."harness") between 1 and 64)
          and ("runner_dispatches"."model" is null or char_length("runner_dispatches"."model") between 1 and 200)
          and ("runner_dispatches"."effort" is null or char_length("runner_dispatches"."effort") between 1 and 64));