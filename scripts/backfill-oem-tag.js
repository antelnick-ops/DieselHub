require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const DRY_RUN = true;

// OEM-exclusive brand names (strong signal)
const OEM_BRANDS = [
  'motorcraft',
  'mopar oe',
  'acdelco',
  'ac delco',
  'genuine ford',
  'genuine mopar',
  'genuine gm',
  'genuine chrysler',
  'genuine motorcraft'
];

// Specific phrases that mean the product IS OEM (not just references OEM)
const OEM_KEYWORDS = [
  '(oem)',
  'oe replacement',
  'oe-replacement',
  'oe-spec',
  'factory replacement',
  'original equipment',
  'genuine oem'
];

function inferOem(product) {
  const brand = (product.brand || '').toLowerCase();
  const name = (product.product_name || '').toLowerCase();
  const desc = (product.description || '').toLowerCase();
  const combined = name + ' ' + desc;

  for (const b of OEM_BRANDS) {
    if (brand.includes(b)) return true;
  }
  for (const k of OEM_KEYWORDS) {
    if (combined.includes(k)) return true;
  }
  return false;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  }

  console.log('DRY_RUN:', DRY_RUN);
  console.log('Fetching active APG products with stage=null...');

  const products = [];
  let from = 0;
  const BATCH = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, product_name, brand, description, stage')
      .eq('vendor_id', APG_VENDOR_ID)
      .eq('status', 'active')
      .is('stage', null)
      .range(from, from + BATCH - 1)
      .order('id');

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const p of data) products.push(p);
    from += BATCH;
    process.stdout.write(`\r  Fetched ${products.length} untagged products...`);
    if (data.length < BATCH) break;
  }

  console.log(`\nTotal untagged: ${products.length}`);

  const oemProducts = products.filter((p) => inferOem(p));
  console.log('\n=== OEM inference summary ===');
  console.log(`OEM (stage=0): ${oemProducts.length}`);
  console.log(`Still untagged: ${products.length - oemProducts.length}`);

  console.log('\n--- OEM samples ---');
  oemProducts.slice(0, 10).forEach((p) => {
    console.log(`  [${p.brand}] ${(p.product_name || '').substring(0, 90)}`);
  });

  if (DRY_RUN) {
    console.log('\nDRY RUN -- no writes. Set DRY_RUN=false to tag these products as stage 0.');
    return;
  }

  if (!oemProducts.length) {
    console.log('\nNothing to update.');
    return;
  }

  console.log('\nWriting stage=0 to OEM products in batches of 500...');
  const CHUNK = 500;
  const ids = oemProducts.map((p) => p.id);

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('products')
      .update({ stage: 0 })
      .in('id', chunk);
    if (error) {
      console.error(`\nChunk starting at ${i} failed:`, error.message);
      throw error;
    }
    process.stdout.write(`\r  Updated ${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
  }

  console.log('\n\nOEM backfill complete.');
}

main().catch((err) => {
  console.error('OEM backfill failed:', err.message);
  process.exit(1);
});
