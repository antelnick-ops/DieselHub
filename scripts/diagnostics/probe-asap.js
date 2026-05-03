require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');

const BASE = 'https://api.asapnetwork.org/webapi';
const OUT_PATH = path.join(process.cwd(), 'tmp', 'asap_approved_brands.json');
const PRODUCT_TYPE = 'Truck/SUV';
const TARGET_BRAND_HINTS = ['icon vehicle dynamics', 'holley', 'skyjacker'];

async function call(url, label) {
  console.log(`\n--- ${label} ---`);
  console.log('GET', url);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.ASAP_API_KEY}`,
      Accept: 'application/json'
    }
  });
  console.log('Status:', res.status);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.log('(non-JSON body, first 500 chars)');
    console.log(text.slice(0, 500));
    return null;
  }
  return body;
}

function listBrands(brandsField) {
  if (!brandsField) return [];
  if (Array.isArray(brandsField)) return brandsField;
  return Object.values(brandsField);
}

function pickTargetBrand(brands) {
  for (const hint of TARGET_BRAND_HINTS) {
    const match = brands.find((b) => (b.name || '').toLowerCase().includes(hint));
    if (match) return match;
  }
  return brands[0] || null;
}

async function main() {
  if (!process.env.ASAP_API_KEY) throw new Error('Missing ASAP_API_KEY in .env.local');

  // 1. /brands
  const brandsResp = await call(`${BASE}/brands`, '/brands');
  if (!brandsResp) return;
  const brands = listBrands(brandsResp.brands);
  console.log('Reported count:', brandsResp.count ?? '(none)');
  console.log('Parsed count:', brands.length);
  console.log('Approved brands:');
  brands.forEach((b) => console.log(`  - ${b.brand_id} | ${b.name}`));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(brandsResp, null, 2));
  console.log(`Saved to ${path.relative(process.cwd(), OUT_PATH)}`);

  if (brands.length === 0) {
    console.log('\nNo approved brands — stopping probe here.');
    return;
  }

  // 2. /products/{brand_id}
  const target = pickTargetBrand(brands);
  console.log(`\nTarget brand: ${target.name} (brand_id=${target.brand_id})`);

  const productsUrl = `${BASE}/products/${encodeURIComponent(target.brand_id)}?type=${encodeURIComponent(PRODUCT_TYPE)}`;
  const productsResp = await call(productsUrl, `/products/${target.brand_id}?type=${PRODUCT_TYPE}`);
  if (!productsResp) return;

  // Defensive: probe shape
  const productsField =
    productsResp.products ??
    productsResp.data ??
    productsResp.skus ??
    productsResp;
  const productList = Array.isArray(productsField)
    ? productsField
    : Object.values(productsField || {});

  console.log('Reported count:', productsResp.count ?? '(none)');
  console.log('Parsed product count:', productList.length);
  console.log('First 5 products:');
  productList.slice(0, 5).forEach((p, i) => {
    console.log(`  [${i + 1}]`, JSON.stringify(p, null, 2).split('\n').join('\n  '));
  });

  if (productList.length === 0) {
    console.log('\nNo products — stopping probe here.');
    return;
  }

  // 3. /product/{sku}
  const first = productList[0] || {};
  const sku =
    first.sku ||
    first.SKU ||
    first.part_number ||
    first.partNumber ||
    first.id ||
    Object.values(first)[0];
  console.log(`\nDetail SKU: ${sku}`);

  const detailResp = await call(
    `${BASE}/product/${encodeURIComponent(sku)}`,
    `/product/${sku}`
  );
  if (!detailResp) return;

  console.log('\nFull /product detail response:');
  console.log(JSON.stringify(detailResp, null, 2));

  // 4. Summary
  console.log('\n=== SUMMARY ===');
  console.log('Brands approved:', brands.length);
  console.log(`Test brand: ${target.name} (brand_id=${target.brand_id})`);
  console.log('SKUs in test brand (Truck/SUV):', productList.length);
  console.log('Detail response top-level keys:', Object.keys(detailResp));
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
