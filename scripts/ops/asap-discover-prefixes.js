require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// =====================================================================
// Discovery script: empirically derive APG SKU prefixes per ASAP-approved
// brand by sampling BSD's products table. Read-only; writes a JSON report
// to tmp/asap-prefix-discovery.json. Use the output to populate
// PREFIX_RULES in scripts/asap-bulk-import.js — but only for HIGH-
// confidence rows. MEDIUM needs review; LOW/UNKNOWN should not be added.
// =====================================================================

const BRANDS_FILE = path.join(process.cwd(), 'tmp', 'asap_approved_brands.json');
const OUTPUT_FILE = path.join(process.cwd(), 'tmp', 'asap-prefix-discovery.json');
const SAMPLE_SIZE = 10;
const PREFIX_LEN = 3;

// Hand-tuned brand_pattern overrides for ASAP brand_ids whose auto-derived
// ILIKE patterns over-match into unrelated BSD brands (e.g. %holley% picks
// up 22 "(Holley)" sub-brands; %fox% picks up "BDS Suspension (Fox)").
// When a brand_id appears here, this pattern replaces auto-derivation
// entirely. Pattern goes straight into a single `brand ILIKE <pattern>`
// query — include % wildcards explicitly if you want them, omit for exact
// (case-insensitive) match.
const OVERRIDE_PATTERNS = {
  '963':    'Holley',          // exact — no Holley sub-brands
  '3589':   'Rock Krawler',    // exact — no other "Rock*" brands
  '10916':  'USA Standard%',   // wildcard suffix for "(Randys)" variant
  '130108': 'FOX'              // exact, all-caps in BSD; not BDS
};

