#!/usr/bin/env node
// AC-13 browser-safe entries gate.
//
// Grep-based regression guard for the browser-safe sub-export invariant
// established by feat-20260524-browser-safe-subexports:
//
//   1. packages/types/dist/index.mjs  must NOT contain `from 'ws'` or
//      `require('ws')` — the ws dependency lives only behind the
//      `./inspector-client` sub-export (node condition).
//
//   2. packages/types/dist/index.d.ts  must NOT expose `defaultConnect`
//      or `InspectorClient` — the sub-export split deleted the main-entry
//      `export * from './inspector-client'`.
//
//   3. packages/image/dist/index.mjs   must NOT contain `from 'jpeg-js'`,
//      `from 'upng-js'`, `require('jpeg-js')`, or `require('upng-js')` —
//      those CJS decoders live only behind the `./parse-image` (and
//      transitively `./decode-image-from-file`) sub-exports.
//
//   4. packages/pack/dist/index.mjs must not contain the Node-only native
//      cooker registry; that registry is available only from ./native-cooker.
//
//   5. packages/types/package.json and packages/image/package.json
//      `exports['./inspector-client']` / `exports['./parse-image']` /
//      `exports['./decode-image-from-file']` each contain a `node` block
//      and `"default": null`.
//
// Production CI invocation: `node scripts/check-browser-safe-entries.mjs`
// (defaults `--root` to process.cwd()). The `--root <dir>` flag is for
// self-test fixtures; see scripts/__tests__/check-browser-safe-entries.test.mjs.
//
// Exit 0 on pass (stdout one-line OK). Exit 1 on any failure (stderr
// lists concrete file + pattern + location). Zero npm deps; stdlib only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      out.root = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const { root } = parseArgs(process.argv.slice(2));

const failures = [];

// ---- Check 1: types dist/index.mjs no ws ----
{
  const p = join(root, 'packages/types/dist/index.mjs');
  if (!existsSync(p)) {
    failures.push(`missing file: ${p}`);
  } else {
    const content = readFileSync(p, 'utf8');
    const patterns = [
      { re: /from ['"]ws['"]/, label: `from 'ws'` },
      { re: /require\(['"]ws['"]\)/, label: `require('ws')` },
    ];
    for (const { re, label } of patterns) {
      const m = content.match(re);
      if (m) {
        const line = lineNumberOf(content, m.index);
        failures.push(`${p}:${line} matched banned pattern "ws" via ${label} (hit: "${m[0]}")`);
      }
    }
  }
}

// ---- Check 2: types dist/index.d.ts no defaultConnect / InspectorClient ----
{
  const p = join(root, 'packages/types/dist/index.d.ts');
  if (!existsSync(p)) {
    failures.push(`missing file: ${p}`);
  } else {
    const content = readFileSync(p, 'utf8');
    const patterns = [
      { re: /\bdefaultConnect\b/, label: 'defaultConnect' },
      { re: /\bInspectorClient\b/, label: 'InspectorClient' },
    ];
    for (const { re, label } of patterns) {
      const m = content.match(re);
      if (m) {
        const line = lineNumberOf(content, m.index);
        failures.push(`${p}:${line} matched banned symbol "${label}" (hit: "${m[0]}")`);
      }
    }
  }
}

// ---- Check 3: image dist/index.mjs no jpeg-js / upng-js ----
{
  const p = join(root, 'packages/image/dist/index.mjs');
  if (!existsSync(p)) {
    failures.push(`missing file: ${p}`);
  } else {
    const content = readFileSync(p, 'utf8');
    const patterns = [
      { re: /from ['"]jpeg-js['"]/, label: `from 'jpeg-js'` },
      { re: /from ['"]upng-js['"]/, label: `from 'upng-js'` },
      { re: /require\(['"]jpeg-js['"]\)/, label: `require('jpeg-js')` },
      { re: /require\(['"]upng-js['"]\)/, label: `require('upng-js')` },
    ];
    for (const { re, label } of patterns) {
      const m = content.match(re);
      if (m) {
        const line = lineNumberOf(content, m.index);
        failures.push(
          `${p}:${line} matched banned pattern "${label}" via ${label} (hit: "${m[0]}")`,
        );
      }
    }
  }
}

// ---- Check 4: pack root stays browser-safe ----
{
  const p = join(root, 'packages/pack/dist/index.mjs');
  if (!existsSync(p)) {
    failures.push(`missing file: ${p}`);
  } else {
    const content = readFileSync(p, 'utf8');
    const patterns = [
      { re: /node:crypto/, label: 'node:crypto' },
      { re: /native-cooker-registry/, label: 'native-cooker-registry' },
    ];
    for (const { re, label } of patterns) {
      const m = content.match(re);
      if (m) {
        const line = lineNumberOf(content, m.index);
        failures.push(`${p}:${line} matched browser-banned pattern "${label}"`);
      }
    }
  }
}

// ---- Check 5: package.json exports shape ----
const exportPaths = [
  { pkg: 'types', subpath: './inspector-client' },
  { pkg: 'image', subpath: './parse-image' },
  { pkg: 'image', subpath: './decode-image-from-file' },
  { pkg: 'pack', subpath: './native-cooker' },
];

for (const { pkg, subpath } of exportPaths) {
  const p = join(root, 'packages', pkg, 'package.json');
  if (!existsSync(p)) {
    failures.push(`missing file: ${p}`);
    continue;
  }
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    failures.push(`${p}: invalid JSON`);
    continue;
  }
  const exportEntry = pkgJson.exports?.[subpath];
  if (exportEntry === undefined) {
    failures.push(`${p}: exports["${subpath}"] missing`);
    continue;
  }
  if (exportEntry === null) {
    failures.push(
      `${p}: exports["${subpath}"] is null (blocked — should have node block + default: null structure)`,
    );
    continue;
  }
  if (typeof exportEntry !== 'object' || Array.isArray(exportEntry)) {
    failures.push(
      `${p}: exports["${subpath}"] is not a condition object (got ${typeof exportEntry})`,
    );
    continue;
  }
  if (!('node' in exportEntry)) {
    failures.push(`${p}: exports["${subpath}"] missing "node" condition`);
    continue;
  }
  if (exportEntry.default !== null) {
    failures.push(
      `${p}: exports["${subpath}"].default is ${JSON.stringify(exportEntry.default)}, expected null`,
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`${f}\n`);
  process.stderr.write(`\nAC-13 browser-safe entries gate: ${failures.length} failure(s)\n`);
  process.exit(1);
}

process.stdout.write('AC-13 browser-safe entries gate: PASS\n');

// helpers

function lineNumberOf(s, index) {
  let line = 1;
  for (let i = 0; i < index && i < s.length; i += 1) {
    if (s[i] === '\n') line += 1;
  }
  return line;
}
