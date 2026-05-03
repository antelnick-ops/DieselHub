require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

// =====================================================================
// CONFIG
// =====================================================================
const ASAP_BASE = 'https://api.asapnetwork.org/webapi';
const PRODUCT_TYPE = 'Truck/SUV';
const PER_CALL_TIMEOUT_MS = 30000;
const RATE_LIMIT_MS = 100;        // delay between /product/{sku} calls
const RETRY_PAUSE_MS = 2000;      // pause before single retry on 5xx/429/timeout

// =====================================================================
// CLI ARG PARSING
// =====================================================================
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brand-id') out.brandId = argv[++i];
    else if (a === '--brand-pattern') out.brandPattern = argv[++i];
    else if (a === '--brand-name') out.brandName = argv[++i];
    else if (a === '--commit') out.commit = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else console.warn(`Unknown arg: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help || !args.brandId) {
  console.error([
    'Usage: node scripts/asap-import.js --brand-id <id> [--brand-pattern <p>] [--brand-name <n>] [--commit]',
    '',
    '  --brand-id <id>      ASAP brand_id from /brands (required)',
    '  --brand-pattern <p>  ILIKE pattern for the BSD `brand` column. Narrows the batch',
    '                       mfg_sku match to prevent cross-brand collisions. Optional;',
    '                       omitting it logs a warning. The bulk wrapper passes this',
    '                       automatically from PREFIX_RULES.',
    '  --brand-name <n>     Brand display name. Used as fallback when no detail call',
    '                       fires (e.g., a brand with zero matches). The bulk wrapper',
    '                       passes this automatically from asap_approved_brands.json.',
    '  --dry-run            Default. Reports without writing to products.',
    '  --commit             Required to actually UPDATE products and INSERT unmatched.',
    '',
    'Examples:',
    '  node scripts/asap-import.js --brand-id 196448             # ACCEL, dry-run',
    '  node scripts/asap-import.js --brand-id 196448 --commit    # ACCEL, write',
    '  node scripts/asap-import.js --brand-id 83748 --brand-pattern "Icon Suspension (Randys)"'
  ].join('\n'));
  process.exit(args.help ? 0 : 2);
}

const DRY_RUN = !args.commit;
const BRAND_ID = args.brandId;

if (!process.env.ASAP_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing ASAP_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local');
  process.exit(2);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// =====================================================================
// HTTP HELPERS
// =====================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callAsap(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.ASAP_API_KEY}`,
        Accept: 'application/json'
      },
      signal: ctrl.signal
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt === 1) {
        await sleep(RETRY_PAUSE_MS);
        return callAsap(url, 2);
      }
      throw new Error(`HTTP ${res.status} after retry`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (attempt === 1) {
        await sleep(RETRY_PAUSE_MS);
        return callAsap(url, 2);
      }
      throw new Error('Timeout after retry');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// DIESEL DETECTION
// =====================================================================
// Per spec: explicit diesel terms + diesel-platform model patterns gated
// by the year-range when that platform actually had a diesel option.
const DIESEL_TERMS = /\b(cummins|duramax|power\s*stroke|powerstroke|lb7|lly|lbz|lmm|lml|l5p)\b/i;

const DIESEL_PLATFORMS = [
  // Ford Power Stroke
  { make: /^Ford$/i, model: /^F-?(250|350|450|550)$/i, yearMin: 1994 },
  { make: /^Ford$/i, model: /^Excursion$/i, yearMin: 2000, yearMax: 2005 },
  // Ram/Dodge Cummins
  { make: /^(Dodge|Ram)$/i, model: /^Ram\s*(2500|3500|4500|5500)$/i, yearMin: 1989 },
  { make: /^Dodge$/i, model: /^[DW](250|350)$/i, yearMin: 1989, yearMax: 1993 },
  // GM Duramax
  { make: /^Chevrolet$/i, model: /^Silverado\s*(2500|3500)\s*HD?$/i, yearMin: 2001 },
  { make: /^GMC$/i, model: /^Sierra\s*(2500|3500)\s*HD?$/i, yearMin: 2001 }
];

function isDieselFit(fitmentRows) {
  if (!Array.isArray(fitmentRows) || fitmentRows.length === 0) {
    return { diesel: false, signal: null };
  }
  for (const r of fitmentRows) {
    const blob = `${r.make || ''} ${r.model || ''} ${r.sub_model || ''}`;
    const m = blob.match(DIESEL_TERMS);
    if (m) return { diesel: true, signal: m[0] };

    const ys = Number(r.year_start);
    const ye = Number(r.year_end);
    for (const p of DIESEL_PLATFORMS) {
      if (!p.make.test(r.make || '')) continue;
      if (!p.model.test(r.model || '')) continue;
      if (Number.isFinite(ye) && ye < (p.yearMin || 0)) continue;
      if (Number.isFinite(ys) && p.yearMax && ys > p.yearMax) continue;
      return { diesel: true, signal: `${r.make} ${r.model} ${r.year_start}-${r.year_end}` };
    }
  }
  return { diesel: false, signal: null };
}

// =====================================================================
// ASAP PAYLOAD HELPERS
// =====================================================================
function listProducts(productsField) {
  if (!productsField) return [];
  if (Array.isArray(productsField)) return productsField;
  return Object.values(productsField);
}

function parseFitmentColumn(asapFitment) {
  if (Array.isArray(asapFitment)) {
    // Already structured (API path) — could be array of objects or strings
    if (asapFitment.length === 0) return [];
    if (typeof asapFitment[0] === 'string') {
      return asapFitment.map(parseFitmentRowString).filter(Boolean);
    }
    return asapFitment; // array of objects
  }
  if (typeof asapFitment === 'string' && asapFitment.length > 0) {
    return asapFitment.split('|').map(parseFitmentRowString).filter(Boolean);
  }
  return [];
}

function parseFitmentRowString(s) {
  if (!s) return null;
  const [year_start, year_end, make, model, sub_model] = String(s).split(',');
  return {
    year_start: (year_start || '').trim(),
    year_end: (year_end || '').trim(),
    make: (make || '').trim(),
    model: (model || '').trim(),
    sub_model: (sub_model || '').trim()
  };
}

function extractSpec(fieldSpecs, namePattern) {
  if (!Array.isArray(fieldSpecs)) return null;
  const hit = fieldSpecs.find((s) => namePattern.test(String(s.spec_name || '')));
  return hit ? String(hit.spec_value || '').trim() : null;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}

function vendorUpdatedAtFromDetail(detail) {
  // ASAP detail uses date_updated as unix seconds string
  const t = detail.date_updated || detail.changed;
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function buildEnrichmentPayload(detail, matchMethod) {
  const fitmentRows = parseFitmentColumn(detail.fitment);
  const upc = extractSpec(detail.field_specs, /^upc$/i);
  const universalSpec = extractSpec(detail.field_specs, /^universal$/i);
  const isUniversal = universalSpec ? /^yes$/i.test(universalSpec) : false;

  const images = (() => {
    const v = detail.image ?? detail.images;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split('|').map((s) => s.trim()).filter(Boolean);
    return [];
  })();

  const vehicleTypes = (() => {
    const v = detail.vehicle_type;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split('|').map((s) => s.trim()).filter(Boolean);
    return [];
  })();

  const packaging = Array.isArray(detail.product_packaging)
    ? detail.product_packaging[0] || null
    : detail.product_packaging || null;

  const extras = {
    category: asArray(detail.category),
    country_of_origin: extractSpec(detail.field_specs, /^country\s*of\s*origin$/i),
    sold_as: extractSpec(detail.field_specs, /^sold\s*as$/i),
    availability_spec: extractSpec(detail.field_specs, /^availability$/i),
    prop_65_warning: Array.isArray(detail.prop_65_warning) ? detail.prop_65_warning[0] : detail.prop_65_warning || null,
    warranty: detail.warranty || null,
    material: detail.material || null,
    color: detail.color || null,
    finish: detail.finish || null,
    lift_height: detail.lift_height || null,
    fuel_type: detail.fuel_type || null,
    installation_instructions: asArray(detail.installation_instructions)
  };

  return {
    fitment_rows: fitmentRows,
    image_urls: images,
    map_price: detail.map_pricing ? Number(detail.map_pricing) : null,
    aaia_brand_id: detail.aaiaid || null,
    vehicle_types: vehicleTypes,
    upc: upc || null,
    is_universal: isUniversal,
    mfg_sku: detail.mfg_original_sku || null,
    product_packaging: packaging,
    asap_extras: extras,
    asap_match_method: matchMethod,
    asap_synced_at: new Date().toISOString(),
    vendor_updated_at: vendorUpdatedAtFromDetail(detail),
    data_source: 'merged'
  };
}

// =====================================================================
// MATCHING
// =====================================================================
const MATCH_SELECT =
  'id, sku, mfg_sku, upc, brand, aaia_brand_id, status, is_visible, archive_tags, fitment_rows';

// Strip the trailing AAIA suffix from an ASAP SKU. ASAP formats SKUs as
// "{mfg_sku}-{aaia_code}" where the AAIA is everything after the LAST
// hyphen. Examples:
//   "252002-FRDK"                   -> "252002"
//   "ICON-2142-STL-BL/CB-24PK-FRDK" -> "ICON-2142-STL-BL/CB-24PK"
//   "TST6-BDDP"                     -> "TST6"
// SKUs without a hyphen are returned as-is.
function normalizeAsapSku(sku) {
  if (!sku) return sku;
  const i = sku.lastIndexOf('-');
  return i < 0 ? sku : sku.substring(0, i);
}

// Batch-query BSD products by mfg_sku in chunks of 500 (PostgREST URL
// length safety). Each chunk paginates via .range() because Supabase
// enforces a server-side 1000-row response cap. brandPattern (optional)
// narrows the query via `brand ILIKE pattern` to prevent cross-brand
// mfg_sku collisions.
async function batchMatchByMfgSku(normalizedSkus, brandPattern) {
  const CHUNK = 500;
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10;
  const allMatched = [];
  for (let i = 0; i < normalizedSkus.length; i += CHUNK) {
    const chunk = normalizedSkus.slice(i, i + CHUNK);
    for (let page = 0; page < MAX_PAGES; page++) {
      let q = supabase.from('products').select(MATCH_SELECT).in('mfg_sku', chunk);
      if (brandPattern) q = q.ilike('brand', brandPattern);
      q = q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error } = await q;
      if (error) throw new Error(`batch match failed: ${error.message}`);
      if (!data || data.length === 0) break;
      allMatched.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
  }
  return allMatched;
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  const startedAt = new Date();
  const startMs = Date.now();

  console.log(`ASAP import — brand_id=${BRAND_ID} | mode=${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);

  // 1. Insert run row (always — this is run metadata, not "data")
  const { data: runRow, error: runErr } = await supabase
    .from('asap_import_runs')
    .insert({
      brand_id: BRAND_ID,
      started_at: startedAt.toISOString(),
      dry_run: DRY_RUN
    })
    .select()
    .single();
  if (runErr) throw new Error(`Failed to create run row: ${runErr.message}`);
  const runId = runRow.id;
  console.log(`Run ID: ${runId}`);

  // 2. Fetch product list
  const listUrl = `${ASAP_BASE}/products/${encodeURIComponent(BRAND_ID)}?type=${encodeURIComponent(PRODUCT_TYPE)}`;
  console.log(`Fetching ${listUrl}`);
  const listResp = await callAsap(listUrl);
  const productList = listProducts(listResp.products ?? listResp.data ?? listResp);
  const total = productList.length;
  console.log(`Total ASAP SKUs (Truck/SUV): ${total}`);

  // Capture brand name from first detail call later; for now update count
  await supabase.from('asap_import_runs').update({ asap_sku_count: total }).eq('id', runId);

  // Counters
  const counts = {
    matched_active: 0,
    matched_archived_resurrected: 0,
    matched_archived_skipped_tagged: 0,
    matched_archived_skipped_no_diesel_fitment: 0,
    unmatched: 0,
    errors: 0
  };
  const errorLog = [];
  const dryRunUnmatched = []; // collected when DRY_RUN, written to tmp at end
  let brandName = args.brandName || null; // CLI fallback when no detail call fires
  let apiCalls = 1; // the list call counts

  // 3. Pre-match phase: normalize all ASAP SKUs and batch-query BSD products
  //    in one shot. Avoids fetching detail for SKUs that will never match.
  const normalizedFor = new Map(); // original sku -> normalized
  for (const item of productList) {
    const sku = item.sku || item.SKU || item.id;
    if (sku) normalizedFor.set(sku, normalizeAsapSku(sku));
  }
  const uniqueNormalized = Array.from(new Set(normalizedFor.values()));

  if (!args.brandPattern) {
    console.warn('WARNING: --brand-pattern not set; cross-brand mfg_sku collisions possible.');
  }
  console.log(`Batch-matching ${uniqueNormalized.length} normalized SKUs against BSD...`);
  const matchedRows = await batchMatchByMfgSku(uniqueNormalized, args.brandPattern || null);
  const matchByMfgSku = new Map();
  for (const row of matchedRows) {
    if (row.mfg_sku) matchByMfgSku.set(row.mfg_sku, row);
  }
  console.log(
    `Batch match: ${matchByMfgSku.size}/${uniqueNormalized.length} normalized SKUs hit BSD products`
  );

  // 4. Per-SKU loop. Detail is fetched ONLY for SKUs that batch-matched.
  for (let i = 0; i < productList.length; i++) {
    const item = productList[i];
    const sku = item.sku || item.SKU || item.id;
    if (!sku) {
      counts.errors++;
      errorLog.push({ index: i, error: 'list item has no sku' });
      continue;
    }

    const norm = normalizedFor.get(sku);
    const product = matchByMfgSku.get(norm);

    // UNMATCHED — log without detail fetch. asap_upc and asap_product_title
    // are NULL since we never called /product/{sku}. Acceptable tradeoff per
    // the refactor spec; existing rows from prior runs are preserved by
    // ignoreDuplicates: true.
    if (!product) {
      counts.unmatched++;
      const unmatchedRow = {
        asap_sku: sku,
        asap_mfg_sku: norm,
        asap_upc: null,
        asap_brand_id: BRAND_ID,
        asap_brand_name: brandName || null,
        asap_product_title: null
      };
      if (!DRY_RUN) {
        const { error } = await supabase
          .from('asap_unmatched_skus')
          .upsert(unmatchedRow, { onConflict: 'asap_sku,asap_brand_id', ignoreDuplicates: true });
        if (error) {
          counts.errors++;
          errorLog.push({ index: i, sku, error: `unmatched insert: ${error.message}` });
        }
      } else {
        dryRunUnmatched.push(unmatchedRow);
      }
      progress(i + 1, total, sku, 'UNMATCHED (no detail fetched)');
      continue; // no sleep — we never hit the API
    }

    // MATCHED — fetch detail and run enrichment.
    try {
      const detailUrl = `${ASAP_BASE}/product/${encodeURIComponent(sku)}`;
      const detail = await callAsap(detailUrl);
      apiCalls++;
      if (!brandName && detail.brand) brandName = detail.brand;

      const enrichment = buildEnrichmentPayload(detail, 'mfg_sku');

      // ACTIVE branch
      if (product.status === 'active') {
        if (!DRY_RUN) {
          const { error } = await supabase.from('products').update(enrichment).eq('id', product.id);
          if (error) throw new Error(`update failed: ${error.message}`);
        }
        counts.matched_active++;
        progress(i + 1, total, sku, `MATCH_ACTIVE via mfg_sku`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      // ARCHIVED branch
      const tags = Array.isArray(product.archive_tags) ? product.archive_tags : [];
      if (tags.length > 0) {
        counts.matched_archived_skipped_tagged++;
        progress(i + 1, total, sku, `ARCHIVED_SKIP tags=${tags.join(',')}`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const dieselCheck = isDieselFit(enrichment.fitment_rows);
      if (!dieselCheck.diesel) {
        counts.matched_archived_skipped_no_diesel_fitment++;
        progress(i + 1, total, sku, 'ARCHIVED_SKIP no_diesel_fitment');
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const resurrectionPayload = {
        ...enrichment,
        status: 'active',
        is_visible: true,
        archive_recovered_at: new Date().toISOString(),
        archive_recovery_reason: `ASAP confirms ${dieselCheck.signal} fitment`
      };
      if (!DRY_RUN) {
        const { error } = await supabase.from('products').update(resurrectionPayload).eq('id', product.id);
        if (error) throw new Error(`resurrection update failed: ${error.message}`);
      }
      counts.matched_archived_resurrected++;
      progress(i + 1, total, sku, `RESURRECTED signal=${dieselCheck.signal}`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      counts.errors++;
      errorLog.push({ index: i, sku, error: err.message });
      progress(i + 1, total, sku, `ERROR ${err.message.slice(0, 60)}`);
      await sleep(RATE_LIMIT_MS);
    }
  }

  // 4. Finalize run row
  const completedAt = new Date();
  const wallMs = Date.now() - startMs;

  await supabase
    .from('asap_import_runs')
    .update({
      completed_at: completedAt.toISOString(),
      brand_name: brandName,
      ...counts,
      error_log: errorLog
    })
    .eq('id', runId);

  // Write dry-run unmatched preview
  if (DRY_RUN && dryRunUnmatched.length > 0) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(process.cwd(), 'tmp', 'asap-import-runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `dry-run-${runId}.json`);
    fs.writeFileSync(file, JSON.stringify({ runId, brandId: BRAND_ID, brandName, unmatched: dryRunUnmatched }, null, 2));
    console.log(`\nDry-run unmatched details: ${path.relative(process.cwd(), file)}`);
  }

  // 5. Summary
  console.log('');
  console.log('========================================================');
  console.log(`Run ID: ${runId}`);
  console.log(`Brand: ${brandName || '(unknown)'} (${BRAND_ID})`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Total ASAP SKUs:                       ${total}`);
  console.log(`Active matched + updated:              ${counts.matched_active}`);
  console.log(`Archived resurrected:                  ${counts.matched_archived_resurrected}`);
  console.log(`Archived skipped (tagged):             ${counts.matched_archived_skipped_tagged}`);
  console.log(`Archived skipped (no diesel fitment):  ${counts.matched_archived_skipped_no_diesel_fitment}`);
  console.log(`Unmatched (logged):                    ${counts.unmatched}`);
  console.log(`Errors:                                ${counts.errors}`);
  console.log(`Total API calls:                       ${apiCalls}  (1 list + ${apiCalls - 1} details)`);
  console.log(`Wall clock:                            ${formatDuration(wallMs)}`);
  console.log('========================================================');

  if (counts.errors > 0) {
    console.log(`\nFirst 5 errors:`);
    errorLog.slice(0, 5).forEach((e) => console.log(`  ${e.sku || `idx=${e.index}`}: ${e.error}`));
  }
}

function progress(i, total, sku, status) {
  // Emit per-SKU progress on its own line for live tail visibility
  console.log(`  [${i}/${total}] ${sku} → ${status}`);
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${s}s`;
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
