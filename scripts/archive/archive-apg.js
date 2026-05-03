require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const BATCH_SIZE = 200;

async function main() {
  console.log('Fetching all APG product IDs...');
  const ids = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id')
      .eq('vendor_id', APG_VENDOR_ID)
      .range(from, from + BATCH_SIZE - 1)
      .order('id');
    if (error) throw error;
    if (!data || data.length === 0) break;
    ids.push(...data.map((r) => r.id));
    from += BATCH_SIZE;
    process.stdout.write(`\r  Collected ${ids.length} IDs...`);
  }
  console.log(`\nTotal APG products to archive: ${ids.length}`);

  console.log('\nArchiving in batches...');
  let archived = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('products')
      .update({ status: 'archived', is_visible: false })
      .in('id', chunk);
    if (error) {
      console.error('Batch failed at offset', i, error);
      throw error;
    }
    archived += chunk.length;
    process.stdout.write(`\r  Archived ${archived} / ${ids.length}`);
  }
  console.log(`\nArchived ${archived} APG products`);

  console.log('\nCleaning NA values in batches...');
  for (const field of ['category', 'image_url', 'brand']) {
    let cleaned = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const { error, count } = await supabase
        .from('products')
        .update({ [field]: null }, { count: 'exact' })
        .in('id', chunk)
        .eq(field, 'NA');
      if (error) throw error;
      cleaned += count || 0;
    }
    console.log(`  Cleaned ${cleaned} rows where ${field} was 'NA'`);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
