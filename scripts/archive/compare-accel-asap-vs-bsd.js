require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CSV_PATH = path.join(process.cwd(), 'tmp', 'asap-data', 'accel', '2026-04-28-products.csv');

function pct(n, d) {
  return d === 0 ? '0.0%' : ((n / d) * 100).toFixed(1) + '%';
}

function nonEmpty(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '';
}

async function fetchAllAccel() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, product_name, brand, fitment_makes, fitment_years, fitment_engines, fitment_text, image_url, status, is_visible')
      .ilike('brand', '%accel%')
      .eq('status', 'active')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }

  // 1. Load ASAP CSV
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const asapRows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true
  });
  console.log(`ASAP ACCEL rows: ${asapRows.length}`);

  // 2. Load BSD ACCEL products
  console.log('Querying Supabase...');
  const bsdRows = await fetchAllAccel();
  console.log(`BSD ACCEL rows (active): ${bsdRows.length}`);

  // 3. Build SKU lookup. ASAP `sku` is `TST6-BDDP`, `mfg_original_sku` is `TST6`.
  // BSD `sku` from APG might match either form. Build maps for both.
  const bsdBySku = new Map();
  for (const r of bsdRows) {
    if (r.sku) bsdBySku.set(String(r.sku).toUpperCase(), r);
  }

  const matched = []; // { asap, bsd }
  let matchedByMfg = 0;
  let matchedByFull = 0;
  for (const a of asapRows) {
    const fullKey = String(a.sku || '').toUpperCase();
    const mfgKey = String(a.mfg_original_sku || '').toUpperCase();
    let bsd = bsdBySku.get(fullKey);
    if (bsd) matchedByFull++;
    if (!bsd && mfgKey) {
      bsd = bsdBySku.get(mfgKey);
      if (bsd) matchedByMfg++;
    }
    if (bsd) matched.push({ asap: a, bsd });
  }
  console.log(`SKUs matched: ${matched.length} of ${asapRows.length} (${pct(matched.length, asapRows.length)})`);
  console.log(`  matched on full SKU (with AAIA suffix): ${matchedByFull}`);
  console.log(`  matched on mfg_original_sku: ${matchedByMfg}`);

  // 4. Compute metrics on matched intersection
  const totalMatched = matched.length;

  let bsdHasMakes = 0;
  let bsdHasYears = 0;
  let bsdHasEngines = 0;
  let bsdHasImage = 0;
  let bsdMakesCountSum = 0;
  let bsdMakesCountN = 0;

  let asapHasFitment = 0;
  let asapHasImage = 0;
  let asapAppCountSum = 0;
  let asapAppCountN = 0;

  for (const { asap, bsd } of matched) {
    if (nonEmpty(bsd.fitment_makes)) {
      bsdHasMakes++;
      const len = Array.isArray(bsd.fitment_makes) ? bsd.fitment_makes.length : 0;
      bsdMakesCountSum += len;
      bsdMakesCountN += 1;
    }
    if (nonEmpty(bsd.fitment_years)) bsdHasYears++;
    if (nonEmpty(bsd.fitment_engines)) bsdHasEngines++;
    if (nonEmpty(bsd.image_url)) bsdHasImage++;

    const fit = String(asap.fitment || '').trim();
    if (fit.length > 0) {
      asapHasFitment++;
      const apps = fit.split('|').filter((x) => x.trim().length > 0).length;
      asapAppCountSum += apps;
      asapAppCountN += 1;
    }
    if (nonEmpty(asap.images)) asapHasImage++;
  }

  // Also compute coverage stats on the FULL sets, not just intersection
  const asapTotal = asapRows.length;
  const bsdTotal = bsdRows.length;

  let asapTotalHasFitment = 0;
  let asapTotalHasImage = 0;
  let asapTotalAppCountSum = 0;
  let asapTotalAppCountN = 0;
  for (const a of asapRows) {
    const fit = String(a.fitment || '').trim();
    if (fit.length > 0) {
      asapTotalHasFitment++;
      const apps = fit.split('|').filter((x) => x.trim().length > 0).length;
      asapTotalAppCountSum += apps;
      asapTotalAppCountN += 1;
    }
    if (nonEmpty(a.images)) asapTotalHasImage++;
  }

  let bsdTotalHasMakes = 0;
  let bsdTotalHasYears = 0;
  let bsdTotalHasEngines = 0;
  let bsdTotalHasImage = 0;
  let bsdTotalMakesSum = 0;
  let bsdTotalMakesN = 0;
  for (const b of bsdRows) {
    if (nonEmpty(b.fitment_makes)) {
      bsdTotalHasMakes++;
      const len = Array.isArray(b.fitment_makes) ? b.fitment_makes.length : 0;
      bsdTotalMakesSum += len;
      bsdTotalMakesN += 1;
    }
    if (nonEmpty(b.fitment_years)) bsdTotalHasYears++;
    if (nonEmpty(b.fitment_engines)) bsdTotalHasEngines++;
    if (nonEmpty(b.image_url)) bsdTotalHasImage++;
  }

  const result = {
    totals: { asap_total: asapTotal, bsd_total: bsdTotal, matched: totalMatched },
    intersection: {
      bsd_with_fitment_makes: { count: bsdHasMakes, pct: pct(bsdHasMakes, totalMatched) },
      bsd_with_fitment_years: { count: bsdHasYears, pct: pct(bsdHasYears, totalMatched) },
      bsd_with_fitment_engines: { count: bsdHasEngines, pct: pct(bsdHasEngines, totalMatched) },
      bsd_with_image: { count: bsdHasImage, pct: pct(bsdHasImage, totalMatched) },
      bsd_avg_makes_per_sku: bsdMakesCountN ? (bsdMakesCountSum / bsdMakesCountN).toFixed(2) : '0',
      asap_with_fitment: { count: asapHasFitment, pct: pct(asapHasFitment, totalMatched) },
      asap_with_image: { count: asapHasImage, pct: pct(asapHasImage, totalMatched) },
      asap_avg_apps_per_sku: asapAppCountN ? (asapAppCountSum / asapAppCountN).toFixed(1) : '0'
    },
    full_asap: {
      total: asapTotal,
      with_fitment: { count: asapTotalHasFitment, pct: pct(asapTotalHasFitment, asapTotal) },
      with_image: { count: asapTotalHasImage, pct: pct(asapTotalHasImage, asapTotal) },
      avg_apps_per_sku: asapTotalAppCountN ? (asapTotalAppCountSum / asapTotalAppCountN).toFixed(1) : '0'
    },
    full_bsd: {
      total: bsdTotal,
      with_fitment_makes: { count: bsdTotalHasMakes, pct: pct(bsdTotalHasMakes, bsdTotal) },
      with_fitment_years: { count: bsdTotalHasYears, pct: pct(bsdTotalHasYears, bsdTotal) },
      with_fitment_engines: { count: bsdTotalHasEngines, pct: pct(bsdTotalHasEngines, bsdTotal) },
      with_image: { count: bsdTotalHasImage, pct: pct(bsdTotalHasImage, bsdTotal) },
      avg_makes_per_sku: bsdTotalMakesN ? (bsdTotalMakesSum / bsdTotalMakesN).toFixed(2) : '0'
    }
  };

  console.log('\n=== BSD ACCEL SKU SAMPLES ===');
  bsdRows.slice(0, 10).forEach((r) => {
    console.log(`  sku=${r.sku} | brand=${r.brand} | name=${(r.product_name || '').slice(0, 80)}`);
  });

  console.log('\n=== ASAP ACCEL SKU SAMPLES ===');
  asapRows.slice(0, 5).forEach((r) => {
    console.log(`  sku=${r.sku} | mfg_sku=${r.mfg_original_sku} | name=${(r.title || '').slice(0, 80)}`);
  });

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  // Persist to a tmp JSON for the doc-append step
  fs.writeFileSync(path.join(process.cwd(), 'tmp', 'accel_compare_result.json'), JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
