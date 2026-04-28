-- Backfill category for APG products where category is null (~26,738 rows / 53% of catalog)
-- Strategy: brand-based defaults first (highest confidence), then keyword inference on product_name,
-- then an 'Accessories and Fluids' fallback so nothing remains null.
-- Every update is guarded by `category is null` so existing categorized rows are never overwritten.
--
-- Run in the Supabase SQL editor. Do NOT apply as a code migration.
-- APG vendor_id: 013cd9a7-171e-45fe-9421-0320319dce33
--
-- Every UPDATE targets one of the 22 existing taxonomy strings. The post-backfill
-- safety check at the bottom (PART 4) will flag any rows whose category is outside
-- that set — if it returns any rows, do not proceed.

-- =============================================================================
-- PRE-FLIGHT CHECKS (run these FIRST, separately, before the backfill below)
-- Confirm brand names match exactly before running any UPDATE.
-- =============================================================================
--
-- select distinct brand from products
-- where brand ilike 'pacific performance%';
--
-- select distinct brand from products
-- where brand ilike 'industrial injection%';
--
-- select distinct brand from products
-- where brand ilike 'wehrli%';

-- =============================================================================
-- Begin atomic backfill (PARTS 1-3). Verification queries in PART 4 run outside.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Brand-based defaults
-- =============================================================================

-- Suspension brands
update products set category = 'Suspension'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'BDS Suspension (Fox)',
    'Carli Suspension (Randys)',
    'Icon Suspension (Randys)',
    'Kelderman Air Suspension',
    'Zone Offroad (Fox)',
    'Superlift (Real Truck)',
    'Rough Country'
  );

-- Body brands (bumpers, racks, steps)
update products set category = 'Body'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'Fab Fours',
    'Rhino-Rack USA',
    'Westin Automotive'
  );

-- Transmission brands (note: Zumbrota makes transmissions AND axles/drivelines;
-- default to Transmission and rely on downstream keyword rules where needed)
update products set category = 'Transmission'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'Zumbrota (Randys)',
    'Suncoast Converters',
    'ATS Diesel Performance'
  );

-- Tuner brands — DB taxonomy has no dedicated Tuners category; use
-- 'Accessories and Fluids' as the closest generic bucket
update products set category = 'Accessories and Fluids'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'DuraMax Tuner',
    'HPS Performance'
  );

-- Fuel injection specialty brands
-- Note: Industrial Injection, Wehrli Custom Fab, and Pacific Performance are
-- intentionally NOT brand-defaulted — their product lines are mixed, so the
-- keyword layer below classifies them per product_name instead.
update products set category = 'Air and Fuel Delivery'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'Exergy',
    'S&S Diesel Motorsport'
  );

-- Engine rebuilders
update products set category = 'Engine'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand in (
    'Choate Performance Engineering',
    'Mahle'
  );

-- Mixed fab (trust brand context, default to Engine)
update products set category = 'Engine'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand = 'No Limit Fabrication';

-- Lighting brand
update products set category = 'Electrical Lighting and Body'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand = 'J.W. Speaker';

-- Cooling / intercooler hoses
update products set category = 'Belts and Cooling'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and brand = 'Crown Performance';

-- =============================================================================
-- PART 2: Keyword-based fallback (product_name pattern matching)
-- =============================================================================

-- Turbos → Air and Fuel Delivery (no dedicated turbo category exists)
update products set category = 'Air and Fuel Delivery'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%turbo%'
       or product_name ilike '%turbocharger%'
       or product_name ilike '%compressor wheel%');

-- Exhaust
update products set category = 'Exhaust'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%exhaust%'
       or product_name ilike '%muffler%'
       or product_name ilike '%down pipe%'
       or product_name ilike '%downpipe%'
       or product_name ilike '%tailpipe%'
       or product_name ilike '%mbrp%');

