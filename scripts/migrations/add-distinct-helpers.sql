-- Returns distinct categories and brands for the product filter dropdowns
-- Bypasses Supabase's 1000-row default limit that affects plain selects

create or replace function public.get_distinct_product_categories()
returns setof text
language sql
stable
as $$
  select distinct category
  from public.products
  where is_visible = true
    and status not in ('archived', 'discontinued', 'draft')
    and category is not null
  order by category;
$$;

create or replace function public.get_distinct_product_brands()
returns setof text
language sql
stable
as $$
  select distinct brand
  from public.products
  where is_visible = true
    and status not in ('archived', 'discontinued', 'draft')
    and brand is not null
  order by brand;
$$;

grant execute on function public.get_distinct_product_categories() to anon, authenticated;
grant execute on function public.get_distinct_product_brands() to anon, authenticated;
