-- Stage 4: Tracking columns on orders.
-- Populated by api/poll-apg-tracking.js when APG returns tracking for a
-- previously submitted order. Idempotent: safe to re-run.

alter table orders
  add column if not exists tracking_number text,
  add column if not exists tracking_carrier text,
  add column if not exists shipped_at timestamp with time zone,
  add column if not exists customer_notified_at timestamp with time zone;

comment on column orders.tracking_number is
  'Carrier tracking number returned by APG /tracking. Populated when supplier_status flips to fulfilled.';
comment on column orders.tracking_carrier is
  'Carrier name as returned by APG (UPS, FedEx, USPS, DHL, etc.).';
comment on column orders.shipped_at is
  'Timestamp at which BSD observed APG-side tracking. Approximates true ship date — APG does not return a separate ship event.';
comment on column orders.customer_notified_at is
  'Timestamp at which the shipped-confirmation email was sent to the customer. NULL means email was never sent (or send failed).';

notify pgrst, 'reload schema';
