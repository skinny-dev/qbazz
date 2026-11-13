/**
 * Fetches an encrypted data export made by export-data.js, decrypts it with the passphrase and stages it. It is swapped
 * in the next time the service starts (restart the service after this), so the running core cannot overwrite it.
 *
 *   node core/scripts/restore-data.js <url or file>        (run from /app in the container)
 */
import fs from 'node:fs';
import path from 'node:path';
import { download, stageRestore } from '../src/util/dataTransfer.js';
import { askHidden } from './prompt.js';

const source = process.argv[2];
if (!source) { console.error('usage: node core/scripts/restore-data.js <url or file>'); process.exit(1); }
const dataDir = process.env.QBAZZ_DATA_DIR || '/data';

const pass = process.env.QBAZZ_TRANSFER_PASS || await askHidden('Passphrase: ');
const tmp = path.join(dataDir, '.download.enc');
fs.mkdirSync(dataDir, { recursive: true });
try {
  console.log('Downloading ...');
  const bytes = await download(source, tmp);
  console.log(`Got ${(bytes / 1048576).toFixed(1)} MB. Decrypting and unpacking ...`);
  const { photos, dbBytes } = await stageRestore({ file: tmp, pass, dataDir });
  console.log(`Staged: database ${(dbBytes / 1024).toFixed(0)} KB, ${photos} photos.`);
  console.log('\nNow RESTART the service in Runflare. The data is swapped in as it starts (the old database is kept beside it).');
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { force: true });
}
