#!/usr/bin/env node
// AC-12 (Promise<Result<T,E>>) — async form contract grep gate.
//
// Walks packages/rhi/src + packages/rhi-webgpu/src + packages/rhi-wgpu/src
// looking for `Promise<` occurrences. Splits hits into two buckets:
//   - whitelisted: a `// forgeax-async-whitelist: <category>` comment lives on
//     the same line or one of the four lines above;
//   - violations: bare `Promise<...>` where the inner type is NOT `Result`
//     and no whitelist comment is in range.
//
// Three permitted whitelist categories per plan-strategy D-P9:
//   wasm-bindgen | dom-native | render-loop
//
// Exit 0 + summary line when violations == 0; exit 1 otherwise.
//
// charter mapping: proposition 4 (Promise<Result> never rejects) +
// proposition 3 (machine-readable comment over prose convention).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages/rhi/src', 'packages/rhi-webgpu/src', 'packages/rhi-wgpu/src'];

const PROMISE_RE = /Promise<([^<>]|<[^<>]*>)*>/g;
const WHITELIST_RE = /\/\/\s*forgeax-async-whitelist\b/;

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, files);
    else if (p.endsWith('.ts')) files.push(p);
  }
}

// Block comment `/* ... */` stripper; preserves the line layout (replaces
// comment bodies with spaces so reported line numbers stay accurate). Single-
// line `//` comments are pruned via per-line check below.
function stripBlockComments(src) {
  let out = '';
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    if (!inBlock && src[i] === '/' && src[i + 1] === '*') {
      inBlock = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (inBlock && src[i] === '*' && src[i + 1] === '/') {
      inBlock = false;
      out += '  ';
      i += 1;
      continue;
    }
    if (inBlock) {
      out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += src[i];
  }
  return out;
}

const violations = [];
let whitelistHits = 0;
let promiseResultHits = 0;

for (const root of ROOTS) {
  const files = [];
  walk(root, files);
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripBlockComments(raw);
    const rawLines = raw.split('\n');
    const lines = src.split('\n');
    PROMISE_RE.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Drop single-line `//` comment body before regex scan.
      const codeOnly = line.replace(/\/\/.*$/, '');
      PROMISE_RE.lastIndex = 0;
      while (true) {
        const m = PROMISE_RE.exec(codeOnly);
        if (m === null) break;
        const inner = m[0].slice('Promise<'.length, -1).trim();
        if (inner.startsWith('Result<')) {
          promiseResultHits += 1;
          continue;
        }
        // check 4-line whitelist window against the original source so the
        // `// forgeax-async-whitelist: ...` comment is reachable.
        const start = Math.max(0, i - 4);
        const window = rawLines.slice(start, i + 1).join('\n');
        if (WHITELIST_RE.test(window)) {
          whitelistHits += 1;
          continue;
        }
        violations.push({ file, line: i + 1, snippet: rawLines[i].trim().slice(0, 100) });
      }
    }
  }
}

const summary = `check-async-form: Promise<Result> hits=${promiseResultHits}, whitelist hits=${whitelistHits}, violations=${violations.length}`;
if (violations.length > 0) {
  process.stderr.write(`${summary}\n`);
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  ${v.snippet}\n`);
  }
  process.exit(1);
}
process.stdout.write(`${summary}\n`);
