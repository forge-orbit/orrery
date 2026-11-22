CREATE TABLE "stored_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stored_objects_key_unique" UNIQUE("key"),
	CONSTRAINT "stored_objects_status" CHECK ("stored_objects"."status" in ('pending', 'active', 'deleted')),
	CONSTRAINT "stored_objects_byte_size_positive" CHECK ("stored_objects"."byte_size" > 0),
	CONSTRAINT "stored_objects_sha256_format" CHECK ("stored_objects"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stored_objects_key_relative" CHECK ("stored_objects"."key" !~ '^/' and "stored_objects"."key" !~ '(^|/)\.\.(/|$)' and "stored_objects"."key" !~ '\\'),
	CONSTRAINT "stored_objects_deleted_at_matches_status" CHECK (("stored_objects"."status" = 'deleted') = ("stored_objects"."deleted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "humans" ADD COLUMN "avatar_object_id" text;--> statement-breakpoint
ALTER TABLE "humans" ADD CONSTRAINT "humans_avatar_object_id_stored_objects_id_fk" FOREIGN KEY ("avatar_object_id") REFERENCES "public"."stored_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_human_per_avatar_object" ON "humans" USING btree ("avatar_object_id");