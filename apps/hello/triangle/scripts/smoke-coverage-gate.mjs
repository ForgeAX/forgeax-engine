#!/usr/bin/env node
// smoke-coverage-gate.mjs - charter proposition 6 double-layer gate
// (feat-20260510-smoke-architecture-redesign D-P3 / AC-11 / III-1 +
//  feat-20260511-rhi-wgpu-impl M4 / w26 wgpu-wasm variant extension).
//
// SCOPE:
//   - apps/hello/triangle/scripts/smoke-dawn.mjs (rhi-webgpu variant; original
//     scope from feat-20260510-smoke-architecture-redesign).
//   bug-20260610: smoke-wgpu-wasm.mjs was deleted because rhi-wgpu became a
//   browser-only WebGL2 fallback (wgpu-wasm Cargo.toml drops BROWSER_WEBGPU,
//   adapter.ts removes the navigator.gpu fast path). dawn-node has no GL
//   adapter, so the wgpu-wasm variant cannot acquire a backend by design.
//   Browser coverage of rhi-wgpu lives in
//   packages/runtime/__tests__/renderer-wgpu-wasm.browser.test.ts.
//   hello-cube smoke is NOT in this gate.
//
// CHARTER_PROP_6: simulation coverage != real usability. The gate enforces
// two independent layers so a regression must defeat BOTH to slip through:
//
//   LAYER (delta) shared symbol grep [compile-time]
//     apps/hello/triangle/scripts/smoke-dawn.mjs source must contain ALL
//     of these literal tokens (each on at least 1 line):
//       - from '@forgeax/engine-ecs'  (or with double quotes)
//       - from '@forgeax/engine-runtime'
//       - HANDLE_TRIANGLE
//       - await host initialization
//       - renderer.draw({ leases: [attachment.value], ... })
//     AND must contain ZERO occurrences of inline parallel implementation
//     tokens that would re-introduce the deleted hand-rolled WGSL path:
//       - TRIANGLE_WGSL
//       - TRIANGLE_VERTICES
//       - device.createShaderModule({ code:    (raw shader module ctor inline)
//
//   LAYER (zeta) stderr structural assertion [runtime]
//     spawn `pnpm --filter @forgeax/hello-triangle smoke` and assert:
//       - exit code == 0
//       - stdout contains literal `[hello-triangle] backend=webgpu`
//       - stdout contains literal `frames observed=`
//       - stdout contains literal `pixelSamples=`
//       - stderr contains 0 occurrences of literal `Renderer.onError fired`
//         (case-insensitive — K-9 fan-out fires this prefix when listener
//         captures a RhiError; charter prop 4 explicit-failure red line).
//
// References:
//   - plan-strategy.md (feat-20260510-smoke-architecture-redesign) S-2 D-P3
//   - research.md (feat-20260510-smoke-architecture-redesign) F-G1 / F-G2
//   - requirements.md AC-11 / III-1 / D-R6
//   - AGENTS.md S-verify GPU smoke gate (delta+zeta double-layer gate)
//
// FAIL output: structured 3-line stderr per token miss, plus a closing
// summary line. AI users (charter prop 4) read the per-token report,
// rerun via the printed 'rerun:' line, and consult the 'hint:' line for
// the single-source plan-strategy / AGENTS.md anchors.
//
// Exit codes:
//   0 = both layers PASS
//   1 = any layer FAIL

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
// SCOPE_VARIANTS: each entry is one smoke variant the gate must cover.
// bug-20260610: rhi-wgpu variant removed (browser-only WebGL2 fallback by
// contract; cannot run under dawn-node — there is no GL adapter).
const SCOPE_VARIANTS = [
  {
    label: 'rhi-webgpu',
    path: resolve(REPO_ROOT, 'apps/hello/triangle/scripts/smoke-dawn.mjs'),
    invocation: ['pnpm', '--filter', '@forgeax/hello-triangle', 'smoke'],
  },
];

// delta layer: required tokens (each must appear >= 1 time).
//
// Import literals accept either static `from '@forgeax/<pkg>'` (used by
// apps/hello/triangle/src/main.ts) or dynamic `import('@forgeax/<pkg>')`
// (used by apps/hello/triangle/scripts/smoke-dawn.mjs because the dawn-node
// `globalThis.navigator.gpu` shim must be installed before engine modules
// are evaluated; static imports would resolve too early). Both forms
// satisfy the delta intent (shared package import with main.ts).
const REQUIRED_TOKENS = [
  {
    name: "@forgeax/engine-ecs import",
    patterns: [
      "from '@forgeax/engine-ecs'",
      'from "@forgeax/engine-ecs"',
      "import('@forgeax/engine-ecs')",
      'import("@forgeax/engine-ecs")',
    ],
  },
  {
    name: "@forgeax/engine-runtime import",
    patterns: [
      "from '@forgeax/engine-runtime'",
      'from "@forgeax/engine-runtime"',
      "import('@forgeax/engine-runtime')",
      'import("@forgeax/engine-runtime")',
    ],
  },
  { name: 'HANDLE_TRIANGLE', patterns: ['HANDLE_TRIANGLE'] },
  { name: 'lease-bound renderer.draw request', patterns: ['renderer.draw({', 'leases: [attachment.value]'] },
];

