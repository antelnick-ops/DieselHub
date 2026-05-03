require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = true; // set false to write rows into asap_brand_requests
const PAGE_SIZE = 1000;
const TOP_N = 50;
const TABLE_TOP_N = 30;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PITCH = "Black Stack Diesel (DBA of Dynamic Innovative Solutions LLC) is a mobile-first eCommerce marketplace targeting Cummins, Duramax, and Power Stroke diesel truck owners. We currently carry 49,000+ active SKUs sourced primarily through APG Wholesale (Premier WD), with daily incremental inventory sync. We're requesting your brand data via ASAP Network to improve fitment accuracy with structured ACES data, present authentic brand imagery and descriptions, and enhance the buying experience for [BRAND]'s products on our platform. Our integration is production-ready; brand authorization is the only remaining step before we can ingest your data via API. Live at https://black-stack-diesel.com.";

async function fetchAllActiveProducts() {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('products')
      .select('brand, price, wholesale_price')
      .eq('status', 'active')
      .eq('is_visible', true)
      .not('brand', 'is', null)
      .not('brand', 'ilike', '%inactive%')
      .not('brand', 'ilike', '%- inactive%')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...data);
    process.stdout.write(`\rFetched ${all.length} rows...`);

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  process.stdout.write('\n');
  return all;
}

function aggregateByBrand(rows) {
  const map = new Map();
  for (const r of rows) {
    const b = r.brand;
    if (!b) continue;
    const entry = map.get(b) || {
      sku_count: 0,
      price_sum: 0,
      price_count: 0,
      wholesale_count: 0
    };
    entry.sku_count += 1;
    const price = Number(r.price);
    if (Number.isFinite(price) && price > 0) {
      entry.price_sum += price;
      entry.price_count += 1;
    }
    const wholesale = Number(r.wholesale_price);
    if (Number.isFinite(wholesale) && wholesale > 0) {
      entry.wholesale_count += 1;
    }
    map.set(b, entry);
  }

  const result = [];
  for (const [brand, e] of map.entries()) {
    const avg_price = e.price_count > 0 ? e.price_sum / e.price_count : 0;
    const has_wholesale_pct =
      e.sku_count > 0 ? (e.wholesale_count / e.sku_count) * 100 : 0;
    const composite_score = e.sku_count * avg_price * (1 + has_wholesale_pct / 100);
    result.push({
      brand_name: brand,
      sku_count: e.sku_count,
      avg_price: Number(avg_price.toFixed(2)),
      has_wholesale_pct: Number(has_wholesale_pct.toFixed(1)),
      composite_score: Number(composite_score.toFixed(2))
    });
  }
  result.sort((a, b) => b.composite_score - a.composite_score);
  return result;
}

function priorityFor(rank) {
  if (rank <= 10) return 'HIGH';
  if (rank <= 20) return 'MEDIUM';
  return 'LOW';
}

function escapePipe(s) {
  return String(s).replace(/\|/g, '\\|');
}