// CLI: --brand-ids "id1,id2" filters to a subset (used for re-runs after
// fixing override patterns). When filtering, results are merged into the
// existing tmp/asap-prefix-discovery.json rather than overwriting it.
function parseArgs(argv) {
  const out = { brandIds: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brand-ids') {
      out.brandIds = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.error('Usage: node scripts/asap-discover-prefixes.js [--brand-ids "id1,id2"]');
      process.exit(0);
    } else {
      console.warn(`Unknown arg: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  process.exit(2);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function loadBrands() {
  if (!fs.existsSync(BRANDS_FILE)) {
    throw new Error(`Brand list not found at ${BRANDS_FILE}`);
  }
  const raw = JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8'));
  const list = Array.isArray(raw.brands) ? raw.brands : Object.values(raw.brands || {});
  return list.filter((b) => b && b.brand_id && b.name);
}

// Build ILIKE patterns to probe BSD's `brand` column. If the brand_id has
// an OVERRIDE_PATTERNS entry, return that single pattern verbatim and skip
// auto-derivation. Otherwise: try the full ASAP name and term_name (broad,
// accepts parenthetical suffixes like "Holley (Real Truck)") plus the
// first word as a fallback for cases where BSD shortens the brand string.
function buildPatterns(brandId, asapName, termName) {
  if (OVERRIDE_PATTERNS[String(brandId)]) {
    return [OVERRIDE_PATTERNS[String(brandId)]];
  }
  const patterns = new Set();
  const names = [asapName];
  if (termName && termName !== asapName) names.push(termName);
  for (const n of names) {
    patterns.add(`%${n}%`);
    const firstWord = n.trim().split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3) patterns.add(`%${firstWord}%`);
  }
  return Array.from(patterns);
}

async function findBsdBrandCandidates(patterns) {
  const found = new Set();
  for (const p of patterns) {
    const { data, error } = await supabase
      .from('products')
      .select('brand')
      .ilike('brand', p)
      .eq('status', 'active')
      .limit(500);
    if (error) throw new Error(`brand probe failed for ${p}: ${error.message}`);
    for (const row of data || []) {
      if (row.brand) found.add(row.brand);
    }
  }
  return Array.from(found).sort();
}

async function sampleSkusForBsdBrand(bsdBrand, n) {
  const { data, error } = await supabase
    .from('products')
    .select('sku')
    .eq('brand', bsdBrand)
    .eq('status', 'active')
    .not('sku', 'is', null)
    .limit(n);
  if (error) throw new Error(`sku sample failed for ${bsdBrand}: ${error.message}`);
  return (data || []).map((r) => r.sku).filter(Boolean);
}

// Tally prefix frequencies across the sampled SKUs and pick the most
// common 3-char prefix. The match_count is how many SKUs share that
// dominant prefix; total_sampled is the full sample size. Confidence
// is the ratio.
function detectPrefix(skus, length = PREFIX_LEN) {
  const counts = new Map();
  for (const s of skus) {
    if (!s || s.length < length) continue;
    const p = s.slice(0, length);
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  if (counts.size === 0) return { prefix: null, matchCount: 0 };
  let best = null;
  let bestCount = 0;
  for (const [p, c] of counts) {
    if (c > bestCount) {
      best = p;
      bestCount = c;
    }
  }
  return { prefix: best, matchCount: bestCount };
}

function classifyConfidence(matchCount, total) {
  if (total === 0) return 'UNKNOWN';
  const ratio = matchCount / total;
  if (ratio === 1.0 && total >= 5) return 'HIGH';
  if (ratio >= 0.8) return 'MEDIUM';
  return 'LOW';
}

async function main() {
  const allBrands = loadBrands();
  const brands = args.brandIds
    ? allBrands.filter((b) => args.brandIds.includes(String(b.brand_id)))
    : allBrands;

  if (args.brandIds && brands.length === 0) {
    console.error(`No brands matched filter: ${args.brandIds.join(', ')}`);
    console.error(`Available IDs: ${allBrands.map((b) => b.brand_id).join(', ')}`);
    process.exit(2);
  }

  if (args.brandIds && brands.length < args.brandIds.length) {
    const found = new Set(brands.map((b) => String(b.brand_id)));
    const missing = args.brandIds.filter((id) => !found.has(id));
    console.warn(`Warning: ${missing.length} requested ID(s) not in approved brands: ${missing.join(', ')}`);
  }

  console.log(
    `Discovering prefixes for ${brands.length} ASAP-approved brand(s)${
      args.brandIds ? ` (filtered)` : ''
    }...`
  );
  console.log('');

  // When filtered, merge into existing report; otherwise start fresh.
  let result;
  if (args.brandIds && fs.existsSync(OUTPUT_FILE)) {
    result = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    result.discovered_at = new Date().toISOString();
    if (!result.brands) result.brands = {};
  } else {
    result = {
      discovered_at: new Date().toISOString(),
      sample_size: SAMPLE_SIZE,
      prefix_length: PREFIX_LEN,
      brands: {}
    };
  }

  for (const brand of brands) {
    const patterns = buildPatterns(brand.brand_id, brand.name, brand.term_name);
    const usedOverride = Boolean(OVERRIDE_PATTERNS[String(brand.brand_id)]);

    let candidates = [];
    try {
      candidates = await findBsdBrandCandidates(patterns);
    } catch (err) {
      console.error(`  ${brand.brand_id} ${brand.name}: probe error: ${err.message}`);
    }

    // Sample across all candidate BSD brands until we hit SAMPLE_SIZE.
    // If a single candidate is the right one, its samples will dominate.
    // If candidates are noisy (over-matched short tokens like 'BAK'),
    // the prefix detector will report LOW confidence and flag for review.
    const skus = [];
    for (const c of candidates) {
      if (skus.length >= SAMPLE_SIZE) break;
      const remaining = SAMPLE_SIZE - skus.length;
      const rows = await sampleSkusForBsdBrand(c, remaining);
      skus.push(...rows);
    }

    const { prefix, matchCount } = detectPrefix(skus);
    const confidence = classifyConfidence(matchCount, skus.length);

    result.brands[brand.brand_id] = {
      asap_name: brand.name,
      bsd_brand_candidates: candidates,
      sample_skus: skus,
      prefix,
      confidence,
      match_count: matchCount,
      total_sampled: skus.length,
      pattern_source: usedOverride ? 'override' : 'auto',
      patterns_used: patterns
    };

    console.log(`ASAP brand: ${brand.brand_id} ${brand.name}`);
    console.log(`  Pattern source: ${usedOverride ? 'OVERRIDE' : 'auto'} ${JSON.stringify(patterns)}`);
    console.log(`  BSD brand match candidates: ${JSON.stringify(candidates)}`);
    console.log(`  Sample SKUs: ${JSON.stringify(skus)}`);
    console.log(`  Detected prefix: ${prefix || 'NONE'}`);
    console.log(`  Confidence: ${confidence} (${matchCount}/${skus.length})`);
    console.log('');
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

  // Summary grouped by confidence. In re-run mode, summarize only the
  // brands we just probed; otherwise summarize the full report.
  const summaryIds = args.brandIds
    ? new Set(brands.map((b) => String(b.brand_id)))
    : null;
  const groups = { HIGH: [], MEDIUM: [], LOW: [], UNKNOWN: [] };
  for (const [id, b] of Object.entries(result.brands)) {
    if (summaryIds && !summaryIds.has(String(id))) continue;
    groups[b.confidence].push({ id, ...b });
  }

  console.log('========================================================');
  console.log(`SUMMARY${args.brandIds ? ' (filtered to re-run brands)' : ''}`);
  console.log('========================================================');
  for (const conf of ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']) {
    console.log('');
    console.log(`--- ${conf} (${groups[conf].length}) ---`);
    if (groups[conf].length === 0) {
      console.log('  (none)');
      continue;
    }
    for (const b of groups[conf]) {
      const note =
        conf === 'UNKNOWN'
          ? '(no BSD products sampled)'
          : `prefix=${b.prefix} (${b.match_count}/${b.total_sampled})`;
      console.log(`  ${String(b.id).padStart(7)}  ${b.asap_name.padEnd(32)} ${note}`);
    }
  }

  console.log('');
  console.log(`Output written to ${path.relative(process.cwd(), OUTPUT_FILE)}`);
  console.log('');
  console.log('Next step: review HIGH-confidence rows and add them to PREFIX_RULES');
  console.log('in scripts/asap-bulk-import.js. Do NOT auto-add MEDIUM/LOW/UNKNOWN.');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
