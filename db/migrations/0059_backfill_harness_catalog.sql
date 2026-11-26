-- Custom backfill (AGENTS.md): main's 0058 added harness_catalog as nullable.
UPDATE "runners" SET "harness_catalog" = '{"harnesses":[],"probedAt":"1970-01-01T00:00:00.000Z"}'::jsonb WHERE "harness_catalog" is null;
