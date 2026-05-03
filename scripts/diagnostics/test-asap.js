require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://api.asapnetwork.org/webapi/brands';
const OUT_PATH = path.join(process.cwd(), 'tmp', 'asap_brands.json');

async function main() {
  const apiKey = process.env.ASAP_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ASAP_API_KEY in .env.local');
  }

  const res = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  console.log('Status:', res.status);

  const bodyText = await res.text();

  if (res.status !== 200) {
    console.log('Error response body:');
    console.log(bodyText);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    console.log('Response was not JSON. First 500 chars:');
    console.log(bodyText.slice(0, 500));
    process.exit(1);
  }

  // Normalize: spec page suggests `brands` may be an object keyed by brand_id,
  // but it could also come back as an array. Handle both.
  const brandList = Array.isArray(data.brands)
    ? data.brands
    : Object.values(data.brands || {});

  console.log('Brand count (reported):', data.count ?? '(none)');
  console.log('Brand count (parsed):', brandList.length);
  console.log('First 10 brands:');
  brandList.slice(0, 10).forEach((b) => {
    console.log('  -', b.brand_id, '|', b.name);
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
  console.log(`\nFull response saved to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
