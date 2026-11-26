-- Custom backfill (AGENTS.md): main's 0058 added harness_catalog as nullable
-- with PR #255's legacy shape (updatedAt, nullable defaultModel/probedAt/defaultEffort,
-- effortLevels). Backfill NULLs and normalize existing PR #255 rows in-place so
-- every row satisfies PR #260's non-null HarnessCatalog contract on upgrade.
UPDATE "runners"
SET "harness_catalog" = '{"harnesses":[],"probedAt":"1970-01-01T00:00:00.000Z"}'::jsonb
WHERE "harness_catalog" IS NULL
   OR jsonb_typeof("harness_catalog") <> 'object'
   OR jsonb_typeof("harness_catalog"->'harnesses') <> 'array';--> statement-breakpoint
UPDATE "runners"
SET "harness_catalog" = jsonb_build_object(
  'probedAt',
  COALESCE(NULLIF("harness_catalog"->>'updatedAt', ''), '1970-01-01T00:00:00.000Z'),
  'harnesses',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', NULLIF(btrim(h->>'id'), ''),
            'displayName', COALESCE(NULLIF(btrim(h->>'displayName'), ''), NULLIF(btrim(h->>'id'), '')),
            'source', CASE WHEN h->>'source' IN ('preset', 'override', 'user') THEN h->>'source' ELSE NULL END,
            'defaultModel', COALESCE(
              NULLIF(btrim(h->>'defaultModel'), ''),
              (
                SELECT NULLIF(btrim(m0->>'id'), '')
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(h->'models') = 'array' THEN h->'models' ELSE '[]'::jsonb END
                ) AS m0
                WHERE NULLIF(btrim(m0->>'id'), '') IS NOT NULL
                LIMIT 1
              ),
              'default'
            ),
            'probedAt', COALESCE(
              NULLIF(h->>'probedAt', ''),
              NULLIF("harness_catalog"->>'updatedAt', ''),
              '1970-01-01T00:00:00.000Z'
            ),
            'models', COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_strip_nulls(
                    jsonb_build_object(
                      'id', NULLIF(btrim(m->>'id'), ''),
                      'label', NULLIF(btrim(m->>'label'), ''),
                      'reasoningDiscovery', CASE WHEN m->>'reasoningDiscovery' = 'known' THEN 'known' ELSE 'unknown' END,
                      'supportedEfforts', CASE
                        WHEN jsonb_typeof(m->'supportedEfforts') = 'array' THEN m->'supportedEfforts'
                        WHEN jsonb_typeof(m->'effortLevels') = 'array' THEN m->'effortLevels'
                        ELSE NULL
                      END,
                      'defaultEffort', NULLIF(btrim(m->>'defaultEffort'), ''),
                      'probedAt', NULLIF(m->>'probedAt', '')
                    )
                  )
                )
                FROM (
                  SELECT m
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(h->'models') = 'array' THEN h->'models' ELSE '[]'::jsonb END
                  ) AS m
                  WHERE jsonb_typeof(m) = 'object' AND NULLIF(btrim(m->>'id'), '') IS NOT NULL
                  LIMIT 200
                ) AS valid_models
              ),
              '[]'::jsonb
            )
          )
        )
      )
      FROM (
        SELECT h
        FROM jsonb_array_elements("harness_catalog"->'harnesses') AS h
        WHERE jsonb_typeof(h) = 'object' AND NULLIF(btrim(h->>'id'), '') IS NOT NULL
        LIMIT 64
      ) AS valid_harnesses
    ),
    '[]'::jsonb
  )
)
WHERE NOT ("harness_catalog" ? 'probedAt');
