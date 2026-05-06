require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// =====================================================================
// CONFIG
// =====================================================================
const BRANDS_FILE = path.join(process.cwd(), 'tmp', 'asap_approved_brands.json');
const LOG_DIR = path.join(process.cwd(), 'tmp', 'asap-bulk-import-runs');
const IMPORT_SCRIPT = path.join('scripts', 'importers', 'asap-import.js');

// Per-brand mfg_sku backfill rules. Each rule strips a known APG prefix from
// `sku` to populate `mfg_sku` so the asap-import.js mfg_sku-match path can
// hit. Schema: { brand_pattern, prefix, strip_length, match_via? }.
//
// match_via (optional, default 'list'): how asap-import.js derives the match
// key for this brand. 'list' uses normalizeAsapSku(item.sku) from the list
// endpoint — fast, no extra API calls. 'detail' opts into pre-fetching the
// detail endpoint for every list item and matching on detail.mfg_original_sku
// — required for brands whose list-sku stem is not the manufacturer part
// number (e.g. PPE, where list-sku is an internal ID and only detail carries
// the real mfg_original_sku that lines up with BSD's stripped sku).
//
// brand_pattern is fed straight into a `brand ILIKE <pattern>` query. Use
// EXACT strings (no wildcards) where possible — short-token wildcards like
// %fox% / %holley% over-match into unrelated BSD brands. Wildcard suffixes
// (e.g. 'USA Standard%') are OK when the BSD brand has known variants.
//
// The backfill UPDATE is guarded by `sku LIKE prefix || '%'`, so products
// that don't carry the APG prefix are skipped rather than mangled. Two
// rules below are MEDIUM-confidence (Lund 'AVS' 9/10, Holley 'HOL' 9/10);
// the guard handles their outliers safely.
//
// Approved-but-omitted ASAP brands (no BSD products to derive from):
//   45319 EZ Lynk, 201713 NFab
const PREFIX_RULES = {
  '389':    { brand_pattern: 'Husky Liners (Real Truck)',      prefix: 'HUS', strip_length: 3 },
  '877':    { brand_pattern: 'Diablosport (Holley)',           prefix: 'DSP', strip_length: 3 },
  '963':    { brand_pattern: 'Holley',                          prefix: 'HOL', strip_length: 3 },
  '3589':   { brand_pattern: 'Rock Krawler',                    prefix: 'RKK', strip_length: 3 },
  '5742':   { brand_pattern: 'ADS Racing Shocks (Holley)',     prefix: 'ARS', strip_length: 3 },
  '8663':   { brand_pattern: 'Bulldog Winch',                   prefix: 'BDW', strip_length: 3 },
  '10089':  { brand_pattern: 'Baja Designs (Bestop)',          prefix: 'BAJ', strip_length: 3 },
  '10916':  { brand_pattern: 'USA Standard%',                   prefix: 'USA', strip_length: 3 },
  '12441':  { brand_pattern: 'Yukon Gear and Axle (Randys)',    prefix: 'YUK', strip_length: 3 },
  '17579':  { brand_pattern: 'Volant (TMG)',                   prefix: 'VOL', strip_length: 3 },
  '21483':  { brand_pattern: 'ATS Diesel Performance',         prefix: 'ATS', strip_length: 3 },
  '22609':  { brand_pattern: 'Rigid Industries',                prefix: 'RIG', strip_length: 3 },
  '24899':  { brand_pattern: 'Skyjacker Suspension',            prefix: 'SKY', strip_length: 3 },
  '29425':  { brand_pattern: 'Pacific Performance Engineerin',  prefix: 'PPE', strip_length: 3, match_via: 'detail' },
  '72434':  { brand_pattern: 'Diamond Eye MFG',                 prefix: 'DEM', strip_length: 3 },
  '83748':  { brand_pattern: 'Icon Suspension (Randys)',        prefix: 'IVD', strip_length: 3 },
  '84847':  { brand_pattern: 'Gator Fasteners',                prefix: 'GTF', strip_length: 3 },
  '115148': { brand_pattern: 'Choate Performance Engineering',  prefix: 'CHT', strip_length: 3 },
  '116519': { brand_pattern: 'FREEDOM OFFROAD',                prefix: 'FRE', strip_length: 3 },
  // NOTE: ASAP returns Zone SKUs WITH the ZON prefix already (e.g.,
  // ZONF111F-FQMS). After backfill ran, mfg_sku was reverted to equal
  // sku via SQL UPDATE so matching works. Until we refactor the
  // normalizer to handle per-brand APG-prefix-included SKUs, running
  // --backfill-only on this brand is a no-op (will re-strip and break
  // matching again).
  '130082': { brand_pattern: 'Zone Offroad (Fox)',              prefix: 'ZON', strip_length: 3 },
  '130085': { brand_pattern: 'BDS Suspension (Fox)',            prefix: 'BDS', strip_length: 3 },
  '130108': { brand_pattern: 'FOX',                             prefix: 'FOX', strip_length: 3 },
  '175491': { brand_pattern: 'BD Diesel',                       prefix: 'BDD', strip_length: 3 },
  '194765': { brand_pattern: 'Bilstein',                        prefix: 'BIL', strip_length: 3 },
  '194845': { brand_pattern: 'Edge Products (Holley)',          prefix: 'EDG', strip_length: 3 },
  '194929': { brand_pattern: 'Flowmaster (Holley)',            prefix: 'FLM', strip_length: 3 },
  '195297': { brand_pattern: 'AEM Electronics (Holley)',       prefix: 'AEI', strip_length: 3 },
  '196448': { brand_pattern: 'Accell (Holley)',                 prefix: 'ACC', strip_length: 3 },
  '197827': { brand_pattern: 'BAK (Real Truck)',                prefix: 'BAK', strip_length: 3 },
  '198463': { brand_pattern: 'Go Rhino (Real Truck)',           prefix: 'RHI', strip_length: 3 },
  '198918': { brand_pattern: 'Bushwacker (Real Truck)',        prefix: 'BWK', strip_length: 3 },
  '199076': { brand_pattern: 'AMP Research (Real Truck)',      prefix: 'AMP', strip_length: 3 },
  '199410': { brand_pattern: 'Superlift (Real Truck)',          prefix: 'SLF', strip_length: 3 },
  '201890': { brand_pattern: 'Extang (Real Truck)',             prefix: 'EXT', strip_length: 3 },
  '202068': { brand_pattern: 'Truxedo Inc (Real Truck)',       prefix: 'TXO', strip_length: 3 },
  '202487': { brand_pattern: 'Lund (Real Truck)',               prefix: 'AVS', strip_length: 3 },
  '202782': { brand_pattern: 'Carli Suspension (Randys)',       prefix: 'CIS', strip_length: 3 },
  '203662': { brand_pattern: 'Dynatrac (Randys)',              prefix: 'DYN', strip_length: 3 },
  '204071': { brand_pattern: 'Hays Performance (Holley)',      prefix: 'HAY', strip_length: 3 },
  '204433': { brand_pattern: 'Rugged Ridge (Real Truck)',       prefix: 'RGR', strip_length: 3 },
  '206132': { brand_pattern: 'Retrax (Real Truck)',             prefix: 'RTX', strip_length: 3 },
  '206187': { brand_pattern: 'UnderCover Inc (Real Truck)',     prefix: 'UNC', strip_length: 3 }
};

