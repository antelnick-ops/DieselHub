-- =====================================================================
-- add-product-search.sql — unified weighted FTS for products
-- =====================================================================
-- Adds a generated tsvector column (search_vector) covering name/brand/
-- category/short_description/description/fitment_text with weights A-D,
-- a GIN index on it, and the search_products() RPC the chat function
-- (and eventually the storefront) will call.
--
-- Heads-up: ADD COLUMN ... GENERATED ... STORED rewrites the table.
-- On the current ~49k-row products table this should finish in seconds
-- but it does take an ACCESS EXCLUSIVE lock for the duration. Run during
-- a quiet window if you can.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Verify what data_source values exist (RAISE NOTICE shows in SQL editor)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  rec record;
BEGIN
  RAISE NOTICE '=== Distinct data_source values in public.products ===';
  FOR rec IN
    SELECT data_source, count(*) AS n
    FROM public.products
    GROUP BY data_source
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  data_source=%  count=%', coalesce(rec.data_source, '<NULL>'), rec.n;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Generated tsvector column with weighted fields
--    A: product_name + brand   (highest)
--    B: category
--    C: short_description
--    D: description + fitment_text
-- ---------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(product_name, '') || ' ' || coalesce(brand, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(short_description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(fitment_text, '')), 'D')
  ) STORED;

-- ---------------------------------------------------------------------
-- 3. GIN index on search_vector
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_search_vector
  ON public.products USING gin (search_vector);

-- ---------------------------------------------------------------------
-- 4. search_products RPC
--    WHERE narrows on status/visibility/stock + FTS match only. Fitment
--    (engine/year/make) is rank boost, never a filter — so a customer
--    asking for "5.9 Cummins" parts still sees a strong universal hit
--    with missing fitment data, just lower-ranked than vehicle-specific.
--
--    Design note: the function is intentionally generous on candidate
--    selection — every FTS match returns, fitment is rank boost only.
--    Watch query time on broad searches (e.g. "intake" alone). If p95
--    exceeds 500ms in production, consider adding a pre-filter on
--    data_source or stage to reduce the candidate set before ranking.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_products(
  search_query  text,
  filter_engine text    DEFAULT NULL,
  filter_year   integer DEFAULT NULL,
  filter_make   text    DEFAULT NULL,
  result_limit  integer DEFAULT 10
)
RETURNS TABLE (
  id                uuid,
  sku               text,
  product_name      text,
  brand             text,
  category          text,
  price             numeric,
  short_description text,
  fitment_summary   text,
  data_source       text,
  product_url       text,
  in_stock          boolean,
  is_stocking_item  boolean,
  rank              real
)
LANGUAGE sql STABLE
AS $$
  WITH q AS (
    SELECT websearch_to_tsquery('english', search_query) AS tsq
  ),
  ranked AS (
    SELECT
      p.id,
      p.sku,
      p.product_name,
      p.brand,
      p.category,
      p.price,
      p.short_description,
      p.is_universal,
      p.fitment_makes,
      p.fitment_years,
      p.fitment_engines,
      p.data_source,
      p.in_stock,
      p.is_stocking_item,
      (
        ts_rank(p.search_vector, q.tsq)
        -- ASAP-enriched data is curated; boost it. 'merged' is the current
        -- APG+ASAP combined value; 'asap' is reserved for future ASAP-only rows.
        * CASE WHEN p.data_source IN ('merged', 'asap') THEN 2.0 ELSE 1.0 END
        -- Engine fitment boost: every whitespace token in filter_engine
        -- must appear (case-insensitive substring) in some fitment_engines element.
        * CASE
            WHEN filter_engine IS NULL THEN 1.0
            WHEN EXISTS (
              SELECT 1 FROM unnest(p.fitment_engines) AS e
              WHERE NOT EXISTS (
                SELECT 1 FROM unnest(string_to_array(lower(filter_engine), ' ')) AS tok
                WHERE tok <> '' AND lower(e) NOT LIKE '%' || tok || '%'
              )
            ) THEN 1.5
            ELSE 1.0
          END
        -- Year fitment boost.
        * CASE
            WHEN filter_year IS NULL THEN 1.0
            WHEN filter_year = ANY(p.fitment_years) THEN 1.3
            ELSE 1.0
          END
        -- Make fitment boost (token-based, same shape as engine).
        * CASE
            WHEN filter_make IS NULL THEN 1.0
            WHEN EXISTS (
              SELECT 1 FROM unnest(p.fitment_makes) AS m
              WHERE NOT EXISTS (
                SELECT 1 FROM unnest(string_to_array(lower(filter_make), ' ')) AS tok
                WHERE tok <> '' AND lower(m) NOT LIKE '%' || tok || '%'
              )
            ) THEN 1.2
            ELSE 1.0
          END
        -- Slight de-boost for universal parts so vehicle-specific hits float up,
        -- but only when the customer gave us truck context. No filters → no penalty.
        * CASE
            WHEN coalesce(p.is_universal, false)
              AND (filter_engine IS NOT NULL OR filter_year IS NOT NULL OR filter_make IS NOT NULL)
            THEN 0.9
            ELSE 1.0
          END
        -- Stocking items are first-party and should rank higher.
        * CASE WHEN coalesce(p.is_stocking_item, false) THEN 1.3 ELSE 1.0 END
      )::real AS rank
    FROM public.products p, q
    WHERE
      p.status = 'active'
      AND p.is_visible = true
      AND p.in_stock = true
      AND p.search_vector @@ q.tsq
    ORDER BY rank DESC
    LIMIT result_limit
  )
  SELECT
    r.id,
    r.sku,
    r.product_name,
    r.brand,
    r.category,
    r.price,
    r.short_description,
    CASE
      WHEN coalesce(r.is_universal, false) THEN 'Universal'
      ELSE concat_ws(' | ',
        NULLIF(array_to_string(r.fitment_makes, '/'), ''),
        CASE
          WHEN r.fitment_years IS NOT NULL AND array_length(r.fitment_years, 1) > 0 THEN (
            SELECT CASE
              WHEN min(y) = max(y) THEN min(y)::text
              ELSE min(y)::text || '-' || max(y)::text
            END
            FROM unnest(r.fitment_years) AS y
          )
          ELSE NULL
        END,
        NULLIF(array_to_string(r.fitment_engines, ', '), '')
      )
    END AS fitment_summary,
    r.data_source,
    'https://www.black-stack-diesel.com/products/' || r.sku AS product_url,
    r.in_stock,
    r.is_stocking_item,
    r.rank
  FROM ranked r
  ORDER BY r.rank DESC;
$$;

-- ---------------------------------------------------------------------
-- 5. Grants. Chat Edge Function uses service role (which bypasses), but
--    granting to anon/authenticated is correct for future client-direct use.
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.search_products(text, text, integer, text, integer)
  TO anon, authenticated;

COMMENT ON FUNCTION public.search_products(text, text, integer, text, integer) IS
  'Weighted FTS over products with optional engine/year/make fitment filters. ASAP-sourced and stocking items are boosted in rank.';

COMMIT;
