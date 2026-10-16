#!/usr/bin/env node
// M7-T1 -- 3 lint gates A/B/C enforcing pipeline-spec.ts vocabulary boundaries.
//
// Gate A (createRenderPipeline\b allowlist):
//   The lone owner of `device.createRenderPipeline(...)` is the
//   pipeline-spec.ts entrypoint (`getOrBuildPipeline`). Resource-baking
//   exceptions: mipmap-generator.ts (per-format mip downsamplers) and
//   ibl/IblPipelineCache.ts (irradiance / prefilter / BRDF-LUT). Anywhere
//   else means a raw build path bypassing the 4-axis spec SSOT.
//
// Gate B (beginRenderPass\b allowlist):
//   The lone owner of `encoder.beginRenderPass(...)` is the
//   render-system-record.ts helper (`buildBeginRenderPassDescriptor`).
//   Same baking exceptions as Gate A. Anywhere else means a raw attachment
//   shape bypassing the per-passKind policy table.
//
// Gate C (materialShaderPipelineCacheKey 0 hit):
//   M2-T2 supersedes via `cacheKeyOf(spec)`; any residual reference is a
//   leak from before the 4-axis SSOT collapse. Limited to packages/runtime/
//   src/ (tests are checked separately).
//
// Plan-strategy D-6 / requirements AC-04 / AC-05 / AC-06 / AC-07.
// CLI shape mirrors scripts/check-image-pipeline-isolation.mjs:
//   --root <dir>   override project root (default: process.cwd())
//
// Self-test: scripts/__tests__/check-pipeline-spec-vocabulary.test.mjs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

// --- arg parsing ----------------------------------------------------------

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) {
      root = argv[i + 1] ?? root;
      i++;
    }
  }
  return { root };
}

const { root: ROOT } = parseArgs(process.argv.slice(2));

// --- allowlist -----------------------------------------------------------

// Paths are relative to ROOT, posix-style separators.
const GATE_A_ALLOW = new Set([
  'packages/runtime/src/pipeline-spec.ts',
  'packages/runtime/src/mipmap-generator.ts',
  'packages/runtime/src/ibl/IblPipelineCache.ts',
]);

const GATE_B_ALLOW = new Set([
  // feat-20260704 M3/w24: the record-stage monolith split into the
  // packages/runtime/src/record/ cluster; the beginRenderPass owners are the
  // three pass-recording files (plan-strategy D-2 no-root-shim).
  'packages/runtime/src/record/main-pass.ts',
  'packages/runtime/src/record/shadow-pass.ts',
  'packages/runtime/src/record/skybox-post-pass.ts',
  'packages/runtime/src/mipmap-generator.ts',
  'packages/runtime/src/ibl/IblPipelineCache.ts',
]);

const RUNTIME_SRC_REL = 'packages/runtime/src';

// --- file walker (skips node_modules / __tests__) ------------------------

function* walkFiles(dir, ext) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules') continue;
      // Tests own legitimate references to all 3 vocabulary tokens.
      if (name === '__tests__') continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (
        name.endsWith(ext) &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.unit.test.ts')
      ) {
        yield p;
      }
    }
  }
}

// --- gate scanner --------------------------------------------------------

function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * Strip line and block comments from a TS source string. Crude but
 * sufficient for grep-gate scanning: we need to ignore tokens that appear
 * in `// ...` / `/* ... *\/` because those are descriptive prose (often
 * citing the rule itself) rather than real code paths.
 *
 * Implementation: walk the string with a 4-state machine -- code / line-
 * comment / block-comment / string. String tracking is conservative
 * (handles ' " ` with escapes); regex literals are not specially handled,
 * which is acceptable because the forbidden tokens never appear inside
 * regex content in this codebase.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let stringQuote = '';
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line-comment';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block-comment';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        stringQuote = c;
        state = 'string';
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (state === 'line-comment') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      // Preserve newlines so line numbers stay aligned post-strip.
      if (c === '\n') out += '\n';
      else out += ' ';
      i++;
      continue;
    }
    if (state === 'string') {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += c2;
        i += 2;
        continue;
      }
      if (c === stringQuote) {
        state = 'code';
        stringQuote = '';
      }
      i++;
    }
  }
  return out;
}

