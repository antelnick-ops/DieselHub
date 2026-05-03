require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const DRY_RUN = false;

// Heaviest stage wins when multiple keyword groups match — check 3 first.
const STAGE_KEYWORDS = {
  3: [
    'compound turbo', 'twin turbo', 'built transmission',
    'short block', 'long block', 'engine build', 'complete engine',
    'crate engine', 'stroker', 'street and strip', 'pro mod'
  ],
  2: [
    'turbo upgrade', 'turbocharger kit', 'drop-in turbo', 's366', 's364',
    's369', 's372', 's465', 's475',
    'injector', 'lift pump', 'fuel pump upgrade', 'hpop',
    'high pressure oil pump', 'head stud', 'arp head stud',
    'transmission cooler', 'built trans'
  ],
  1: [
    'cold air intake', 'air intake', 'cat-back', 'cat back exhaust',
    'dpf delete', 'egr delete', 'tuner', 'programmer', 'gauge pod',
    'boost controller', 'performance module', 'tuning module',
    'diesel tuner', 'edge evo', 'edge juice', 'bully dog',
    'cat delete pipe'
  ]
};

function inferStage(product) {
  const haystack = [product.product_name || '', product.description || '']
    .join(' ')
    .toLowerCase();

  for (const stage of [3, 2, 1]) {
    for (const kw of STAGE_KEYWORDS[stage]) {
      if (haystack.includes(kw.toLowerCase())) return stage;
    }
  }
  return null;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  }

  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log('Fetching active APG products...');

  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, description, stage')
      .eq('vendor_id', APG_VENDOR_ID)
      .eq('status', 'active')
      .range(from, from + PAGE - 1)
      .order('id');
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    from += PAGE;
    process.stdout.write(`\r  Fetched ${all.length} products...`);
    if (data.length < PAGE) break;
  }
  console.log(`\nTotal: ${all.length} active APG products`);

  const buckets = { 1: [], 2: [], 3: [], null: [] };
  const samplesByStage = { 1: [], 2: [], 3: [] };

  for (const p of all) {
    const s = inferStage(p);
    if (s === null) {
      buckets.null.push(p.id);
    } else {
      buckets[s].push(p.id);
      if (samplesByStage[s].length < 5) {
        samplesByStage[s].push(p.product_name || '(no name)');
      }
    }
  }

  console.log('\n=== Inference summary ===');
  console.log(`Stage 1: ${buckets[1].length}`);
  console.log(`Stage 2: ${buckets[2].length}`);
  console.log(`Stage 3: ${buckets[3].length}`);
  console.log(`Untagged: ${buckets.null.length}`);

  if (DRY_RUN) {
    for (const s of [1, 2, 3]) {
      console.log(`\n--- Stage ${s} samples ---`);
      samplesByStage[s].forEach((n) => console.log(`  ${n.substring(0, 100)}`));
    }
    console.log('\nDRY RUN — no writes. Set DRY_RUN=false to update the stage column.');
    return;
  }

  const CHUNK = 500;
  for (const stage of [1, 2, 3]) {
    const ids = buckets[stage];
    if (!ids.length) continue;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { error } = await supabase
        .from('products')
        .update({ stage })
        .in('id', chunk);
      if (error) {
        console.error(`\nStage ${stage} chunk starting at ${i} failed:`, error.message);
        throw error;
      }
      process.stdout.write(`\r  Wrote stage=${stage}: ${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
    }
    console.log('');
  }

  console.log('\nBackfill complete.');
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
