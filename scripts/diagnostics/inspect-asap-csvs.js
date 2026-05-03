require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DIR = path.join(process.cwd(), 'tmp', 'asap-data');
const FILES = {
  accel_products: '206636-ACCEL-2026-04-28.csv',
  accel_fitment: '206636-ACCEL-2026-04-28_fitment.csv',
  bak_products: '206636-BAK-2026-04-28.csv'
};

function load(file) {
  const fullPath = path.join(DIR, file);
  const buf = fs.readFileSync(fullPath);
  // detect BOM
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = hasBom ? buf.slice(3).toString('utf8') : buf.toString('utf8');
  // detect delimiter (csv vs tsv vs pipe)
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = { ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length, '|': (firstLine.match(/\|/g) || []).length };
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = parse(text, {
    columns: true,
    delimiter: delim,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true
  });
  return { rows, delim, hasBom, sizeBytes: buf.length, columns: rows.length ? Object.keys(rows[0]) : [] };
}

function summarize(label, file) {
  console.log('\n========================================================');
  console.log(`FILE: ${label}`);
  console.log(`Path: tmp/asap-data/${file}`);
  console.log('========================================================');
  const { rows, delim, hasBom, sizeBytes, columns } = load(file);
  console.log(`Size: ${(sizeBytes / 1024).toFixed(1)} KB | Delimiter: ${JSON.stringify(delim)} | BOM: ${hasBom} | Rows: ${rows.length}`);
  console.log(`Columns (${columns.length}):`);
  columns.forEach((c, i) => console.log(`  ${i + 1}. ${JSON.stringify(c)}`));
  console.log('\nSample row 1:');
  console.log(JSON.stringify(rows[0], null, 2));
  console.log('\nSample row 2:');
  console.log(JSON.stringify(rows[1], null, 2));

  // column emptiness scan
  const blankCols = [];
  for (const c of columns) {
    const nonBlank = rows.filter((r) => r[c] != null && String(r[c]).trim() !== '').length;
    if (nonBlank === 0) blankCols.push(c);
  }
  if (blankCols.length) console.log('\nBlank-only columns:', blankCols);

  return { rows, columns };
}

function analyzeFitment(productRows, fitmentRows, fitmentCols) {
  console.log('\n========================================================');
  console.log('FITMENT JOIN ANALYSIS (ACCEL)');
  console.log('========================================================');

  // Heuristic join key: look for SKU/part_number-ish column in both
  const productSkuCol = ['sku', 'SKU', 'PartNumber', 'Part Number', 'part_number', 'item_number', 'mfg_part_number'].find((c) => productRows[0] && c in productRows[0]);
  const fitmentSkuCol = ['sku', 'SKU', 'PartNumber', 'Part Number', 'part_number', 'item_number', 'mfg_part_number'].find((c) => fitmentRows[0] && c in fitmentRows[0]);
  console.log('Product SKU col:', productSkuCol);
  console.log('Fitment SKU col:', fitmentSkuCol);

  if (!productSkuCol || !fitmentSkuCol) {
    console.log('Could not auto-detect join columns. Inspect headers manually above.');
    return;
  }

  const skusInProducts = new Set(productRows.map((r) => r[productSkuCol]).filter(Boolean));
  const skusInFitment = new Set(fitmentRows.map((r) => r[fitmentSkuCol]).filter(Boolean));

  // distribution of fitment rows per SKU
  const perSku = new Map();
  for (const r of fitmentRows) {
    const k = r[fitmentSkuCol];
    perSku.set(k, (perSku.get(k) || 0) + 1);
  }
  const counts = [...perSku.values()].sort((a, b) => a - b);
  const sum = counts.reduce((a, b) => a + b, 0);
  const avg = counts.length ? sum / counts.length : 0;
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const max = counts.length ? counts[counts.length - 1] : 0;

  console.log(`Distinct SKUs in product CSV: ${skusInProducts.size}`);
  console.log(`Distinct SKUs in fitment CSV: ${skusInFitment.size}`);
  console.log(`Fitment rows total: ${fitmentRows.length}`);
  console.log(`Fitment rows per SKU — avg: ${avg.toFixed(1)} | median: ${median} | max: ${max}`);

  const fitmentMissing = [...skusInProducts].filter((s) => !skusInFitment.has(s));
  const fitmentOnly = [...skusInFitment].filter((s) => !skusInProducts.has(s));
  console.log(`Products with NO fitment rows: ${fitmentMissing.length} (${((fitmentMissing.length / skusInProducts.size) * 100).toFixed(1)}%)`);
  console.log(`Fitment SKUs not in product CSV: ${fitmentOnly.length}`);

  // Engine column scan
  const engineLikeCols = fitmentCols.filter((c) => /engine|liter|displacement|cc|cyl/i.test(c));
  console.log('Engine-like columns in fitment file:', engineLikeCols);

  // Sample distinct engine values
  if (engineLikeCols.length) {
    for (const col of engineLikeCols) {
      const vals = new Set(fitmentRows.map((r) => r[col]).filter(Boolean));
      console.log(`  Distinct values in "${col}": ${vals.size}`);
      console.log(`  Sample (first 10):`, [...vals].slice(0, 10));
    }
  }

  // Diesel engine pattern scan
  const dieselTerms = /cummins|duramax|power\s*stroke|powerstroke|diesel|td|tdi|hdt/i;
  const dieselRows = fitmentRows.filter((r) => Object.values(r).some((v) => v && dieselTerms.test(String(v))));
  console.log(`Fitment rows mentioning a diesel engine: ${dieselRows.length}`);
  if (dieselRows.length) {
    console.log('Sample diesel fitment row:');
    console.log(JSON.stringify(dieselRows[0], null, 2));
  }
}

function main() {
  const accelP = summarize('ACCEL — products', FILES.accel_products);
  const accelF = summarize('ACCEL — fitment', FILES.accel_fitment);
  const bak = summarize('BAK — products', FILES.bak_products);

  analyzeFitment(accelP.rows, accelF.rows, accelF.columns);

  // image/url field scan in product files
  console.log('\n========================================================');
  console.log('IMAGE FIELD SCAN');
  console.log('========================================================');
  for (const [label, productSet] of [['ACCEL', accelP], ['BAK', bak]]) {
    const imgCols = productSet.columns.filter((c) => /image|photo|picture|asset|file/i.test(c));
    console.log(`${label} image-like columns:`, imgCols);
    for (const col of imgCols) {
      const sample = productSet.rows.slice(0, 5).map((r) => r[col]).filter(Boolean);
      console.log(`  Sample "${col}":`, sample.slice(0, 3));
    }
  }

  // Quick column overlap check between ACCEL and BAK products
  console.log('\n========================================================');
  console.log('SCHEMA CONSISTENCY: ACCEL vs BAK');
  console.log('========================================================');
  const a = new Set(accelP.columns);
  const b = new Set(bak.columns);
  const onlyA = [...a].filter((c) => !b.has(c));
  const onlyB = [...b].filter((c) => !a.has(c));
  const both = [...a].filter((c) => b.has(c));
  console.log(`Shared cols: ${both.length}, ACCEL-only: ${onlyA.length}, BAK-only: ${onlyB.length}`);
  if (onlyA.length) console.log('ACCEL-only cols:', onlyA);
  if (onlyB.length) console.log('BAK-only cols:', onlyB);
}

main();
