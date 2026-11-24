CREATE TABLE "runner_device_code_attempts" (
	"human_id" text PRIMARY KEY NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_device_code_attempts_count_bounded" CHECK ("runner_device_code_attempts"."failed_count" >= 0 and "runner_device_code_attempts"."failed_count" <= 5)
);
--> statement-breakpoint
CREATE TABLE "runner_device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"verifier_hash" text NOT NULL,
	"host_display_name" text NOT NULL,
	"platform" text NOT NULL,
	"human_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_device_codes_device_code_hash_format" CHECK ("runner_device_codes"."device_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "runner_device_codes_verifier_hash_format" CHECK ("runner_device_codes"."verifier_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "runner_device_codes_user_code_format" CHECK ("runner_device_codes"."user_code" ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
	CONSTRAINT "runner_device_codes_failed_attempts_bounded" CHECK ("runner_device_codes"."failed_attempts" >= 0 and "runner_device_codes"."failed_attempts" <= 5),
	CONSTRAINT "runner_device_codes_human_when_approved" CHECK ("runner_device_codes"."approved_at" is null or "runner_device_codes"."human_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "runner_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"credential_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_hosts_display_name_valid" CHECK (btrim("runner_hosts"."display_name") <> '' and char_length("runner_hosts"."display_name") <= 120),
	CONSTRAINT "runner_hosts_platform_valid" CHECK ("runner_hosts"."platform" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "runner_hosts_credential_hash_format" CHECK ("runner_hosts"."credential_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"display_name" text NOT NULL,
	"repo_fingerprint" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"active_slot_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_display_name_valid" CHECK (btrim("runners"."display_name") <> '' and char_length("runners"."display_name") <= 120),
	CONSTRAINT "runners_repo_fingerprint_format" CHECK ("runners"."repo_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "runners_max_concurrency_bounded" CHECK ("runners"."max_concurrency" between 1 and 64),
	CONSTRAINT "runners_active_slot_count_bounded" CHECK ("runners"."active_slot_count" >= 0 and "runners"."active_slot_count" <= "runners"."max_concurrency")
);
--> statement-breakpoint
ALTER TABLE "runner_device_code_attempts" ADD CONSTRAINT "runner_device_code_attempts_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_device_codes" ADD CONSTRAINT "runner_device_codes_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_hosts" ADD CONSTRAINT "runner_hosts_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_host_id_runner_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runner_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_device_codes_pending_user_code" ON "runner_device_codes" USING btree ("user_code") WHERE "runner_device_codes"."used_at" is null;--> statement-breakpoint
CREATE INDEX "runner_device_codes_device_code_hash" ON "runner_device_codes" USING btree ("device_code_hash");--> statement-breakpoint
CREATE INDEX "runner_hosts_human_id" ON "runner_hosts" USING btree ("human_id");--> statement-breakpoint
CREATE INDEX "runner_hosts_active_human" ON "runner_hosts" USING btree ("human_id") WHERE "runner_hosts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "runners_host_id" ON "runners" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "runners_workspace_id" ON "runners" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "runners_project_id" ON "runners" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runners_active_last_seen" ON "runners" USING btree ("last_seen_at") WHERE "runners"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_one_per_host_workspace_project_fingerprint" ON "runners" USING btree ("host_id","workspace_id","project_id","repo_fingerprint") WHERE "runners"."revoked_at" is null;