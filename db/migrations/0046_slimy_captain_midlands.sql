CREATE TABLE "attachment_references" (
	"id" text PRIMARY KEY NOT NULL,
	"attachment_id" text NOT NULL,
	"holder_type" text NOT NULL,
	"holder_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_references_holder_type" CHECK ("attachment_references"."holder_type" in ('issue', 'comment', 'knowledge'))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"object_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by_human_id" text,
	"uploaded_by_agent_id" text,
	"unreferenced_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_uploaded_by_actor" CHECK (("attachments"."uploaded_by_human_id" is not null) <> ("attachments"."uploaded_by_agent_id" is not null)),
	CONSTRAINT "attachments_byte_size_positive" CHECK ("attachments"."byte_size" > 0),
	CONSTRAINT "attachments_filename_sanitized" CHECK (length("attachments"."filename") between 1 and 255 and "attachments"."filename" !~ '[[:cntrl:]/\\]')
);
--> statement-breakpoint
ALTER TABLE "attachment_references" ADD CONSTRAINT "attachment_references_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_object_id_stored_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."stored_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_human_id_humans_id_fk" FOREIGN KEY ("uploaded_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_agent_id_agents_id_fk" FOREIGN KEY ("uploaded_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_reference_per_holder_attachment" ON "attachment_references" USING btree ("holder_type","holder_id","attachment_id");--> statement-breakpoint
CREATE INDEX "attachment_references_attachment" ON "attachment_references" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "attachments_project_created" ON "attachments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_unreferenced" ON "attachments" USING btree ("unreferenced_at");