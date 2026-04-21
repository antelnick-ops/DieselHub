require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APG_VENDOR_ID = '013cd9a7-171e-45fe-9421-0320319dce33';
const FEED_PATH = path.join(process.cwd(), 'tmp', 'premier_data_feed_master.csv');
const IMPORT_LIMIT = 2000;

const BRAND_WHITELIST = null;
// Example:
// const BRAND_WHITELIST = new Set(['MBRP', 'Banks', 'AirDog', 'FASS', 'BD Diesel']);

function clean(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v.length ? v : null;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/[$,]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = toNumber(value);
  return n === null ? 0 : Math.max(0, Math.floor(n));
}

function roundMoney(n) {
  return Number(Number(n).toFixed(2));
}

function totalStock(row) {
  return (
    toInt(row['NV whse']) +
    toInt(row['KY whse']) +
    toInt(row['WA whse']) +
    toInt(row['MFG Invt'])
  );
}

function pickPrice(row) {
  const map = toNumber(row['MAP']);
  const retail = toNumber(row['Retail']);
  const customerPrice = toNumber(row['Customer Price']);
  const jobber = toNumber(row['Jobber']);

  if (map && map > 0) return roundMoney(map);
  if (retail && retail > 0) return roundMoney(retail);
  if (customerPrice && customerPrice > 0) return roundMoney(customerPrice);
  if (jobber && jobber > 0) return roundMoney(jobber * 1.3);

  return 0;
}

function productStatus(row, stockQty) {
  const inventoryStatus = clean(row['Inventory Status'])?.toLowerCase() || '';

  if (inventoryStatus.includes('discontinued')) return 'archived';
  if (stockQty <= 0) return 'out_of_stock';
  return 'active';
}

function buildDescription(row) {
  const external = clean(row['External Long Description']);
  const longDesc = clean(row['Long Description']);
  const category = clean(row['Part Category']);
  const subcategory = clean(row['Part Subcategory']);
  const terminology = clean(row['Part Terminology']);
  const brand = clean(row['Brand']);
  const mfgPart = clean(row['Mfg Part Number']);
  const upc = clean(row['Upc']);

  return [
    external,
    !external ? longDesc : null,
    brand ? `Brand: ${brand}` : null,
    mfgPart ? `MFG Part #: ${mfgPart}` : null,
    upc ? `UPC: ${upc}` : null,
    category ? `Category: ${category}` : null,
    subcategory ? `Subcategory: ${subcategory}` : null,
    terminology ? `Type: ${terminology}` : null
  ].filter(Boolean).join('\n');
}

function shouldImport(row) {
  const sku = clean(row['Premier Part Number']);
  const productName = clean(row['Long Description']);
  const brand = clean(row['Brand']);
  const approvedLine = clean(row['Approved Line']);

  if (!sku || !productName) return false;

  if (BRAND_WHITELIST && (!brand || !BRAND_WHITELIST.has(brand))) {
    return false;
  }

  if (approvedLine && approvedLine.toLowerCase() === 'no') {
    return false;
  }

  return true;
}

function mapRow(row) {
  const sku = clean(row['Premier Part Number']);
  const productName = clean(row['Long Description']) || sku;
  const brand = clean(row['Brand']);
  const stockQty = totalStock(row);
  const weight = toNumber(row['Weight']);
  const shippingCost = roundMoney(
    (toNumber(row['Freight Cost']) || 0) + (toNumber(row['Drop Ship Fee']) || 0)
  );
  const price = pickPrice(row);
  const status = productStatus(row, stockQty);

  const fitmentText = [
    clean(row['Part Category']),
    clean(row['Part Subcategory']),
    clean(row['Part Terminology'])
  ].filter(Boolean).join(' | ') || null;

  return {
    vendor_id: APG_VENDOR_ID,
    product_name: productName,
    sku,
    brand,
    price,
    shipping_cost: shippingCost,
    stock_qty: stockQty,
    category: clean(row['Part Category']),
    condition: 'new',
    fitment_text: fitmentText,
    description: buildDescription(row),
    image_url: clean(row['ImageURL']),
    weight_lbs: weight,
    source: 'distributor',
    source_ref: sku,
    status
  };
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  }

  if (!APG_VENDOR_ID) {
    throw new Error('Missing APG_VENDOR_ID');
  }

  if (!fs.existsSync(FEED_PATH)) {
    throw new Error(`Feed file not found: ${FEED_PATH}`);
  }

  const csvText = fs.readFileSync(FEED_PATH, 'utf8');

  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
    quote: false
  });

  console.log(`Parsed ${rows.length} rows from feed`);

  const mapped = rows
    .filter(shouldImport)
    .slice(0, IMPORT_LIMIT)
    .map(mapRow);

  console.log(`Prepared ${mapped.length} rows for import`);

  if (!mapped.length) {
    console.log('No rows matched import filters');
    return;
  }

  const chunkSize = 200;

  for (let i = 0; i < mapped.length; i += chunkSize) {
    const chunk = mapped.slice(i, i + chunkSize);

    const { error } = await supabase
      .from('products')
      .upsert(chunk, { onConflict: 'vendor_id,sku' });

    if (error) {
      console.error('Upsert failed on chunk starting at row', i, error);
      throw error;
    }

    console.log(`Upserted ${Math.min(i + chunk.length, mapped.length)} / ${mapped.length}`);
  }

  console.log('✅ APG lean import complete');
}

main().catch((err) => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});