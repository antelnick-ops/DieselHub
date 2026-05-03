require('dotenv').config({ path: '.env.local' });

async function getToken() {
  const apiKey = process.env.APG_API_KEY;
  const authUrl = process.env.APG_AUTH_URL;

  if (!apiKey || !authUrl) {
    throw new Error('Missing APG_API_KEY or APG_AUTH_URL in .env.local');
  }

  const res = await fetch(`${authUrl}?apiKey=${encodeURIComponent(apiKey)}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!data.sessionToken) {
    throw new Error('No sessionToken returned');
  }

  return data.sessionToken;
}

async function apgGet(path, query = {}) {
  const token = await getToken();
  const base = process.env.APG_API_BASE_URL;

  if (!base) {
    throw new Error('Missing APG_API_BASE_URL in .env.local');
  }

  const url = new URL(`${base}/${path.replace(/^\//, '')}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function main() {
  const itemNumber = process.env.APG_TEST_ITEM_NUMBER || 'AUT17203';

  console.log(`Testing inventory for ${itemNumber}...`);
  const inventory = await apgGet('inventory', { itemNumber });
  console.log('✅ Inventory response:');
  console.log(JSON.stringify(inventory, null, 2));

  console.log(`\nTesting pricing for ${itemNumber}...`);
  const pricing = await apgGet('pricing', { itemNumber });
  console.log('✅ Pricing response:');
  console.log(JSON.stringify(pricing, null, 2));
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});