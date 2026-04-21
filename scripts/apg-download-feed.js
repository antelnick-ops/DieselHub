require('dotenv').config({ path: '.env.local' });

const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  const host = process.env.APG_FTP_HOST;
  const user = process.env.APG_FTP_USER;
  const password = process.env.APG_FTP_PASSWORD;
  const port = Number(process.env.APG_FTP_PORT || 21);
  const expectedFile = process.env.APG_FEED_FILE || 'premier_data_feed_master.csv';

  if (!host || !user || !password) {
    throw new Error('Missing APG_FTP_HOST, APG_FTP_USER, or APG_FTP_PASSWORD in .env.local');
  }

  const outDir = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await client.access({
      host,
      user,
      password,
      port,
      secure: false
    });

    console.log('✅ Connected to APG FTP');

    const list = await client.list();
    console.log('Remote files:');
    for (const file of list) {
      console.log(`- ${file.name}`);
    }

    const remoteFile =
      list.find((f) => f.name === expectedFile)?.name ||
      list.find((f) => f.name.includes('premier_data_feed_master'))?.name ||
      list[0]?.name;

    if (!remoteFile) {
      throw new Error('No feed file found on FTP');
    }

    const localPath = path.join(outDir, remoteFile);
    await client.downloadTo(localPath, remoteFile);

    console.log(`✅ Downloaded feed to: ${localPath}`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});