-- Intake, injectors, fuel systems → Air and Fuel Delivery
update products set category = 'Air and Fuel Delivery'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%intake%'
       or product_name ilike '%cold air%'
       or product_name ilike '% cai %'
       or product_name ilike '%air filter%'
       or product_name ilike '%injector%'
       or product_name ilike '%fuel pump%'
       or product_name ilike '%lift pump%'
       or product_name ilike '%cp3%'
       or product_name ilike '%cp4%'
       or product_name ilike '%fass%'
       or product_name ilike '%airdog%');

-- Suspension
update products set category = 'Suspension'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%shock%'
       or product_name ilike '%strut%'
       or product_name ilike '%coilover%'
       or product_name ilike '%leaf spring%'
       or product_name ilike '%suspension%'
       or product_name ilike '%lift kit%'
       or product_name ilike '%leveling kit%'
       or product_name ilike '%track bar%'
       or product_name ilike '%sway bar%'
       or product_name ilike '%control arm%');

-- Steering (separate category from Suspension)
update products set category = 'Steering'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%steering%'
       or product_name ilike '%tie rod%'
       or product_name ilike '%drag link%'
       or product_name ilike '%steering stab%');

-- Brakes
update products set category = 'Brake'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%brake%'
       or product_name ilike '%caliper%'
       or product_name ilike '%rotor%'
       or product_name ilike '%brake pad%');

-- Driveline and Axles (separate from Transmission)
update products set category = 'Driveline and Axles'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%driveshaft%'
       or product_name ilike '%axle%'
       or product_name ilike '%differential%'
       or product_name ilike '%u-joint%'
       or product_name ilike '%ujoint%');

-- Transfer Case (separate from Transmission)
update products set category = 'Transfer Case'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and product_name ilike '%transfer case%';

-- Transmission
update products set category = 'Transmission'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%transmission%'
       or product_name ilike '%torque converter%'
       or product_name ilike '%tranny%'
       or product_name ilike '%trans cooler%'
       or product_name ilike '%valve body%'
       or product_name ilike '%clutch%'
       or product_name ilike '% 68rfe%'
       or product_name ilike '% allison%');

-- Belts and Cooling
update products set category = 'Belts and Cooling'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%radiator%'
       or product_name ilike '%coolant%'
       or product_name ilike '%thermostat%'
       or product_name ilike '%water pump%'
       or product_name ilike '%cooling%'
       or product_name ilike '%intercooler%'
       or product_name ilike '%serpentine belt%'
       or product_name ilike '%fan clutch%');

-- Electrical Charging and Starting (alternators / starters / batteries)
update products set category = 'Electrical Charging and Starting'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%alternator%'
       or product_name ilike '%starter%'
       or product_name ilike '%battery%');

-- Electrical Lighting and Body (wiring, harnesses, lights)
update products set category = 'Electrical Lighting and Body'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%wiring%'
       or product_name ilike '%harness%'
       or product_name ilike '%headlight%'
       or product_name ilike '%tail light%'
       or product_name ilike '%taillight%'
       or product_name ilike '%fog light%'
       or product_name ilike '%light bar%'
       or product_name ilike '%led bar%'
       or product_name ilike '%led light%');

-- Engine internals
update products set category = 'Engine'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%head stud%'
       or product_name ilike '%crankshaft%'
       or product_name ilike '%camshaft%'
       or product_name ilike '%connecting rod%'
       or product_name ilike '%piston%'
       or product_name ilike '%cylinder head%'
       or product_name ilike '%long block%'
       or product_name ilike '%short block%'
       or product_name ilike '%crate engine%'
       or product_name ilike '%valve cover%'
       or product_name ilike '%oil pan%'
       or product_name ilike '%oil pump%'
       or product_name ilike '%gasket%');

