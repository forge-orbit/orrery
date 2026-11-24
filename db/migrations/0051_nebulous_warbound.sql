CREATE TABLE "dispatch_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"runner_host_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"dispatch_id" text NOT NULL,
	"dispatch_attempt_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"run_id" text NOT NULL,
	"work_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "dispatch_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "dispatch_tokens_token_hash_format" CHECK ("dispatch_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "runner_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"requested_by_human_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"dispatch_attempt_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"run_id" text,
	"work_session_id" text,
	"last_up_seq" integer DEFAULT 0 NOT NULL,
	"last_down_seq" integer DEFAULT 0 NOT NULL,
	"branch_name" text,
	"dirty_worktree" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "runner_dispatches_state" CHECK ("runner_dispatches"."state" in ('pending', 'active', 'uncertain', 'ended')),
	CONSTRAINT "runner_dispatches_sequence_nonnegative" CHECK ("runner_dispatches"."last_up_seq" >= 0 and "runner_dispatches"."last_down_seq" >= 0),
	CONSTRAINT "runner_dispatches_accepted_fields" CHECK (("runner_dispatches"."state" = 'pending' and "runner_dispatches"."accepted_at" is null and "runner_dispatches"."run_id" is null and "runner_dispatches"."work_session_id" is null)
          or ("runner_dispatches"."state" in ('active', 'uncertain', 'ended') and "runner_dispatches"."accepted_at" is not null and "runner_dispatches"."run_id" is not null and "runner_dispatches"."work_session_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_runner_host_id_runner_hosts_id_fk" FOREIGN KEY ("runner_host_id") REFERENCES "public"."runner_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_dispatch_id_runner_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."runner_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_tokens" ADD CONSTRAINT "dispatch_tokens_work_session_id_work_sessions_id_fk" FOREIGN KEY ("work_session_id") REFERENCES "public"."work_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_requested_by_human_id_humans_id_fk" FOREIGN KEY ("requested_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_work_session_id_work_sessions_id_fk" FOREIGN KEY ("work_session_id") REFERENCES "public"."work_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_tokens_hash_created" ON "dispatch_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "dispatch_tokens_dispatch_created" ON "dispatch_tokens" USING btree ("dispatch_id","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_tokens_session_active" ON "dispatch_tokens" USING btree ("work_session_id") WHERE "dispatch_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_dispatches_one_attempt" ON "runner_dispatches" USING btree ("dispatch_attempt_id");--> statement-breakpoint
CREATE INDEX "runner_dispatches_runner_created" ON "runner_dispatches" USING btree ("runner_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_dispatches_issue_created" ON "runner_dispatches" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_dispatches_pending_runner" ON "runner_dispatches" USING btree ("runner_id") WHERE "runner_dispatches"."state" = 'pending';