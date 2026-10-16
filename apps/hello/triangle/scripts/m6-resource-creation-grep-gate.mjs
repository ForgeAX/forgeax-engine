#!/usr/bin/env node
// m6-resource-creation-grep-gate.mjs - feat-20260510-rhi-resource-creation
// M6 (w45) closure gate.
//
// Verifies the M6 milestone target: all internal consumers (engine /
// dawn tests / smoke harnesses) use the forgeax RHI surface idiom rather
// than the legacy raw-device escape hatches that the M3-M5 milestones
// shipped under deprecation. M6 replaces:
//   - `_internal_getRawDevice(`           cross-package call sites
//   - `getCurrentTexture().createView()`  raw GPUTexture chained call
//   - `(... as unknown as GPUTexture).createView()` raw cast + chain
//
// Pairs with apps/hello/triangle/scripts/m4-escape-hatch-grep-gate.mjs
// (M4 closure gate) and apps/hello/triangle/scripts/ac-08-grep-gate.mjs
// (the always-on AC-08 + RHI-surface gate suite). M6 is the milestone
// where every internal call site is migrated; pending allow-list entries
// from M4 (the dawn tests, the hello-cube smoke harness) collapse to
// zero.
//
// Exit codes:
//   0 = all gates PASS (M6 collapse complete)
//   1 = any gate FAIL  (regression detected; AI user must re-run the M6
//                       migration on the offending site)
//
// Gates checked in this script:
//   (m6-a) `_internal_getRawDevice(` 0 call-site hits across packages/ +
//          apps/ + scripts/. The function definition + same-module shim
//          uses inside packages/rhi-webgpu/src remain (createShaderModule
//          / makeCanvasContext.configure consume it internally; charter
//          proposition 5 says the reverse lookup is fully internal to
//          packages/rhi-webgpu/src and never crosses the package
//          boundary), but the M4 allow-list of cross-module call sites
//          collapses to zero in M6.
//   (m6-b) `getCurrentTexture().createView()` 0 hits across packages/ +
//          apps/ + scripts/. The forgeax form is the two-step
//          `device.createTextureView(canvasContext.getCurrentTexture()
//          .unwrap(), {})` (K-4 view-narrow + spec idiom).
//   (m6-c) `as unknown as GPUTexture).createView()` 0 hits across
//          packages/ + apps/ + scripts/. The forgeax form is
//          `device.createTextureView(tex, {})`.
//   (m6-e) `rhi.requestDevice(` 0 call-site hits across packages/ +
//          apps/ + scripts/. The legacy single-step factory on the rhi
//          singleton was retired in M6 fix-up [w51] (AGENTS.md break-
//          point list 2026-05-10 #2 / plan-strategy §6 M3 judgement).
//          AI users go through the spec-aligned two-step path
//          `(await rhi.requestAdapter()).value.requestDevice()`. The
//          standalone `requestDevice(...)` (no `rhi.` prefix) inside
//          packages/rhi-webgpu/src is the internal unit-test seam and is
//          NOT counted by this gate (the regex requires a leading `rhi.`).
//
// Notes:
//   - The same-module call sites inside packages/rhi-webgpu/src/device.ts
//     (function definition) and packages/rhi-webgpu/src/index.ts
//     (createShaderModule helper) ARE allowed; gate (m6-a) only counts
//     call sites OUTSIDE that physical directory.
//   - Comment-only mentions of these symbols in source narrative are
//     stripped via stripLineComment so M6 documentation does not trip
//     the gate.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripLineComment, walkSourceFiles } from './grep-gate-runner.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

// Same-module call-site exemption: packages/rhi-webgpu/src is the
// implementation that owns the reverse-lookup primitive (charter
// proposition 5: the escape hatch lives inside the shim and never
// surfaces across the package boundary). Files under this exact prefix
// are not counted by gate (m6-a).
const RHI_WEBGPU_SRC_PREFIX = 'packages/rhi-webgpu/src';