// delta layer: forbidden tokens (each must appear 0 times).
const FORBIDDEN_TOKENS = [
  { name: 'TRIANGLE_WGSL', pattern: 'TRIANGLE_WGSL' },
  { name: 'TRIANGLE_VERTICES', pattern: 'TRIANGLE_VERTICES' },
  // raw inline createShaderModule call site (allow only via engine internals).
  { name: 'device.createShaderModule({ code:', pattern: 'device.createShaderModule({ code:' },
];

// zeta layer: stdout / stderr literals.
const STDOUT_REQUIRED = ['[hello-triangle] backend=webgpu', 'frames observed=', 'pixelSamples='];
const STDERR_FORBIDDEN_REGEX = /Renderer\.onError fired/i;

const results = [];

function record(layer, variant, name, status, detail) {
  results.push({ layer, variant, name, status, detail });
}

let deltaFailed = false;
let zetaFailed = false;

for (const variant of SCOPE_VARIANTS) {
  // --- delta layer ---------------------------------------------------------
  if (!existsSync(variant.path)) {
    record('delta', variant.label, 'scope-file-exists', 'FAIL', `${variant.path} missing`);
    deltaFailed = true;
  } else {
    const text = readFileSync(variant.path, 'utf8');
    for (const tok of REQUIRED_TOKENS) {
      const hit = tok.patterns.some((p) => text.includes(p));
      if (hit) {
        record('delta', variant.label, tok.name, 'PASS', `present (matched one of ${JSON.stringify(tok.patterns)})`);
      } else {
        record('delta', variant.label, tok.name, 'FAIL', `${tok.name} token missing in ${variant.path}`);
        deltaFailed = true;
      }
    }
    for (const tok of FORBIDDEN_TOKENS) {
      if (text.includes(tok.pattern)) {
        record('delta', variant.label, tok.name, 'FAIL', `forbidden token '${tok.pattern}' present in ${variant.path}`);
        deltaFailed = true;
      } else {
        record('delta', variant.label, `no:${tok.name}`, 'PASS', `forbidden token '${tok.pattern}' absent`);
      }
    }
  }

  // --- zeta layer ----------------------------------------------------------
  // Run the smoke harness via pnpm filter — the literal three-command SSOT
  // invocation guarded by ac-08-grep-gate.mjs gate (e)/(f)/(m2). spawnSync to
  // capture exit code + both streams without interleaving.
  const proc = spawnSync(variant.invocation[0], variant.invocation.slice(1), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Inherit env so SMOKE_* tunables propagate. timeout in ms.
    timeout: 10 * 60 * 1000,
  });

  if (proc.error) {
    record('zeta', variant.label, 'spawn', 'FAIL', `spawn error: ${proc.error.message}`);
    zetaFailed = true;
  } else if (proc.status !== 0) {
    record(
      'zeta',
      variant.label,
      'exit-code',
      'FAIL',
      `exit code ${proc.status} (signal=${proc.signal ?? 'n/a'}); stdout tail:\n${(proc.stdout ?? '').slice(-800)}\nstderr tail:\n${(proc.stderr ?? '').slice(-800)}`,
    );
    zetaFailed = true;
  } else {
    record('zeta', variant.label, 'exit-code', 'PASS', 'smoke exited 0');
    const stdout = proc.stdout ?? '';
    const stderr = proc.stderr ?? '';
    for (const lit of STDOUT_REQUIRED) {
      if (stdout.includes(lit)) {
        record('zeta', variant.label, `stdout:${lit}`, 'PASS', `present in stdout`);
      } else {
        record('zeta', variant.label, `stdout:${lit}`, 'FAIL', `stdout missing literal '${lit}'`);
        zetaFailed = true;
      }
    }
    if (STDERR_FORBIDDEN_REGEX.test(stderr)) {
      record(
        'zeta',
        variant.label,
        'stderr:no-onError-fired',
        'FAIL',
        `stderr contains 'Renderer.onError fired' (K-9 fan-out signal); stderr tail:\n${stderr.slice(-800)}`,
      );
      zetaFailed = true;
    } else {
      record(
        'zeta',
        variant.label,
        'stderr:no-onError-fired',
        'PASS',
        "stderr contains 0 occurrences of 'Renderer.onError fired'",
      );
    }
  }
}

// --- report --------------------------------------------------------------
const failed = results.filter((r) => r.status === 'FAIL');
console.log('=== smoke-coverage-gate.mjs (charter proposition 6 delta+zeta double-layer; rhi-webgpu variant — rhi-wgpu deleted post-bug-20260610) ===');
for (const v of SCOPE_VARIANTS) {
  console.log(`SCOPE ${v.label}: ${v.path}`);
}
for (const r of results) {
  const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`  [${r.layer}/${r.variant}] ${icon} ${r.name}: ${r.detail}`);
}
console.log('');
if (!deltaFailed && !zetaFailed) {
  console.log(
    `OK both layers PASS - delta shared symbol grep + zeta stderr structural assertion (charter proposition 6 enforced; rhi-webgpu only post-bug-20260610)`,
  );
  process.exit(0);
} else {
  console.error(`FAIL ${failed.length} / ${results.length} checks failed`);
  console.error(`  rerun: pnpm --filter @forgeax/hello-triangle exec node scripts/smoke-coverage-gate.mjs`);
  console.error(
    `  hint: see plan-strategy section 2 D-P3 + AGENTS.md section verify GPU smoke gate (delta+zeta gate) + plan-strategy D-P5 wgpu-wasm variant`,
  );
  process.exit(1);
}
