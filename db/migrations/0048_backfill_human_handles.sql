-- #183: 0047 added the nullable handle column, its format CHECK and the
-- case-insensitive unique index. This migration backfills legacy rows, makes the
-- column NOT NULL and installs a BEFORE INSERT trigger so setup, registration and
-- directly-seeded rows all receive a handle derived from the email local part.
-- Collisions get -2, -3, … suffixes and never exceed 39 characters.
CREATE OR REPLACE FUNCTION orrery_human_handle_for(p_email text, p_exclude_id text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  base text;
  candidate text;
  suffix int := 2;
  suffix_text text;
BEGIN
  base := regexp_replace(lower(split_part(p_email, '@', 1)), '[^a-z0-9-]+', '-', 'g');
  base := regexp_replace(base, '-{2,}', '-', 'g');
  base := btrim(base, '-');
  IF char_length(base) < 2 THEN
    base := 'user';
  END IF;
  base := left(base, 39);
  base := rtrim(base, '-');
  IF char_length(base) < 2 THEN
    base := 'user';
  END IF;
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM humans h
    WHERE lower(h.handle) = lower(candidate)
      AND (p_exclude_id IS NULL OR h.id <> p_exclude_id)
  ) LOOP
    suffix_text := '-' || suffix::text;
    candidate := rtrim(left(base, 39 - char_length(suffix_text)) || suffix_text, '-');
    suffix := suffix + 1;
  END LOOP;
  RETURN candidate;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  row_to_fill record;
BEGIN
  FOR row_to_fill IN
    SELECT id, email FROM humans WHERE handle IS NULL ORDER BY created_at, id
  LOOP
    UPDATE humans
    SET handle = orrery_human_handle_for(row_to_fill.email, row_to_fill.id)
    WHERE id = row_to_fill.id;
  END LOOP;
END;
$$;
--> statement-breakpoint
ALTER TABLE "humans" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION orrery_assign_human_handle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handle IS NULL THEN
    NEW.handle := orrery_human_handle_for(NEW.email, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER humans_assign_handle BEFORE INSERT ON humans FOR EACH ROW EXECUTE FUNCTION orrery_assign_human_handle();
