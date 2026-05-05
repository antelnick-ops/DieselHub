require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

// =====================================================================
// One-off backfill: populate fitment_makes for products whose product_name
// or description uses "GM" + a Duramax engine code instead of an explicit
// Chevrolet/GMC reference. Mirrors the new GM → [Chevrolet, GMC] rule
// added to parseFitment() in scripts/importers/import-apg-feed.js, and
// applies it retroactively to rows that imported before the rule existed.
//
// Only updates rows where fitment_makes is currently NULL or empty array;
// won't touch products that already have any make populated.
//
// CLI:
//   --dry-run   Default. Counts candidates and prints first samples; no UPDATEs.
//   --commit    Applies UPDATEs row-by-row (one PostgREST call per row).
// =====================================================================

const GM_RE = /\bGM\b/;
const DURAMAX_RE = /\b(Duramax|LB7|LLY|LBZ|LMM|LML|LGH|L5P|L5D)\b/i;
const PAGE_SIZE = 1000;

function parseArgs(argv) {
  const out = { dryRun: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.dryRun = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.error('Usage: node scripts/ops/backfill-gm-makes.js [--dry-run|--commit]');
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

function matchesGmDuramax(productName, description) {
  const text = [productName, description].filter(Boolean).join(' ');
  return GM_RE.test(text) && DURAMAX_RE.test(text);
}

async function main() {
  console.log(`GM → [Chevrolet, GMC] fitment_makes backfill | mode=${args.dryRun ? 'DRY-RUN' : 'COMMIT'}`);
  console.log('');

  // Pull candidate products (empty/null fitment_makes) in pages, filter in JS
  // for the GM+Duramax co-occurrence. Word-boundary regexes can't be expressed
  // in PostgREST without an RPC; the JS pass keeps the rule a single source of
  // truth with parseFitment().
  let cursor = 0;
  let scanned = 0;
  let matched = 0;
  const toUpdate = [];

  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, product_name, description, fitment_makes')
      .or('fitment_makes.is.null,fitment_makes.eq.{}')
      .order('id')
      .range(cursor, cursor + PAGE_SIZE - 1);

    if (error) throw new Error(`page fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    scanned += data.length;

    for (const row of data) {
      if (!matchesGmDuramax(row.product_name, row.description)) continue;
      matched++;
      toUpdate.push({
        id: row.id,
        sku: row.sku,
        product_name: row.product_name,
        new_fitment_makes: ['Chevrolet', 'GMC'],
      });
    }

    if (data.length < PAGE_SIZE) break;
    cursor += PAGE_SIZE;
  }

  console.log(`Scanned (empty/null fitment_makes): ${scanned}`);
  console.log(`Matched GM+Duramax pattern:         ${matched}`);
  console.log(`Would update:                       ${toUpdate.length}`);

  if (toUpdate.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  console.log('\nFirst 5 to update:');
  toUpdate.slice(0, 5).forEach((t) => {
    console.log(`  ${t.sku} | ${t.product_name.slice(0, 80)} → ${JSON.stringify(t.new_fitment_makes)}`);
  });

  if (args.dryRun) {
    console.log('\nDry-run — no writes. Re-run with --commit to apply.');
    return;
  }

  console.log(`\nApplying ${toUpdate.length} updates...`);
  let applied = 0;
  let errors = 0;
  for (let i = 0; i < toUpdate.length; i++) {
    const u = toUpdate[i];
    const { error } = await supabase
      .from('products')
      .update({ fitment_makes: u.new_fitment_makes })
      .eq('id', u.id);
    if (error) {
      errors++;
      console.error(`  ${u.sku}: ${error.message}`);
    } else {
      applied++;
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${toUpdate.length} processed (${applied} ok, ${errors} err)`);
    }
  }

  console.log('');
  console.log(`Done. Applied: ${applied}, errors: ${errors}.`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
