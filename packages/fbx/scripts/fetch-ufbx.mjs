#!/usr/bin/env node
// fetch-ufbx.mjs — Download ufbx.h + ufbx.c from the official GitHub repo.
// Usage: node scripts/fetch-ufbx.mjs [version]
// Default version: v0.23.0 (latest stable as of 2026-07)

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(__dirname, '..', 'src', 'native');

const LOCK = JSON.parse(readFileSync(join(__dirname, 'ufbx-source.lock.json'), 'utf8'));
const VERSION = process.argv[2] || LOCK.version;
const BASE_URL = `https://raw.githubusercontent.com/ufbx/ufbx/${VERSION}`;

const FILES = ['ufbx.h', 'ufbx.c'];

function verify(name, content) {
  const expected = LOCK.files[name]?.sha256;
  const observed = createHash('sha256').update(content).digest('hex');
  if (!expected || observed !== expected) {
    throw new Error(`ufbx-source-digest-mismatch: ${name} expected ${expected ?? 'missing'} observed ${observed}`);
  }
}

async function fetchFile(name) {
  const url = `${BASE_URL}/${name}`;
  console.log(`Fetching ${url} ...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.text();
}

async function main() {
  if (!existsSync(NATIVE_DIR)) mkdirSync(NATIVE_DIR, { recursive: true });

  for (const file of FILES) {
    const dest = join(NATIVE_DIR, file);
    if (existsSync(dest)) {
      verify(file, readFileSync(dest));
      console.log(`  ${file} already exists and matches the source lock`);
      continue;
    }
    const content = await fetchFile(file);
    verify(file, content);
    writeFileSync(dest, content);
    console.log(`  → ${dest} (${(content.length / 1024).toFixed(0)} KB)`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
