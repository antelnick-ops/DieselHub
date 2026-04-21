require('dotenv').config({ path: '.env.local' });

async function main() {
  const apiKey = process.env.APG_API_KEY;
  const authUrl = process.env.APG_AUTH_URL;

  if (!apiKey || !authUrl) {
    throw new Error('Missing APG_API_KEY or APG_AUTH_URL in .env.local');
  }

  const url = `${authUrl}?apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!data.sessionToken) {
    throw new Error('No sessionToken returned');
  }

  console.log('✅ APG auth succeeded');
  console.log('Token prefix:', `${data.sessionToken.slice(0, 20)}...`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});