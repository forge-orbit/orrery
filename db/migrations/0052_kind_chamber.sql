CREATE TABLE "runner_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"dispatch_id" text NOT NULL,
	"dispatch_attempt_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "runner_commands_seq_positive" CHECK ("runner_commands"."seq" > 0),
	CONSTRAINT "runner_commands_kind" CHECK ("runner_commands"."kind" in ('dispatch', 'cancel', 'input_resolved')),
	CONSTRAINT "runner_commands_expires_after_created" CHECK ("runner_commands"."expires_at" > "runner_commands"."created_at")
);
--> statement-breakpoint
ALTER TABLE "runner_dispatches" DROP CONSTRAINT "runner_dispatches_accepted_fields";--> statement-breakpoint
ALTER TABLE "runner_commands" ADD CONSTRAINT "runner_commands_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_commands" ADD CONSTRAINT "runner_commands_dispatch_id_runner_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."runner_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_runner_command_seq_per_runner" ON "runner_commands" USING btree ("runner_id","seq");--> statement-breakpoint
CREATE INDEX "runner_commands_runner_unacked" ON "runner_commands" USING btree ("runner_id","seq") WHERE "runner_commands"."acked_at" is null;--> statement-breakpoint
CREATE INDEX "runner_commands_attempt_kind" ON "runner_commands" USING btree ("dispatch_attempt_id","kind");--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_accepted_fields" CHECK (("runner_dispatches"."state" = 'pending' and "runner_dispatches"."accepted_at" is null and "runner_dispatches"."run_id" is null and "runner_dispatches"."work_session_id" is null)
          or ("runner_dispatches"."state" in ('active', 'uncertain') and "runner_dispatches"."accepted_at" is not null and "runner_dispatches"."run_id" is not null and "runner_dispatches"."work_session_id" is not null)
          or ("runner_dispatches"."state" = 'ended' and ((("runner_dispatches"."accepted_at" is not null) and ("runner_dispatches"."run_id" is not null) and ("runner_dispatches"."work_session_id" is not null))
            or (("runner_dispatches"."accepted_at" is null) and ("runner_dispatches"."run_id" is null) and ("runner_dispatches"."work_session_id" is null)))));