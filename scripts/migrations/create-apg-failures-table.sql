-- Stage 2: APG order placement failure log.
-- Rows are written by api/place-apg-order.js when all retries are exhausted
-- or a non-retriable (4xx) error is returned. Used for manual review.

create table if not exists apg_failures (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  attempted_at timestamp with time zone default now(),
  request_payload jsonb,
  response_status integer,
  response_body jsonb,
  error_message text,
  retry_count integer default 0
);

create index if not exists idx_apg_failures_order_id on apg_failures(order_id);

notify pgrst, 'reload schema';