function buildDoc(top50) {
  const top30 = top50.slice(0, 30);
  const today = new Date().toISOString().slice(0, 10);
  const totalSkus = top50.reduce((s, b) => s + b.sku_count, 0);

  const lines = [];
  lines.push('# ASAP Coverage Analysis');
  lines.push('');
  lines.push(`_Generated ${today} from Supabase \`products\` table (active + visible, brand not null, "inactive" brands excluded)._`);
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push("This file is the prioritized worklist for requesting brand authorizations through the ASAP Network dashboard. The `/brands` endpoint only returns brands that have explicitly authorized BSD's account, so the integration is gated on per-brand approvals — and approvals take time. The ranking below tells you which approvals are worth chasing first: each brand's composite score is `sku_count × avg_price × (1 + has_wholesale_pct/100)`, which weights catalog depth, price tier, and how much of the line we already stock at wholesale, so the brands that move the most revenue rise to the top.");
  lines.push('');
  lines.push("Use this as a request queue, not a shopping list. Work through HIGH brands first today, kick off MEDIUM after the first HIGH approvals start landing (so you can validate the ingest path on real data before spreading wider), and save LOW for once the ASAP integration is proven and you're scaling. Track every request in the `asap_brand_requests` table — that's the source of truth for which brands you've already pinged, what came back, and when to follow up.");
  lines.push('');
  lines.push(`Top 50 brands cover **${totalSkus.toLocaleString()} active SKUs** in the BSD catalog.`);
  lines.push('');
  lines.push('## Top 30 brands to request');
  lines.push('');
  lines.push('| Rank | Brand | SKU Count | Avg Price | Wholesale % | Composite Score | Priority |');
  lines.push('|------|-------|-----------|-----------|-------------|-----------------|----------|');
  top30.forEach((b, i) => {
    const rank = i + 1;
    lines.push(
      `| ${rank} | ${escapePipe(b.brand_name)} | ${b.sku_count.toLocaleString()} | $${b.avg_price.toFixed(2)} | ${b.has_wholesale_pct.toFixed(1)}% | ${b.composite_score.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ${priorityFor(rank)} |`
    );
  });
  lines.push('');
  lines.push('## How to use this list');
  lines.push('');
  lines.push('1. Log in to the ASAP Network dashboard (https://www.asapnetwork.org/) with the account whose API key is in `.env.local` as `ASAP_API_KEY`.');
  lines.push('2. Locate the brand request / authorization workflow — typically under your account → **Brands** or **Authorizations**.');
  lines.push('3. For each brand in the table above, submit an authorization request and paste the **Pitch template** below into the message field. Replace `[BRAND]` with the actual brand name.');
  lines.push('4. After each request, update the matching row in `asap_brand_requests`:');
  lines.push('   - `status = \'requested\'`');
  lines.push('   - `requested_at = now()`');
  lines.push('5. Re-run `node scripts/test-asap.js` periodically. When `/brands` stops returning an empty list, those entries are the brands that approved you. For each, set `status = \'approved\'`, `approved_at = now()`, and copy the returned `brand_id` into `asap_brand_id`.');
  lines.push('6. If a brand cannot be found in the ASAP dashboard, set `status = \'not_on_asap\'`. That brand stays on APG keyword parsing.');
  lines.push('7. Process **HIGH first**, then **MEDIUM** after the first HIGH approvals come back, then **LOW** once the ingest path is proven on real ASAP data.');
  lines.push('');
  lines.push('## Pitch template');
  lines.push('');
  lines.push('Paste this verbatim into each ASAP brand request form. Replace `[BRAND]` with the brand name:');
  lines.push('');
  lines.push('> ' + PITCH);
  lines.push('');
  return lines.join('\n');
}

async function populateRequestsTable(top30) {
  const rows = top30.map((b, i) => ({
    brand_name: b.brand_name,
    bsd_sku_count: b.sku_count,
    composite_score: b.composite_score,
    priority: priorityFor(i + 1),
    status: 'pending'
  }));

  if (DRY_RUN) {
    console.log(`\n[DRY_RUN=true] Would insert ${rows.length} rows into asap_brand_requests.`);
    console.log('Sample (first 3):');
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    console.log('Set DRY_RUN=false at the top of this script to actually write.');
    return;
  }

  const { error } = await supabase.from('asap_brand_requests').insert(rows);
  if (error) throw new Error(`Insert failed: ${error.message}`);
  console.log(`\nInserted ${rows.length} rows into asap_brand_requests.`);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  }

  console.log('Fetching active visible products...');
  const rows = await fetchAllActiveProducts();
  console.log(`Total products: ${rows.length.toLocaleString()}`);

  const ranked = aggregateByBrand(rows);
  console.log(`Distinct brands: ${ranked.length}`);

  console.log('\nTop 10 by composite score:');
  ranked.slice(0, 10).forEach((b, i) => {
    console.log(
      `  ${i + 1}. ${b.brand_name} | SKUs: ${b.sku_count} | Avg: $${b.avg_price} | Wholesale: ${b.has_wholesale_pct}% | Score: ${b.composite_score.toLocaleString()}`
    );
  });

  const top50 = ranked.slice(0, TOP_N);
  const doc = buildDoc(top50);
  const docPath = path.join(process.cwd(), 'docs', 'ASAP_COVERAGE_ANALYSIS.md');
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, doc);
  console.log(`\nWrote ${path.relative(process.cwd(), docPath)}`);

  await populateRequestsTable(top50.slice(0, TABLE_TOP_N));
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
