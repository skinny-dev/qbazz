/**
 * Packs this server's data (the database and the photos) into ONE encrypted file and offers it for download once, so a
 * new server can fetch it. The file is useless without the passphrase you type here.
 *
 *   node --env-file=../.env scripts/export-data.js [--data /root/qbazz-demo/data] [--port 8099] [--minutes 20]
 *
 * Stop the core first (systemctl stop qbazz-core) so the database file is not being written, and start it again after.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exportData } from '../src/util/dataTransfer.js';
import { askHidden } from './prompt.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const dataDir = arg('--data', path.dirname(process.env.QBAZZ_STORAGE_FILE || '../data/qbazz.json'));
const port = Number(arg('--port', 8099));
const minutes = Number(arg('--minutes', 20));

const pass = process.env.QBAZZ_TRANSFER_PASS || await askHidden('Passphrase to encrypt with (you will type it again on the new server): ');
if (!pass || pass.length < 8) { console.error('Use a passphrase of at least 8 characters.'); process.exit(1); }

const out = path.join(dataDir, '..', `qbazz-export-${Date.now()}.enc`);
console.log(`Packing ${dataDir} ...`);
const bytes = await exportData({ dataDir, out, pass });
console.log(`Encrypted export: ${(bytes / 1048576).toFixed(1)} MB`);

const token = crypto.randomBytes(18).toString('hex');
const server = http.createServer((req, res) => {
  if (req.url !== `/${token}`) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes });
  const stream = fs.createReadStream(out);
  stream.pipe(res);
  res.on('close', () => { if (res.writableFinished) { console.log('Downloaded. Closing.'); finish(0); } });
});
const finish = (code) => { server.close(); fs.rmSync(out, { force: true }); process.exit(code); };
server.listen(port, '0.0.0.0', () => {
  console.log(`\nOn the new server, run:\n  node core/scripts/restore-data.js http://<THIS-SERVER-IP>:${port}/${token}\n`);
  console.log(`The link works for ${minutes} minutes or one download, whichever comes first.`);
});
setTimeout(() => { console.log('Time is up. Closing.'); finish(1); }, minutes * 60 * 1000);