// =====================================================================
// CLI
// =====================================================================
function parseArgs(argv) {
  const out = {
    dryRun: true,
    skipBackfill: false,
    backfillOnly: false,
    onlyBrands: null,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.dryRun = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-backfill') out.skipBackfill = true;
    else if (a === '--backfill-only') out.backfillOnly = true;
    else if (a === '--only-brands') {
      out.onlyBrands = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      console.warn(`Unknown arg: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.error([
    'Usage: node scripts/importers/asap-bulk-import.js [options]',
    '',
    '  --dry-run                Default. Each brand runs in dry-run; backfill counts only.',
    '  --commit                 Commit both backfill UPDATEs and import UPDATEs.',
    '  --skip-backfill          Skip the per-brand mfg_sku prefix-strip backfill.',
    '  --backfill-only          Run only the prefix backfill across all PREFIX_RULES brands;',
    '                           do NOT spawn asap-import.js or call the ASAP API.',
    '  --only-brands "id1,id2"  Comma-separated brand IDs to include.',
    '',
    'Examples:',
    '  node scripts/importers/asap-bulk-import.js --only-brands "196448,197827,83748,877"',
    '  node scripts/importers/asap-bulk-import.js --backfill-only            # dry-run, all rules',
    '  node scripts/importers/asap-bulk-import.js --backfill-only --commit   # apply backfill UPDATEs',
    '  node scripts/importers/asap-bulk-import.js --commit  # full run, all approved brands'
  ].join('\n'));
  process.exit(0);
}

if (args.backfillOnly && args.skipBackfill) {
  console.error(
    'ERROR: --skip-backfill is incompatible with --backfill-only ' +
    '(the script would have nothing to do). Remove one flag and re-run.'
  );
  process.exit(2);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  process.exit(2);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// =====================================================================
// HELPERS
// =====================================================================
function loadBrands() {
  if (!fs.existsSync(BRANDS_FILE)) {
    throw new Error(
      `Brand list not found at ${BRANDS_FILE}. Run scripts/diagnostics/probe-asap.js first to populate it.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8'));
  const list = Array.isArray(raw.brands) ? raw.brands : Object.values(raw.brands || {});
  return list.filter((b) => b && b.brand_id && b.name);
}

async function backfillMfgSku(brand, rule) {
  // Read-only stats queries: counts of products under this brand that
  // (a) already have mfg_sku populated and (b) have mfg_sku NULL but
  // whose `sku` doesn't start with the APG prefix (the guard catches these).
  const { count: preExisting, error: preErr } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .ilike('brand', rule.brand_pattern)
    .eq('status', 'active')
    .not('mfg_sku', 'is', null);
  if (preErr) throw new Error(`pre-existing count failed: ${preErr.message}`);

  const { count: skippedNoPrefix, error: skipErr } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .ilike('brand', rule.brand_pattern)
    .eq('status', 'active')
    .is('mfg_sku', null)
    .not('sku', 'like', `${rule.prefix}%`);
  if (skipErr) throw new Error(`skipped count failed: ${skipErr.message}`);

  // Paginated fetch via .range() — Supabase enforces a server-side 1000-row
  // cap on .limit(), so we page through results in 1000-row chunks. MAX_PAGES
  // guards against an infinite loop in case of a bug; throws rather than
  // silently truncating when the cap is hit.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 100;
  const data = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: pageData, error } = await supabase
      .from('products')
      .select('id, sku')
      .ilike('brand', rule.brand_pattern)
      .eq('status', 'active')
      .like('sku', `${rule.prefix}%`)
      .is('mfg_sku', null)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error(`backfill select failed: ${error.message}`);
    if (!pageData || pageData.length === 0) break;
    data.push(...pageData);
    if (pageData.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      throw new Error(
        `backfill select exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows) for ` +
        `brand_pattern='${rule.brand_pattern}'; refusing to continue silently.`
      );
    }
  }
  if (!data || data.length === 0) {
    return {
      pre_existing_mfg_sku: preExisting || 0,
      skipped_no_prefix: skippedNoPrefix || 0,
      matched: 0,
      applied: 0,
      sample: []
    };
  }

  const sample = data.slice(0, 3).map((r) => ({
    id: r.id,
    old_sku: r.sku,
    new_mfg_sku: r.sku.substring(rule.strip_length)
  }));

  if (args.dryRun) {
    return {
      pre_existing_mfg_sku: preExisting || 0,
      skipped_no_prefix: skippedNoPrefix || 0,
      matched: data.length,
      applied: 0,
      sample
    };
  }

  // Sequential per-row UPDATE in small parallel batches. Cannot use Supabase
  // upsert because products has NOT NULL columns without defaults; cannot use
  // a column expression in update because PostgREST forbids it. For Icon-scale
  // backfills (potentially thousands of rows), consider creating a Postgres
  // RPC `strip_prefix_backfill(brand_pattern, prefix)` and calling .rpc().
  const CONCURRENCY = 20;
  let applied = 0;
  for (let i = 0; i < data.length; i += CONCURRENCY) {
    const batch = data.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((r) =>
        supabase
          .from('products')
          .update({ mfg_sku: r.sku.substring(rule.strip_length) })
          .eq('id', r.id)
      )
    );
    for (const res of results) {
      if (res.error) throw new Error(`backfill update failed: ${res.error.message}`);
      applied++;
    }
  }
  return {
    pre_existing_mfg_sku: preExisting || 0,
    skipped_no_prefix: skippedNoPrefix || 0,
    matched: data.length,
    applied,
    sample
  };
}

