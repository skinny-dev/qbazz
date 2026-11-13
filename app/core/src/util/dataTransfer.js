import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Moving a shop's whole data (the database file and the uploaded photos) from one server to another, safely.
 *
 *   old server:  pack + encrypt with a passphrase  ->  one file, harmless to anyone who does not know the passphrase
 *   new server:  download it, decrypt it, unpack it into <data>/incoming, and on the next start swap it in
 *
 * The swap happens at start, before the core runs: a core that is running holds the database in memory and would write
 * its old state over the restored file. Photos are copied in, never deleted; the old database file is kept beside it.
 */

const MAGIC = Buffer.from('QBZ1');
const HEADER = MAGIC.length + 16 + 12; // magic + salt + iv
const TAG = 16;
const key = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${stderr.slice(0, 300)}`))));
  });
}

/** Packs `dataDir` (without old database backups) and writes it encrypted to `out`. Returns the size in bytes. */
export async function exportData({ dataDir, out, pass }) {
  if (!pass) throw new Error('a passphrase is required');
  if (!fs.existsSync(path.join(dataDir, 'qbazz.json'))) throw new Error(`no qbazz.json in ${dataDir}`);
  const tar = spawn('tar', ['--force-local', '-czf', '-', '--exclude=*.bak-*', '--exclude=*.before-restore*', '--exclude=incoming', '-C', dataDir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', (d) => { stderr += d; });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const file = fs.createWriteStream(out, { mode: 0o600 });
  file.write(Buffer.concat([MAGIC, salt, iv]));
  const done = new Promise((resolve, reject) => {
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${stderr.slice(0, 300)}`));
    });
    tar.on('error', reject);
  });
  await pipeline(tar.stdout, cipher, file, { end: false });
  await done;
  await new Promise((resolve, reject) => file.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
  return fs.statSync(out).size;
}

/** Decrypts `file` into a .tar.gz at `outTar`. A wrong passphrase or a damaged file throws and leaves nothing behind. */
export async function decryptTo({ file, pass, outTar }) {
  const size = fs.statSync(file).size;
  if (size < HEADER + TAG) throw new Error('that file is too small to be a data export');
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  fs.readSync(fd, head, 0, HEADER, 0);
  fs.readSync(fd, tag, 0, TAG, size - TAG);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('that file is not a Qbazz data export');
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = head.subarray(MAGIC.length + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(pass, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(file, { start: HEADER, end: size - TAG - 1 }), decipher, fs.createWriteStream(outTar, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(outTar, { force: true });
    throw new Error('wrong passphrase, or the file was damaged on the way');
  }
}

/** Downloads `url` to `dest` (a local path is copied). */
export async function download(url, dest) {
  if (!/^https?:\/\//i.test(url)) { fs.copyFileSync(url, dest); return fs.statSync(dest).size; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the download failed (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest, { mode: 0o600 }));
  return fs.statSync(dest).size;
}

/** Unpacks an export into `<dataDir>/incoming`, ready to be swapped in at the next start. */
export async function stageRestore({ file, pass, dataDir }) {
  const incoming = path.join(dataDir, 'incoming');
  const tmp = path.join(dataDir, '.restore.tar.gz');
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.mkdirSync(incoming, { recursive: true });
  try {
    await decryptTo({ file, pass, outTar: tmp });
    await run('tar', ['--force-local', '-xzf', tmp, '-C', incoming]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!fs.existsSync(path.join(incoming, 'qbazz.json'))) { fs.rmSync(incoming, { recursive: true, force: true }); throw new Error('the export holds no qbazz.json'); }
  const photos = fs.existsSync(path.join(incoming, 'uploads')) ? fs.readdirSync(path.join(incoming, 'uploads')).length : 0;
  return { photos, dbBytes: fs.statSync(path.join(incoming, 'qbazz.json')).size };
}

/** At start, before the core: swaps a staged restore in. Returns what it did, or null when nothing is waiting. */
export function applyPendingRestore(dataDir, { now = () => Date.now() } = {}) {
  const incoming = path.join(dataDir, 'incoming');
  const db = path.join(incoming, 'qbazz.json');
  if (!fs.existsSync(db)) return null;
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const target = path.join(dataDir, 'qbazz.json');
  let backedUp = null;
  if (fs.existsSync(target)) { backedUp = `qbazz.json.before-restore-${stamp}`; fs.renameSync(target, path.join(dataDir, backedUp)); }
  fs.renameSync(db, target);
  let photos = 0;
  const from = path.join(incoming, 'uploads');
  if (fs.existsSync(from)) {
    const to = path.join(dataDir, 'uploads');
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) { fs.renameSync(path.join(from, name), path.join(to, name)); photos += 1; }
  }
  fs.rmSync(incoming, { recursive: true, force: true });
  return { backedUp, photos };
}

/** The parts of an export that was cut into pieces (name.part00, name.part01, ...), joined into one file at `out`. */
export function joinParts(dir, prefix, out) {
  const parts = fs.readdirSync(dir).filter((n) => n.startsWith(`${prefix}.part`)).sort();
  if (!parts.length) return 0;
  const fd = fs.openSync(out, 'w', 0o600);
  try {
    for (const name of parts) {
      const data = fs.readFileSync(path.join(dir, name));
      fs.writeSync(fd, data);
    }
  } finally { fs.closeSync(fd); }
  return parts.length;
}

/** Cuts a file into pieces of at most `size` bytes (a code host refuses single files over 100 MB). */
export function splitFile(file, size = 80 * 1024 * 1024) {
  const total = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const names = [];
  try {
    for (let i = 0, at = 0; at < total; i += 1, at += size) {
      const len = Math.min(size, total - at);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, at);
      const name = `${file}.part${String(i).padStart(2, '0')}`;
      fs.writeFileSync(name, buf);
      names.push(name);
    }
  } finally { fs.closeSync(fd); }
  return names;
}

/**
 * First start of a fresh server: when an encrypted seed (the pieces baked into the image) and its passphrase are present
 * and it was never applied, stage it so the swap that follows brings it in. Marks `<dataDir>/.seeded` so it happens once.
 */
export async function seedOnce({ dataDir, seedDir, prefix = 'qbazz-seed.enc', pass }) {
  const marker = path.join(dataDir, '.seeded');
  if (fs.existsSync(marker) || !pass || !fs.existsSync(seedDir)) return null;
  const joined = path.join(dataDir, '.seed.enc');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    if (!joinParts(seedDir, prefix, joined)) return null;
    const staged = await stageRestore({ file: joined, pass, dataDir });
    fs.writeFileSync(marker, new Date().toISOString());
    return staged;
  } finally { fs.rmSync(joined, { force: true }); }
}
