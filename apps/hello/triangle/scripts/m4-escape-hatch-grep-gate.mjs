#!/usr/bin/env node
// m4-escape-hatch-grep-gate.mjs - feat-20260510-rhi-resource-creation M4
// (w30) closure gate.
//
// Verifies the `_internal_getRawDevice` escape hatch is fully torn down
// outside the M6-pending pending sites. Runs as the M4 closure gate after
// w28 (main.ts migration green) and w29 (rhi-webgpu shim export deletion)
// and complements the broader AC-08 grep gate (gate (g) word-boundary
// `getRawDevice` + gate (h) call-site allow-list) which lives next to it
// at `apps/hello/triangle/scripts/ac-08-grep-gate.mjs`.
//
// Exit codes:
//   0 = all gates PASS
//   1 = any gate FAIL
//
// Gates checked in this script:
//   (m4-a) `apps/hello/triangle/src` 0 hits of `_internal_getRawDevice`
//          (`/_internal_getRawDevice/` regex). Comment-only mentions of the
//          symbol name still surface (the comment block in main.ts narrates
//          the migration); the gate is satisfied when zero CODE lines hit.
//   (m4-b) `packages/rhi/src` 0 hits of `_internal_getRawDevice`. The
//          interface package has no field of that name; this gate freezes
//          that property post-M4.
//   (m4-c) `packages/rhi-webgpu/src/index.ts` does NOT contain the literal
//          `export { _internal_getRawDevice }` (the escape hatch re-export
//          line removed in w29). The function definition still lives in
//          `./device.ts` because the in-package createShaderModule factory
//          + makeCanvasContext.configure shim translation both consume it
//          internally - those uses are NOT subject to this gate (charter
//          proposition 5 consistent abstraction: the reverse lookup is
//          fully internal to packages/rhi-webgpu/src and no longer surfaces
//          across the package boundary).
//   (m4-d) `apps/hello/triangle/src/main.ts` contains the `acquireCanvasContext(`
//          call site (proves the migration target is wired in, not just the
//          old path removed). Without this positive gate the migration
//          could regress silently to "no escape hatch + no replacement".
//
// Pending sites NOT covered by this gate (M6 escape-hatch tear-down per
// plan-strategy line 309 / D-P3 M4 -> M6 topological constraint):
//   - apps/hello/cube/scripts/smoke-dawn.mjs (smoke harness, renamed-import
//     form `{ _internal_getRawDevice: captureRawDevice, rhi }`)
//   - packages/rhi-webgpu/src/__tests__/dawn-real-gpu.dawn.test.ts (dawn-
//     only pushErrorScope / popErrorScope probing fixture; sibling-internal
//     import from `../device`)
//   - packages/engine/__tests__/webgpu-backend.dawn.test.ts (comment-only
//     mention of the symbol name; no functional dependency)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripLineComment, walkSourceFiles } from './grep-gate-runner.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

const SYMBOL = '_internal_getRawDevice';

const results = [];
function record(id, status, note) {
  results.push({ id, status, note });
}

// (m4-a) apps/hello/triangle/src 0 hits of `_internal_getRawDevice` on
// non-comment lines.
{
  const root = join(REPO_ROOT, 'apps/hello/triangle/src');
  const offending = [];
  for (const fp of walkSourceFiles(root, ['.ts', '.tsx', '.js', '.mjs'])) {
    const text = readFileSync(fp, 'utf8');
    const rel = fp.slice(REPO_ROOT.length + 1);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const codePart = stripLineComment(lines[i]);
      if (codePart.includes(SYMBOL)) {
        offending.push(`${rel}:${i + 1}: ${lines[i]}`);
      }
    }
  }
  if (offending.length === 0) {
    record('m4-a', 'PASS', `apps/hello/triangle/src 0 code-line hits of ${SYMBOL}`);
  } else {
    record(
      'm4-a',
      'FAIL',
      `apps/hello/triangle/src has ${offending.length} code-line hits (M4 violation):\n${offending.join('\n')}`,
    );
  }
}

// (m4-b) packages/rhi/src 0 hits of `_internal_getRawDevice` on non-comment
// lines. The interface package never had this symbol, but the gate freezes
// the property going forward.
{
  const root = join(REPO_ROOT, 'packages/rhi/src');
  const offending = [];
  for (const fp of walkSourceFiles(root, ['.ts', '.tsx', '.js', '.mjs'])) {
    const text = readFileSync(fp, 'utf8');
    const rel = fp.slice(REPO_ROOT.length + 1);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const codePart = stripLineComment(lines[i]);
      if (codePart.includes(SYMBOL)) {
        offending.push(`${rel}:${i + 1}: ${lines[i]}`);
      }
    }
  }
  if (offending.length === 0) {
    record('m4-b', 'PASS', `packages/rhi/src 0 code-line hits of ${SYMBOL}`);
  } else {
    record(
      'm4-b',
      'FAIL',
      `packages/rhi/src has ${offending.length} code-line hits (M4 violation):\n${offending.join('\n')}`,
    );
  }
}

// (m4-c) packages/rhi-webgpu/src/index.ts does NOT contain the cross-
// package re-export literal `export { _internal_getRawDevice }`.
{
  const fp = join(REPO_ROOT, 'packages/rhi-webgpu/src/index.ts');
  const text = readFileSync(fp, 'utf8');
  const lines = text.split('\n');
  const offending = [];
  for (let i = 0; i < lines.length; i++) {
    const codePart = stripLineComment(lines[i]);
    if (/export\s*\{\s*_internal_getRawDevice/.test(codePart)) {
      offending.push(`${i + 1}: ${lines[i]}`);
    }
  }
  if (offending.length === 0) {
    record(
      'm4-c',
      'PASS',
      `packages/rhi-webgpu/src/index.ts has no cross-package re-export of ${SYMBOL}`,
    );
  } else {
    record(
      'm4-c',
      'FAIL',
      `packages/rhi-webgpu/src/index.ts still has cross-package re-export (M4 violation):\n${offending.join('\n')}`,
    );
  }
}

// (m4-d) `apps/hello/triangle/src/main.ts` positive gate: confirms the
// RHI canvas-context call (`acquireCanvasContext(`) is wired in, not silently regressed.
{
  const fp = join(REPO_ROOT, 'apps/hello/triangle/src/main.ts');
  const text = readFileSync(fp, 'utf8');
  if (/acquireCanvasContext\s*\(/.test(text)) {
    record(
      'm4-d',
      'PASS',
      `apps/hello/triangle/src/main.ts wires acquireCanvasContext( (M4 migration target reached)`,
    );
  } else {
    record(
      'm4-d',
      'FAIL',
      `apps/hello/triangle/src/main.ts missing acquireCanvasContext( (M4 migration regression)`,
    );
  }
}

// ─── report ─────────────────────────────────────────────────────────────────
console.log(
  '═══ M4 escape hatch grep gate (feat-20260510-rhi-resource-creation w30) ═══',
);
let allPass = true;
for (const r of results) {
  const sym = r.status === 'PASS' ? '✓' : '✗';
  console.log(`  ${sym} (${r.id}) ${r.status}: ${r.note}`);
  if (r.status !== 'PASS') allPass = false;
}
console.log('');
if (allPass) {
  console.log(
    '✓ all 4 M4 escape-hatch gates PASS (m4-a / m4-b / m4-c / m4-d)',
  );
  process.exit(0);
} else {
  console.error('✗ at least one M4 escape-hatch gate FAILED');
  process.exit(1);
}
