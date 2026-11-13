/**
 * Makes the encrypted seed that goes into the Docker image: this machine's database (its photo links rewritten to the
 * public address) and the photos it uses, packed, encrypted with a passphrase and cut into pieces under <out>.
 *
 *   node scripts/build-seed.js --origin https://qbazz.com/api --out ../deploy/out/qbazz-image/app/seed
 *
 * The passphrase comes from QBAZZ_SEED_PASS (printed nowhere). The server needs the same value in QBAZZ_SEED_PASS to open it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportData, splitFile } from '../src/util/dataTransfer.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const dataDir = path.resolve(arg('--data', 'data'));
const out = path.resolve(arg('--out', '../deploy/out/qbazz-image/app/seed'));
const origin = arg('--origin');
const from = arg('--from', 'http://localhost:8080');
const pass = process.env.QBAZZ_SEED_PASS;
if (!origin) { console.error('--origin <public api address> is required, e.g. https://qbazz.com/api'); process.exit(1); }
if (!pass || pass.length < 12) { console.error('Set QBAZZ_SEED_PASS (at least 12 characters).'); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-seed-'));
try {
  const raw = fs.readFileSync(path.join(dataDir, 'qbazz.json'), 'utf8');
  const db = raw.split(from).join(origin); // every photo link points at the public address
  fs.writeFileSync(path.join(stage, 'qbazz.json'), db);

  fs.mkdirSync(path.join(stage, 'uploads'));
  const used = new Set([...db.matchAll(/\/media\/u\/([A-Za-z0-9]+\.(?:jpg|png|webp))/g)].map((m) => m[1]));
  let copied = 0;
  for (const name of used) {
    const file = path.join(dataDir, 'uploads', name);
    if (fs.existsSync(file)) { fs.copyFileSync(file, path.join(stage, 'uploads', name)); copied += 1; }
  }
  console.log(`database ${(db.length / 1048576).toFixed(1)} MB, ${copied} photos (of ${used.size} the database names)`);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'qbazz-seed.enc');
  const bytes = await exportData({ dataDir: stage, out: file, pass });
  const parts = splitFile(file);
  fs.rmSync(file);
  console.log(`encrypted ${(bytes / 1048576).toFixed(0)} MB in ${parts.length} pieces under ${out}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
