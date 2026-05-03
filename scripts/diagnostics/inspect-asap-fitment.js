const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const FITMENT_PATH = path.join(process.cwd(), 'tmp', 'asap-data', '206636-ACCEL-2026-04-28_fitment.csv');
const PRODUCTS_PATH = path.join(process.cwd(), 'tmp', 'asap-data', '206636-ACCEL-2026-04-28.csv');

const fText = fs.readFileSync(FITMENT_PATH, 'utf8');
const pText = fs.readFileSync(PRODUCTS_PATH, 'utf8');

// Re-parse fitment WITHOUT a header row
const fRows = parse(fText, {
  columns: false,
  skip_empty_lines: true,
  relax_column_count: true,
  relax_quotes: true,
  trim: true
});

// Re-parse products WITH header
const pRows = parse(pText, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  relax_quotes: true,
  trim: true
});

console.log('Fitment file is HEADERLESS.');
console.log('Total fitment data rows:', fRows.length);
console.log('Columns per row (sample of 5):');
fRows.slice(0, 5).forEach((r, i) => console.log(`  row ${i + 1} (${r.length} cols):`, r));

// Inferred column order: [year_start, year_end, sku, mfg_original_sku, make, model, sub_model]
const COL = { yearStart: 0, yearEnd: 1, sku: 2, mfgSku: 3, make: 4, model: 5, sub: 6 };

const skusInProducts = new Set(pRows.map(r => r.sku).filter(Boolean));
const skusInFitment = new Set(fRows.map(r => r[COL.sku]).filter(Boolean));

console.log(`\nDistinct SKUs in product CSV: ${skusInProducts.size}`);
console.log(`Distinct SKUs in fitment CSV: ${skusInFitment.size}`);

const perSku = new Map();
for (const r of fRows) {
  const k = r[COL.sku];
  if (!k) continue;
  perSku.set(k, (perSku.get(k) || 0) + 1);
}
const counts = [...perSku.values()].sort((a, b) => a - b);
const sum = counts.reduce((a, b) => a + b, 0);
const avg = counts.length ? sum / counts.length : 0;
const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
const max = counts.length ? counts[counts.length - 1] : 0;

console.log(`\nFitment rows per SKU — avg: ${avg.toFixed(1)} | median: ${median} | max: ${max}`);

const fitmentMissing = [...skusInProducts].filter(s => !skusInFitment.has(s));
const fitmentOnly = [...skusInFitment].filter(s => !skusInProducts.has(s));
console.log(`Products with NO fitment rows: ${fitmentMissing.length} (${((fitmentMissing.length / skusInProducts.size) * 100).toFixed(1)}%)`);
console.log(`Fitment SKUs not in product CSV: ${fitmentOnly.length}`);

// Make/model distribution
const makes = new Map();
const dieselTerms = /cummins|duramax|power\s*stroke|powerstroke|diesel|td|tdi|hdt/i;
let dieselMentioning = 0;
for (const r of fRows) {
  const m = r[COL.make];
  if (m) makes.set(m, (makes.get(m) || 0) + 1);
  if (r.some(v => v && dieselTerms.test(v))) dieselMentioning++;
}
const topMakes = [...makes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('\nTop 15 makes by fitment row count:');
topMakes.forEach(([m, c]) => console.log(`  ${m}: ${c}`));
console.log(`\nFitment rows mentioning a diesel/cummins/duramax/powerstroke term: ${dieselMentioning}`);

// Spot-check: does the embedded `fitment` column in products carry the same data?
const sampleProduct = pRows.find(r => r.fitment && r.fitment.length > 50);
if (sampleProduct) {
  const embedded = sampleProduct.fitment.split('|');
  const fromFile = fRows.filter(r => r[COL.sku] === sampleProduct.sku);
  console.log(`\nSpot check — SKU ${sampleProduct.sku}:`);
  console.log(`  embedded fitment entries: ${embedded.length}`);
  console.log(`  fitment-file rows: ${fromFile.length}`);
  console.log(`  embedded sample: ${embedded[0]}`);
  console.log(`  file row sample: ${JSON.stringify(fromFile[0])}`);
}

// Universal vs fitted breakdown
let universalCount = 0;
let withFitmentCount = 0;
for (const r of pRows) {
  if (String(r.universal).toLowerCase() === 'yes') universalCount++;
  if (r.fitment && r.fitment.length > 0) withFitmentCount++;
}
console.log(`\nProducts marked universal=Yes: ${universalCount}`);
console.log(`Products with non-empty embedded fitment column: ${withFitmentCount}`);