/**
 * Scan one file for raw vocabulary hits.
 * Returns { gateA: line[], gateB: line[], gateC: line[] }.
 *
 * Comments are stripped before scanning so that descriptive prose citing
 * the rule itself ("must NOT contain createRenderPipeline") does not trip
 * the gate. Tests are excluded earlier (__tests__/ skip + .test.ts skip).
 */
function scanFile(abs) {
  const content = readFileSync(abs, 'utf8');
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const gateA = [];
  const gateB = [];
  const gateC = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line) continue;
    if (/createRenderPipeline\b/.test(line)) gateA.push({ n: i + 1, t: line.trim() });
    if (/beginRenderPass\b/.test(line)) gateB.push({ n: i + 1, t: line.trim() });
    if (/materialShaderPipelineCacheKey/.test(line)) gateC.push({ n: i + 1, t: line.trim() });
  }
  return { gateA, gateB, gateC };
}

// --- main ----------------------------------------------------------------

const runtimeSrc = join(ROOT, RUNTIME_SRC_REL);
if (!existsSync(runtimeSrc)) {
  process.stdout.write(
    `OK: ${RUNTIME_SRC_REL} not present under root '${ROOT}' (nothing to check)\n`,
  );
  process.exit(0);
}

const violations = { A: [], B: [], C: [] };

for (const abs of walkFiles(runtimeSrc, '.ts')) {
  const rel = toPosix(relative(ROOT, abs));
  const hits = scanFile(abs);
  if (hits.gateA.length > 0 && !GATE_A_ALLOW.has(rel)) {
    for (const h of hits.gateA) violations.A.push({ rel, ...h });
  }
  if (hits.gateB.length > 0 && !GATE_B_ALLOW.has(rel)) {
    for (const h of hits.gateB) violations.B.push({ rel, ...h });
  }
  if (hits.gateC.length > 0) {
    for (const h of hits.gateC) violations.C.push({ rel, ...h });
  }
}

const totalViolations = violations.A.length + violations.B.length + violations.C.length;

if (totalViolations === 0) {
  process.stdout.write(
    `OK: pipeline-spec vocabulary clean across ${RUNTIME_SRC_REL} ` +
      '(Gates A/B/C all zero hits outside allowlist)\n',
  );
  process.exit(0);
}

const lines = [];
lines.push('FAIL: pipeline-spec vocabulary leaked outside allowlist:\n');

if (violations.A.length > 0) {
  lines.push(`Gate A (createRenderPipeline allowed only in: ${[...GATE_A_ALLOW].join(', ')}):`);
  for (const v of violations.A) lines.push(`  ${v.rel}:${v.n}  ${v.t}`);
  lines.push('');
}

if (violations.B.length > 0) {
  lines.push(`Gate B (beginRenderPass allowed only in: ${[...GATE_B_ALLOW].join(', ')}):`);
  for (const v of violations.B) lines.push(`  ${v.rel}:${v.n}  ${v.t}`);
  lines.push('');
}

if (violations.C.length > 0) {
  lines.push(
    'Gate C (materialShaderPipelineCacheKey forbidden -- M2-T2 supersedes via cacheKeyOf):',
  );
  for (const v of violations.C) lines.push(`  ${v.rel}:${v.n}  ${v.t}`);
  lines.push('');
}

lines.push(
  '[hint] If adding a new pipeline-baking allowlist, update the ' +
    'GATE_A_ALLOW / GATE_B_ALLOW sets in scripts/forgeax/check-pipeline-spec-vocabulary.mjs.',
);

process.stderr.write(`${lines.join('\n')}\n`);
process.exit(1);
