require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TESTS = [
  {
    label: 'lift pump for 5.9 cummins (engine="5.9 Cummins", year=2005)',
    args: {
      search_query: 'lift pump for 5.9 cummins',
      filter_engine: '5.9 Cummins',
      filter_year: 2005,
      result_limit: 5,
    },
  },
  {
    label: 'EGR delete kit (engine="6.7 Cummins")',
    args: {
      search_query: 'EGR delete kit',
      filter_engine: '6.7 Cummins',
      result_limit: 5,
    },
  },
  {
    label: 'cold air intake (no filters)',
    args: {
      search_query: 'cold air intake',
      result_limit: 5,
    },
  },
];

(async () => {
  for (const t of TESTS) {
    console.log(`\n=== ${t.label} ===`);
    const { data, error } = await supabase.rpc('search_products', t.args);
    if (error) {
      console.error('  Error:', error.message);
      continue;
    }
    if (!data || data.length === 0) {
      console.log('  No results.');
      continue;
    }
    for (const r of data) {
      const rank = typeof r.rank === 'number' ? r.rank.toFixed(4) : String(r.rank);
      console.log(`  [${rank}] ${r.sku}  ${r.brand}  —  ${r.product_name}`);
      console.log(`         source=${r.data_source}  url=${r.product_url}`);
    }
  }
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