function runImportChild(brand) {
  return new Promise((resolve) => {
    const brandId = brand.brand_id;
    const rule = PREFIX_RULES[String(brandId)];
    const childArgs = [IMPORT_SCRIPT, '--brand-id', String(brandId)];
    if (rule && rule.brand_pattern) {
      childArgs.push('--brand-pattern', rule.brand_pattern);
    }
    if (rule && rule.match_via) {
      childArgs.push('--match-via', rule.match_via);
    }
    if (brand.name) {
      childArgs.push('--brand-name', brand.name);
    }
    if (!args.dryRun) childArgs.push('--commit');
    // (--dry-run is the default for the child too; no need to pass)

    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('exit', (code) => resolve({ exitCode: code, stderr }));
    child.on('error', (err) => resolve({ exitCode: -1, stderr: err.message }));
  });
}

async function fetchLatestRunForBrand(brandId, sinceIso) {
  const { data, error } = await supabase
    .from('asap_import_runs')
    .select('*')
    .eq('brand_id', String(brandId))
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
}

// =====================================================================
// BACKFILL-ONLY ORCHESTRATOR
// =====================================================================
// Loops every rule in PREFIX_RULES (or the --only-brands subset) and
// invokes backfillMfgSku for each. Does NOT spawn asap-import.js or call
// the ASAP API. Used to populate mfg_sku across all approved brands once
// before a full bulk import run.
async function runBackfillOnly() {
  const brandLookup = {};
  try {
    const brands = loadBrands();
    for (const b of brands) brandLookup[String(b.brand_id)] = b.name;
  } catch (err) {
    console.warn(`Could not load brand names (using IDs only): ${err.message}`);
  }

  let ruleEntries = Object.entries(PREFIX_RULES);
  if (args.onlyBrands) {
    ruleEntries = ruleEntries.filter(([id]) => args.onlyBrands.includes(id));
  }

  if (ruleEntries.length === 0) {
    console.error('No prefix rules to run. Aborting.');
    process.exit(2);
  }

  const startTime = new Date();
  const ts = startTime.toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${ts}-backfill-only.json`);

  console.log(
    `ASAP backfill-only — ${ruleEntries.length} rule(s) | ` +
    `mode=${args.dryRun ? 'DRY-RUN' : 'COMMIT'}`
  );
  console.log(`Master log: ${path.relative(process.cwd(), logPath)}`);
  console.log('');

  const log = {
    started_at: startTime.toISOString(),
    completed_at: null,
    mode: args.dryRun ? 'dry-run' : 'commit',
    rule_count: ruleEntries.length,
    rules: []
  };
  const flush = () => fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  flush();

  let totMatched = 0;
  let totApplied = 0;
  let totSkipped = 0;
  let totPreExisting = 0;
  let failed = 0;

  for (const [brandId, rule] of ruleEntries) {
    const name = brandLookup[brandId] || `(brand_id=${brandId})`;
    console.log(
      `>>> ${name} [brand_id=${brandId}] prefix=${rule.prefix} ` +
      `pattern='${rule.brand_pattern}'`
    );
    const entry = { brand_id: brandId, brand_name: name, rule, stats: null, error: null };

    try {
      const stats = await backfillMfgSku({ brand_id: brandId, name }, rule);
      entry.stats = stats;
      totMatched += stats.matched;
      totApplied += stats.applied;
      totSkipped += stats.skipped_no_prefix;
      totPreExisting += stats.pre_existing_mfg_sku;
      console.log(
        `    matched=${stats.matched} applied=${stats.applied} ` +
        `skipped_no_prefix=${stats.skipped_no_prefix} pre_existing=${stats.pre_existing_mfg_sku}`
      );
      if (stats.sample.length > 0) {
        console.log(`    Sample (first 3):`);
        stats.sample.forEach((s) => console.log(`      ${s.old_sku} → ${s.new_mfg_sku}`));
      }
    } catch (err) {
      entry.error = err.message;
      failed++;
      console.error(`    ERROR: ${err.message}`);
    }

    log.rules.push(entry);
    flush();
    console.log('');
  }

  log.completed_at = new Date().toISOString();
  flush();

  console.log('========================================================');
  console.log('BACKFILL-ONLY SUMMARY');
  console.log('========================================================');
  console.log(`Mode:                       ${args.dryRun ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Rules processed:            ${ruleEntries.length}`);
  console.log(`Rules failed:               ${failed}`);
  console.log(`Total matched (candidates): ${totMatched}`);
  console.log(`Total applied (UPDATEs):    ${totApplied}`);
  console.log(`Total skipped (no prefix):  ${totSkipped}`);
  console.log(`Total pre-existing mfg_sku: ${totPreExisting}`);
  console.log(`Master log:                 ${path.relative(process.cwd(), logPath)}`);
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  if (args.backfillOnly) {
    return runBackfillOnly();
  }

  const startTime = new Date();
  const ts = startTime.toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${ts}.json`);

  const allBrands = loadBrands();
  const brands = args.onlyBrands
    ? allBrands.filter((b) => args.onlyBrands.includes(String(b.brand_id)))
    : allBrands;

  if (brands.length === 0) {
    console.error('No brands matched the filter. Aborting.');
    if (args.onlyBrands) {
      console.error(`Filter was: ${args.onlyBrands.join(', ')}`);
      console.error(`Approved brand IDs available: ${allBrands.map((b) => b.brand_id).join(', ')}`);
    }
    process.exit(2);
  }

  console.log(
    `ASAP bulk import — ${brands.length} brand(s) | mode=${args.dryRun ? 'DRY-RUN' : 'COMMIT'} | backfill=${
      args.skipBackfill ? 'SKIP' : 'ON'
    }`
  );
  console.log(`Master log: ${path.relative(process.cwd(), logPath)}`);

  const masterLog = {
    started_at: startTime.toISOString(),
    completed_at: null,
    mode: args.dryRun ? 'dry-run' : 'commit',
    skip_backfill: args.skipBackfill,
    only_brands: args.onlyBrands,
    brand_count: brands.length,
    brands: []
  };
  const flush = () => fs.writeFileSync(logPath, JSON.stringify(masterLog, null, 2));
  flush();

  for (const brand of brands) {
    const brandStart = new Date();
    console.log('');
    console.log('========================================================');
    console.log(`>>> ${brand.name} (brand_id=${brand.brand_id}) | ${brandStart.toISOString()}`);
    console.log('========================================================');

    const entry = {
      brand_id: String(brand.brand_id),
      brand_name: brand.name,
      started_at: brandStart.toISOString(),
      completed_at: null,
      backfill: null,
      import_run: null,
      exit_code: null,
      stderr_preview: null
    };

    // 1. Backfill
    const rule = PREFIX_RULES[String(brand.brand_id)];
    if (rule && !args.skipBackfill) {
      console.log(
        `Backfill mfg_sku — prefix='${rule.prefix}', brand_pattern='${rule.brand_pattern}'`
      );
      try {
        const r = await backfillMfgSku(brand, rule);
        entry.backfill = { prefix: rule.prefix, brand_pattern: rule.brand_pattern, ...r };
        console.log(
          `  matched=${r.matched} applied=${r.applied} ` +
          `skipped_no_prefix=${r.skipped_no_prefix} pre_existing=${r.pre_existing_mfg_sku}`
        );
        if (r.sample.length > 0) {
          console.log(`  Sample (first 3):`);
          r.sample.forEach((s) => console.log(`    ${s.old_sku} → ${s.new_mfg_sku}`));
        }
      } catch (err) {
        entry.backfill = { prefix: rule.prefix, error: err.message };
        console.error(`  Backfill failed: ${err.message}`);
      }
    } else if (rule) {
      console.log(`Backfill rule exists but --skip-backfill set; skipping.`);
      entry.backfill = { prefix: rule.prefix, skipped: true };
    } else {
      entry.backfill = { rule: null, note: 'no prefix rule defined for this brand' };
    }

    // 2. Spawn import
    console.log(`Invoking ${IMPORT_SCRIPT} --brand-id ${brand.brand_id}${args.dryRun ? '' : ' --commit'}`);
    const childResult = await runImportChild(brand);
    entry.exit_code = childResult.exitCode;
    if (childResult.exitCode !== 0) {
      entry.stderr_preview = childResult.stderr.slice(-500);
      console.error(`Brand ${brand.name} import exited ${childResult.exitCode}; continuing.`);
    }

    // 3. Pull run row
    try {
      entry.import_run = await fetchLatestRunForBrand(brand.brand_id, brandStart.toISOString());
    } catch (err) {
      entry.import_run = { error: err.message };
    }

    entry.completed_at = new Date().toISOString();
    masterLog.brands.push(entry);
    flush();
  }

  masterLog.completed_at = new Date().toISOString();
  flush();

  // Final summary
  let totSkus = 0;
  let totActive = 0;
  let totResurrected = 0;
  let totSkipTagged = 0;
  let totSkipNoDiesel = 0;
  let totUnmatched = 0;
  let totErrors = 0;
  let failedBrands = 0;
  let incompleteBrands = 0;

  for (const b of masterLog.brands) {
    if (b.exit_code !== 0) failedBrands++;
    const r = b.import_run;
    if (r && !r.error) {
      if (!r.completed_at) incompleteBrands++;
      totSkus += r.asap_sku_count || 0;
      totActive += r.matched_active || 0;
      totResurrected += r.matched_archived_resurrected || 0;
      totSkipTagged += r.matched_archived_skipped_tagged || 0;
      totSkipNoDiesel += r.matched_archived_skipped_no_diesel_fitment || 0;
      totUnmatched += r.unmatched || 0;
      totErrors += r.errors || 0;
    }
  }

  console.log('');
  console.log('========================================================');
  console.log('BULK IMPORT SUMMARY');
  console.log('========================================================');
  console.log(`Mode:                   ${args.dryRun ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Brands processed:       ${masterLog.brands.length}`);
  console.log(`Brands failed (exit≠0): ${failedBrands}`);
  console.log(`Brands incomplete:      ${incompleteBrands}  (run row missing completed_at)`);
  console.log(`Total ASAP SKUs:        ${totSkus}`);
  console.log(`Active updated:         ${totActive}`);
  console.log(`Archived resurrected:   ${totResurrected}`);
  console.log(`Archived skip tagged:   ${totSkipTagged}`);
  console.log(`Archived skip no diesel:${totSkipNoDiesel}`);
  console.log(`Unmatched:              ${totUnmatched}`);
  console.log(`Per-SKU errors:         ${totErrors}`);
  console.log(`Master log:             ${path.relative(process.cwd(), logPath)}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