// Files whose entire purpose is to define / verify the gate patterns
// themselves. They contain the literal target strings (gate definitions
// and gate test fixtures) but are not "consumers" in the M6 migration
// sense; excluding them keeps the gate self-consistent.
const GATE_DEFINITION_FILES = new Set([
  'apps/hello/triangle/scripts/m6-resource-creation-grep-gate.mjs',
  'apps/hello/triangle/scripts/m4-escape-hatch-grep-gate.mjs',
  'apps/hello/triangle/scripts/ac-08-grep-gate.mjs',
]);

// apps/dual-impl-spike formerly drove the raw spec WebGPU API as its
// dual-implementation perf-comparison baseline; the spike app was archived
// in feat-20260511-naga-rhi-wgpu-merge M5 (the forgeax/wgpu-wasm
// productionised merge cashed it out — plan-strategy D-P5). The prefix is
// kept here as a defensive carve-out — if a follow-up spike resurfaces
// under the same path it stays exempt from the M6 gate without requiring
// this gate to change. Charter proposition 5 still applies: any future
// spike that compares against the unwrapped baseline is not a "consumer"
// of the forgeax abstraction.
const SPIKE_PREFIX = 'apps/dual-impl-spike';

function isExempt(rel) {
  if (GATE_DEFINITION_FILES.has(rel)) return true;
  if (rel.startsWith(`${SPIKE_PREFIX}/`)) return true;
  return false;
}

const results = [];
function record(id, status, note) {
  results.push({ id, status, note });
}

