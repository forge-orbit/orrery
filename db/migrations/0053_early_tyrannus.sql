CREATE TABLE "work_session_stream_chunks" (
	"work_session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'project_readers' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_session_stream_chunks_work_session_id_seq_pk" PRIMARY KEY("work_session_id","seq"),
	CONSTRAINT "work_session_stream_chunks_seq_positive" CHECK ("work_session_stream_chunks"."seq" > 0),
	CONSTRAINT "work_session_stream_chunks_kind" CHECK ("work_session_stream_chunks"."kind" in ('event', 'diagnostic', 'raw_output')),
	CONSTRAINT "work_session_stream_chunks_visibility" CHECK ("work_session_stream_chunks"."visibility" in ('project_readers', 'owner_only'))
);
--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "stream_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "stream_batch_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD COLUMN "needs_human_resolution" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stream_object_id" text;--> statement-breakpoint
ALTER TABLE "work_session_stream_chunks" ADD CONSTRAINT "work_session_stream_chunks_work_session_id_work_sessions_id_fk" FOREIGN KEY ("work_session_id") REFERENCES "public"."work_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_stream_object_id_stored_objects_id_fk" FOREIGN KEY ("stream_object_id") REFERENCES "public"."stored_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_dispatches" ADD CONSTRAINT "runner_dispatches_stream_batch_count_nonnegative" CHECK ("runner_dispatches"."stream_batch_count" >= 0);