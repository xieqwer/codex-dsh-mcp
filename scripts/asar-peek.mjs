#!/usr/bin/env node
/**
 * Read-only Electron ASAR inspector (used during the recon phase).
 *
 * Usage:
 *   node scripts/asar-peek.mjs list "<regex>"     # list matching paths inside the archive
 *   node scripts/asar-peek.mjs cat "<path>"       # print one file from the archive
 *
 * Archive path: $DSH_ASAR, else the default DeepSeek Harness install location.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function defaultAsarPath() {
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar');
  }
  return path.join(os.homedir(), '.local', 'share', 'dsh', 'app.asar');
}

const asarPath = defaultAsarPath();
if (!fs.existsSync(asarPath)) {
  console.error(`asar-peek: archive not found: ${asarPath}\nSet DSH_ASAR to point at the DeepSeek Harness app.asar.`);
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const contentBase = 16 + headerSize;

const mode = process.argv[2];
const target = process.argv[3];

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset });
  }
}

const all = [];
walk(header, '', all);

if (mode === 'list') {
  const re = new RegExp(target ?? '.', 'u');
  for (const f of all) if (re.test(f.path)) console.log(`${f.size}\t${f.path}`);
} else if (mode === 'cat') {
  const found = all.find((f) => f.path === target);
  if (!found) {
    console.error(`not found: ${target}`);
    process.exit(2);
  }
  const buf = Buffer.alloc(found.size);
  fs.readSync(fd, buf, 0, found.size, contentBase + Number(found.offset));
  process.stdout.write(buf);
} else {
  console.error('usage: node scripts/asar-peek.mjs list "<regex>" | cat "<path>"');
  process.exitCode = 2;
}
fs.closeSync(fd);
