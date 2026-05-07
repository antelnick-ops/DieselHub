require('dotenv').config({ path: '.env.local' });

const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

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

    // Prefer .zip over .csv — Premier's FTP now publishes both, and the .zip
    // is updated on a fresher cadence than the legacy uncompressed .csv.
    const remoteFile =
      list.find((f) => /^premier_data_feed_master.*\.zip$/i.test(f.name))?.name ||
      list.find((f) => f.name === expectedFile)?.name ||
      list.find((f) => f.name.includes('premier_data_feed_master'))?.name ||
      list[0]?.name;

    if (!remoteFile) {
      throw new Error('No feed file found on FTP');
    }

    console.log(`Selected remote file: ${remoteFile}`);

    const localPath = path.join(outDir, remoteFile);
    await client.downloadTo(localPath, remoteFile);

    console.log(`✅ Downloaded to: ${localPath}`);

    // Auto-extract if it's a zip; the importer expects an uncompressed CSV
    // at tmp/premier_data_feed_master.csv (see import-apg-feed.js FEED_PATH).
    let finalCsvPath = localPath;
    if (remoteFile.toLowerCase().endsWith('.zip')) {
      console.log('Detected .zip — extracting...');
      const zip = new AdmZip(localPath);
      const entries = zip.getEntries();
      const csvEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.csv'));
      if (!csvEntry) {
        throw new Error(
          `No .csv entry inside ${remoteFile}; entries: ${entries.map((e) => e.entryName).join(', ')}`
        );
      }
      const csvName = path.basename(csvEntry.entryName);
      zip.extractEntryTo(csvEntry, outDir, /* maintainEntryPath */ false, /* overwrite */ true);
      finalCsvPath = path.join(outDir, csvName);
      console.log(`✅ Extracted ${csvName} (${csvEntry.header.size.toLocaleString()} bytes) → ${finalCsvPath}`);

      fs.unlinkSync(localPath);
      console.log(`Removed ${localPath}`);
    }

    console.log(`Final CSV path: ${finalCsvPath}`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});