const ROOTS = [
  join(REPO_ROOT, 'packages'),
  join(REPO_ROOT, 'apps'),
  join(REPO_ROOT, 'scripts'),
];

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// ─── (m6-a) `_internal_getRawDevice(` 0 cross-package call-site hits ───────
{
  const offending = [];
  for (const root of ROOTS) {
    for (const fp of walkSourceFiles(root, EXTS)) {
      const rel = fp.slice(REPO_ROOT.length + 1);
      // Same-module exemption: the function lives inside
      // packages/rhi-webgpu/src and the shim consumes it there directly.
      if (rel.startsWith(`${RHI_WEBGPU_SRC_PREFIX}/`)) continue;
      if (isExempt(rel)) continue;
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const codePart = stripLineComment(lines[i]);
        if (/_internal_getRawDevice\s*\(/.test(codePart)) {
          offending.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'm6-a',
      'PASS',
      '_internal_getRawDevice( call sites outside packages/rhi-webgpu/src = 0 (M6 escape-hatch tear-down complete)',
    );
  } else {
    record(
      'm6-a',
      'FAIL',
      `_internal_getRawDevice( call sites still leak outside packages/rhi-webgpu/src (${offending.length}):\n${offending.join('\n')}`,
    );
  }
}

// ─── (m6-b) `getCurrentTexture().createView()` 0 hits ──────────────────────
{
  const offending = [];
  for (const root of ROOTS) {
    for (const fp of walkSourceFiles(root, EXTS)) {
      const rel = fp.slice(REPO_ROOT.length + 1);
      if (isExempt(rel)) continue;
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const codePart = stripLineComment(lines[i]);
        if (/getCurrentTexture\(\)\.createView\(\)/.test(codePart)) {
          offending.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'm6-b',
      'PASS',
      'getCurrentTexture().createView() chained-raw-call hits = 0 (M6 view-narrow K-4 spec idiom adopted)',
    );
  } else {
    record(
      'm6-b',
      'FAIL',
      `getCurrentTexture().createView() chained-raw-call hits (${offending.length}):\n${offending.join('\n')}`,
    );
  }
}

// ─── (m6-c) `(... as unknown as GPUTexture).createView()` 0 hits ──────────
{
  const offending = [];
  const REGEX = /as\s+unknown\s+as\s+GPUTexture\)\.createView\(\)/;
  for (const root of ROOTS) {
    for (const fp of walkSourceFiles(root, EXTS)) {
      const rel = fp.slice(REPO_ROOT.length + 1);
      if (isExempt(rel)) continue;
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const codePart = stripLineComment(lines[i]);
        if (REGEX.test(codePart)) {
          offending.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'm6-c',
      'PASS',
      '(... as unknown as GPUTexture).createView() raw-cast call hits = 0 (M6 view-narrow K-4 spec idiom adopted)',
    );
  } else {
    record(
      'm6-c',
      'FAIL',
      `(... as unknown as GPUTexture).createView() raw-cast call hits (${offending.length}):\n${offending.join('\n')}`,
    );
  }
}

// ─── (m6-e) `rhi.requestDevice(` 0 cross-package call-site hits ────────────
//
// The gate fires only on real call sites (not narrative documentation):
//   - line comments (`//`) are stripped via stripLineComment
//   - JSDoc / block-comment continuation lines (whose trimmed start is `*`
//     or begins with `* `) are skipped entirely
//   - lines that contain the literal substring inside a single- or back-
//     tick string literal narrative (hint messages, AGENTS.md-style prose)
//     are tolerated when the line is part of a comment / non-call-site
//     context. We approximate this by also skipping lines that contain
//     the pattern only inside a string-literal-looking token (the
//     `' ... rhi.requestDevice() ...'` shape) without an actual call-site
//     surrounding (no `await` / `=` / `(` outside the string).
//
// Real cross-package call sites use the form `rhi.requestDevice(...)` as
// an expression (typically `await rhi.requestDevice(...)` or assignment).
// The narrative occurrences in device.ts:1584 + JSDoc lines are
// documentation-only and do not constitute real call sites.
function isJsDocOrBlockCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('/*');
}
function isInsideStringNarrative(line) {
  // Heuristic: the literal `rhi.requestDevice(` appears between a pair of
  // single-quote / double-quote / backtick string delimiters on the same
  // line (i.e. inside a string-literal narrative such as a hint message),
  // and the line does NOT have an unquoted call-shape outside the string.
  // We strip everything between matching single/double/backtick quotes
  // and re-check the literal in the residue.
  const stripped = line
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/`(?:\\.|[^\\`])*`/g, '``');
  return !/\brhi\.requestDevice\s*\(/.test(stripped);
}
{
  const offending = [];
  for (const root of ROOTS) {
    for (const fp of walkSourceFiles(root, EXTS)) {
      const rel = fp.slice(REPO_ROOT.length + 1);
      if (isExempt(rel)) continue;
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isJsDocOrBlockCommentLine(raw)) continue;
        const codePart = stripLineComment(raw);
        if (!/\brhi\.requestDevice\s*\(/.test(codePart)) continue;
        if (isInsideStringNarrative(codePart)) continue;
        offending.push(`${rel}:${i + 1}: ${raw}`);
      }
    }
  }
  if (offending.length === 0) {
    record(
      'm6-e',
      'PASS',
      'rhi.requestDevice( call sites = 0 (M6 fix-up [w51] retires the legacy single-step factory; AGENTS.md break-point list 2026-05-10 #2)',
    );
  } else {
    record(
      'm6-e',
      'FAIL',
      `rhi.requestDevice( call sites still leak (${offending.length}):\n${offending.join('\n')}`,
    );
  }
}

// ─── report ────────────────────────────────────────────────────────────────
console.log(
  '═══ M6 resource creation grep gate (feat-20260510-rhi-resource-creation w45 + w51) ═══',
);
let allPass = true;
for (const r of results) {
  const sym = r.status === 'PASS' ? '✓' : '✗';
  console.log(`  ${sym} (${r.id}) ${r.status}: ${r.note}`);
  if (r.status !== 'PASS') allPass = false;
}
console.log('');
if (allPass) {
  console.log('✓ all 4 M6 resource-creation grep gates PASS (m6-a / m6-b / m6-c / m6-e)');
  process.exit(0);
} else {
  console.error('✗ at least one M6 resource-creation grep gate FAILED');
  process.exit(1);
}
