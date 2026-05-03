require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';

const tmpDir = path.join(__dirname, '..', 'tmp');
if(!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

async function main(){
  console.log('Querying Supabase for alternator-related products...\n');

  const explicit = await supabase
    .from('products')
    .select('sku, brand, product_name, category, price, wholesale_price, stage, is_stocking_item, fitment_text')
    .eq('vendor_id', APG_VENDOR_ID)
    .eq('status', 'active')
    .eq('is_visible', true)
    .or('product_name.ilike.%alternator%,category.ilike.%alternator%,description.ilike.%alternator%')
    .order('price');

  if(explicit.error){ console.error(explicit.error); process.exit(1); }

  console.log('=== Products mentioning alternator ===');
  console.log('Count:', explicit.data.length);

  const brands = ['Bosch', 'Motorcraft', 'Mopar OE', 'ACDelco', 'AC Delco',
                  'Denso', 'DC Power', 'Mechman', 'Powermaster', 'JS Alternators',
                  'Nations', 'Leece-Neville', 'Balmar'];

  const byBrand = await supabase
    .from('products')
    .select('sku, brand, product_name, category, price, wholesale_price, stage, is_stocking_item')
    .eq('vendor_id', APG_VENDOR_ID)
    .eq('status', 'active')
    .eq('is_visible', true)
    .in('brand', brands)
    .order('brand')
    .order('product_name');

  if(byBrand.error){ console.error(byBrand.error); process.exit(1); }

  console.log('\n=== Products from charging/electrical brands ===');
  console.log('Count:', byBrand.data.length);

  const brandBreakdown = {};
  byBrand.data.forEach(p => {
    brandBreakdown[p.brand] = (brandBreakdown[p.brand] || 0) + 1;
  });
  Object.entries(brandBreakdown).forEach(([b, c]) => {
    console.log('  ' + b + ': ' + c + ' products');
  });

  const electrical = await supabase
    .from('products')
    .select('sku, brand, product_name, category, price, wholesale_price, stage, is_stocking_item')
    .eq('vendor_id', APG_VENDOR_ID)
    .eq('status', 'active')
    .eq('is_visible', true)
    .or('category.ilike.%electrical%,category.ilike.%charging%')
    .order('price')
    .limit(200);

  if(electrical.error){ console.error(electrical.error); process.exit(1); }

  console.log('\n=== Products in electrical/charging categories ===');
  console.log('Count:', electrical.data.length);
  const catBreakdown = {};
  electrical.data.forEach(p => {
    catBreakdown[p.category] = (catBreakdown[p.category] || 0) + 1;
  });
  Object.entries(catBreakdown).forEach(([c, n]) => {
    console.log('  ' + c + ': ' + n + ' products');
  });

  const escape = s => {
    if(s === null || s === undefined) return '';
    const str = String(s).replace(/"/g, '""');
    if(str.includes(',') || str.includes('\n') || str.includes('"')) return '"' + str + '"';
    return str;
  };

  const allRows = [];
  explicit.data.forEach(p => allRows.push({ bucket: 'alternator-mention', ...p }));
  byBrand.data.forEach(p => allRows.push({ bucket: 'electrical-brand', ...p }));
  electrical.data.forEach(p => allRows.push({ bucket: 'electrical-category', ...p }));

  const headers = ['bucket','sku','brand','product_name','category','price','wholesale_price','stage','is_stocking_item','fitment_text'];
  const csv = [headers.join(',')].concat(
    allRows.map(r => headers.map(h => escape(r[h] !== undefined ? r[h] : '')).join(','))
  ).join('\n');

  const outPath = path.join(tmpDir, 'alternator-audit.csv');
  fs.writeFileSync(outPath, csv);

  console.log('\nCSV written to:', outPath);
  console.log('Total rows:', allRows.length);
}

main().catch(e => { console.error(e); process.exit(1); });
