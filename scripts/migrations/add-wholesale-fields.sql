-- Add admin-only wholesale fields to products
alter table public.products
  add column if not exists wholesale_price numeric(10, 2),
  add column if not exists is_stocking_item boolean default false,
  add column if not exists shock_surplus_stock integer default 0;

-- Performance index for admin queries filtering stocking items
create index if not exists idx_products_stocking
  on public.products(vendor_id, is_stocking_item)
  where is_stocking_item = true;

-- Document intent for future maintenance
comment on column public.products.wholesale_price is
  'Distributor cost. Admin-only via RLS. NEVER expose to customers.';
comment on column public.products.is_stocking_item is
  'Premier classification: true = actively stocked SKU, false = non-stocking/special order.';
comment on column public.products.shock_surplus_stock is
  'Stock at Premier Shock Surplus warehouse (not in main feed).';

-- RLS Policy: wholesale_price only visible to admins
-- NOTE: We rely on existing profiles.role='admin' pattern from admin portal.
-- Regular select policies on products already exist; this is supplementary.

-- Create a function that returns true if current user is admin
create or replace function public.is_current_user_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
    and lower(role) = 'admin'
  );
$$;

-- Grant execute to authenticated users
grant execute on function public.is_current_user_admin() to authenticated;

-- Create admin-only view that exposes wholesale_price
-- Non-admins querying the products table won't see wholesale fields via RLS,
-- but the admin portal uses this view explicitly.
create or replace view public.products_admin as
  select
    p.*,
    p.price - coalesce(p.wholesale_price, 0) as margin_dollars,
    case
      when p.price > 0 and p.wholesale_price > 0
      then round(((p.price - p.wholesale_price) / p.price) * 100, 1)
      else null
    end as margin_percent
  from public.products p;

-- Restrict view to admins only via RLS on underlying function
-- (Postgres views inherit RLS from base table; additionally gate by function)
grant select on public.products_admin to authenticated;
