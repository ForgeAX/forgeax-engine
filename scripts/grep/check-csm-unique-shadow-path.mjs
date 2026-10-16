#!/usr/bin/env node
// AC-03 / AC-10 grep gate (feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path):
// CSM is the single shadow path. The cascadeCount=1 case degenerates through
// the same WGSL kernel as cascadeCount=4 -- there is no separate single-cascade
// fallback variant. This gate locks three legacy-path symbols out of source:
//
//   1. `cascadeCount === 1` (or equivalent strict-equality fallback branch)
//      anywhere in packages/runtime/src or packages/shader/src. Catches the
//      "if (cascadeCount === 1) take the legacy path" regression. Loose
//      comparisons (`==`) are also banned.
//   2. `orthoHalfExtent` -- the legacy fixed-extent field replaced by per-
//      cascade frustum-fit (D-1). Component schema migrated; any new
//      reference is a regression.
//   3. `fragPosLightSpace` -- the single-cascade WGSL varying replaced by
//      per-fragment cascade selection (M5 w18). Survives only in the
//      .forgeax-harness/ history (not scanned).
//
// Cascades are layers of one depth array so each view clears and caches
// independently; array dimensions are therefore not a legacy-path signal.
//
// Self-exempt: this gate file (the regex literals must appear here).
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-no-array-stride-option.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages/runtime/src', 'packages/shader/src'];

const SELF_EXEMPT = new Set(['scripts/grep/check-csm-unique-shadow-path.mjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

const CODE_EXTS = new Set(['.ts', '.mts', '.tsx', '.js', '.mjs', '.wgsl']);

const PATTERNS = [
  {
    name: 'cascadeCount-eq-1',
    // strict + loose equality, with optional whitespace, on either side
    re: /cascadeCount\s*(===|==)\s*1\b|\b1\s*(===|==)\s*cascadeCount\b/,
    hint:
      'cascadeCount===1 fallback branch is banned (AC-03). cascadeCount=1 must ' +
      'walk the same WGSL kernel as cascadeCount=4; remove the conditional.',
  },
  {
    name: 'orthoHalfExtent',
    re: /\borthoHalfExtent\b/,
    hint:
      'orthoHalfExtent is the legacy fixed-extent field. Per-cascade frustum-fit (D-1) ' +
      'replaces it; remove the reference and use the camera frustum corners.',
  },
  {
    name: 'fragPosLightSpace',
    re: /\bfragPosLightSpace\b/,
    hint:
      'fragPosLightSpace is the single-cascade varying. Per-fragment cascade selection ' +
      '(M5 w18) computes the light-space position inside evalDirectional; remove the varying.',
  },
];

function walk(dir, hits) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, hits);
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = name.slice(dot);
    if (!CODE_EXTS.has(ext)) continue;
    const rel = relative(process.cwd(), p);
    if (SELF_EXEMPT.has(rel)) continue;
    const content = readFileSync(p, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const pat of PATTERNS) {
        const m = line.match(pat.re);
        if (m) {
          hits.push({
            path: rel,
            line: i + 1,
            pattern: pat.name,
            hint: pat.hint,
            content: line.trim(),
          });
        }
      }
    }
  }
}

const hits = [];
for (const root of ROOTS) walk(root, hits);

if (hits.length > 0) {
  process.stderr.write(`CSM unique-shadow-path grep gate FAIL: ${hits.length} hit(s):\n`);
  for (const h of hits) {
    process.stderr.write(`  ${h.path}:${h.line}: [${h.pattern}]  |  ${h.content}\n`);
    process.stderr.write(`      hint: ${h.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  'CSM unique-shadow-path grep gate OK: 0 hits in packages/runtime/src + packages/shader/src ' +
    '(banned: cascadeCount===1, orthoHalfExtent, fragPosLightSpace)\n',
);