-- Tuners / programmers → Accessories and Fluids (no dedicated Tuners category)
update products set category = 'Accessories and Fluids'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%tuner%'
       or product_name ilike '%programmer%'
       or product_name ilike '%edge products%'
       or product_name ilike '%edge insight%'
       or product_name ilike '%edge evolution%'
       or product_name ilike '%edge cts%'
       or product_name ilike '%efi live%'
       or product_name ilike '%efilive%'
       or product_name ilike '%mini maxx%'
       or product_name ilike '%smarty%'
       or product_name ilike '%bully dog%');

-- Gauges / monitors → Accessories and Fluids (aftermarket add-ons)
update products set category = 'Accessories and Fluids'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%gauge%'
       or product_name ilike '%monitor%');

-- Body (bumpers, grilles, racks, steps)
update products set category = 'Body'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%bumper%'
       or product_name ilike '%grille%'
       or product_name ilike '%fender flare%'
       or product_name ilike '%running board%'
       or product_name ilike '%nerf bar%'
       or product_name ilike '%step bar%'
       or product_name ilike '%roof rack%'
       or product_name ilike '%bed rack%');

-- Emission Control
update products set category = 'Emission Control'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%egr%'
       or product_name ilike '%dpf%'
       or product_name ilike '%def %'
       or product_name ilike '%catalytic%'
       or product_name ilike '%ccv%'
       or product_name ilike '%crankcase vent%'
       or product_name ilike '%emission%');

-- Tools and Equipment
update products set category = 'Tools and Equipment'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%tool%'
       or product_name ilike '%puller%'
       or product_name ilike '%installer%'
       or product_name ilike '%removal kit%'
       or product_name ilike '%socket%');

-- Hardware and Service Supplies
update products set category = 'Hardware and Service Supplies'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%bolt kit%'
       or product_name ilike '%fastener%'
       or product_name ilike '%clamp%'
       or product_name ilike '%fitting%'
       or product_name ilike '%bushing%');

-- Fluids and chemicals → Accessories and Fluids
update products set category = 'Accessories and Fluids'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null
  and (product_name ilike '%oil filter%'
       or product_name ilike '%fuel filter%'
       or product_name ilike '%air filter%'
       or product_name ilike '%additive%'
       or product_name ilike '%fluid%'
       or product_name ilike '%lubricant%');

-- Final fallback: anything still null becomes 'Accessories and Fluids'
update products set category = 'Accessories and Fluids'
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null;

-- =============================================================================
-- PART 3: Reclassify Choate "Daily Driver" crate engines (OEM, not Stage 3)
-- =============================================================================

update products
set stage = 0
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and brand = 'Choate Performance Engineering'
  and product_name ilike '%daily driver%'
  and stage = 3;

COMMIT;

-- =============================================================================
-- PART 4: Verification queries (run after the transaction commits, outside BEGIN/COMMIT)
-- =============================================================================

-- Should drop from 26,738 to 0 (or near 0)
select count(*) from products
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and category is null;

-- Category distribution — should only show the 22 existing categories, no new ones
select category, count(*) from products
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
group by category
order by count(*) desc;

-- Choate Engine count (expected: 484)
select count(*) from products
where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
  and status = 'active'
  and brand = 'Choate Performance Engineering'
  and category = 'Engine';

-- SAFETY CHECK: No new categories created
-- If this returns any rows, we accidentally created a new category and need to
-- fix it before proceeding.
select category from (
  select distinct category from products
  where vendor_id = '013cd9a7-171e-45fe-9421-0320319dce33'
    and status = 'active'
) t
where category not in (
  'Accessories and Fluids', 'Air and Fuel Delivery', 'Belts and Cooling',
  'Body', 'Brake', 'Driveline and Axles', 'Electrical Charging and Starting',
  'Electrical Lighting and Body', 'Emission Control', 'Engine',
  'Entertainment and Telematics', 'Exhaust', 'Hardware and Service Supplies',
  'HVAC', 'Ignition', 'Multifunction Terms', 'Steering', 'Suspension',
  'Tire and Wheel', 'Tools and Equipment', 'Transfer Case', 'Transmission'
);
