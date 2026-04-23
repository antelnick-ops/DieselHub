require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const path = require('path');
const { Client } = require('basic-ftp');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const TMP_DIR = path.join(process.cwd(), 'tmp');
const ZIP_PATH = path.join(TMP_DIR, 'ItemExport.zip');
const CSV_PATH = path.join(TMP_DIR, 'StandardExport.csv');

async function downloadExport() {
  const client = new Client();
  client.ftp.verbose = false;
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

  try {
    await client.access({
      host: process.env.APG_FTP_HOST,
      user: process.env.APG_FTP_USER,
      password: process.env.APG_FTP_PASSWORD,
      secure: false
    });
    console.log('Downloading ItemExport.zip...');
    await client.downloadTo(ZIP_PATH, 'ItemExport.zip');
    const size = fs.statSync(ZIP_PATH).size;
    console.log(`Downloaded ${(size / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    client.close();
  }

  console.log('Extracting...');
  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(TMP_DIR, true);
}

function parseWarehouseAvailability(text) {
  // Format: "Nevada Warehouse :0;Kentucky Warehouse :0;Texas Warehouse :0;Shock Surplus Whse :0;Washington Warehouse :0;"
  if (!text) return { shockSurplus: 0 };
  const shockMatch = text.match(/Shock\s*Surplus\s*Whse\s*:\s*(\d+)/i);
  return {
    shockSurplus: shockMatch ? parseInt(shockMatch[1], 10) : 0
  };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,"]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  await downloadExport();

  console.log(`\nReading ${CSV_PATH}...`);
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(csvText, {
    columns: true,
    delimiter: '|',
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    quote: false,
    trim: true
  });
  console.log(`Parsed ${rows.length} rows`);

  // Build update payloads keyed by SKU
  const updates = new Map();
  for (const row of rows) {
    const sku = (row['Part Number'] || '').trim();
    if (!sku) continue;

    const yourPrice = toNumber(row['Your Price']);
    const inventoryType = (row['Inventory Type'] || '').trim();
    const isStocking = inventoryType.toLowerCase() === 'stocking';
    const { shockSurplus } = parseWarehouseAvailability(row['Warehouse Availability']);

    updates.set(sku, {
      wholesale_price: yourPrice,
      is_stocking_item: isStocking,
      shock_surplus_stock: shockSurplus
    });
  }
  console.log(`Prepared ${updates.size} SKU updates`);

  // Fetch all existing APG SKUs in batches to get their IDs
  console.log('Fetching existing APG product IDs...');
  const skuToId = new Map();
  const FETCH_BATCH = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku')
      .eq('vendor_id', APG_VENDOR_ID)
      .range(from, from + FETCH_BATCH - 1)
      .order('id');
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) skuToId.set(row.sku, row.id);
    from += FETCH_BATCH;
    process.stdout.write(`\r  Fetched ${skuToId.size} IDs...`);
  }
  console.log(`\nFound ${skuToId.size} APG products in DB`);

  // Apply updates in batches (URL length safe)
  console.log('\nApplying updates...');
  const UPDATE_BATCH = 200;
  const skuList = [...updates.keys()];
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < skuList.length; i += UPDATE_BATCH) {
    const chunk = skuList.slice(i, i + UPDATE_BATCH);

    // Group updates by identical payload to batch them
    // For simplicity: update each SKU individually using .update().eq()
    // More efficient: use upsert with id, but we'd need to fetch full rows

    for (const sku of chunk) {
      const id = skuToId.get(sku);
      if (!id) { skipped++; continue; }

      const payload = updates.get(sku);
      const { error } = await supabase
        .from('products')
        .update(payload)
        .eq('id', id);

      if (error) {
        console.error(`Failed on SKU ${sku}:`, error.message);
        continue;
      }
      updated++;
    }

    process.stdout.write(`\r  Updated ${updated} / ${skuList.length} (${skipped} skipped)`);
  }
  console.log(`\n\nDone. Updated ${updated}, skipped ${skipped} (no matching SKU in products table).`);

  // Stocking summary
  const stockingCount = [...updates.values()].filter(u => u.is_stocking_item).length;
  console.log(`Stocking items in feed: ${stockingCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
