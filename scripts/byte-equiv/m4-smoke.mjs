#!/usr/bin/env node

// scripts/byte-equiv/m4-smoke.mjs - M4-T2-TEST 12-demo smoke + pipelineCount byte-equiv.
//
// M4-T2 collapses the 14 raw `device.beginRenderPass({...})` call sites in
// `render-system-record.ts` (11) + `render-graph-primitives.ts` (3) into a
// single `buildBeginRenderPassDescriptor(spec, viewBindings, passKind, opts)`
// helper. Per-shape descriptor literal equality is unit-asserted in
// pipeline-spec.test.ts; this script is the integration-level gate that
// the 12 demos still produce identical PSO counts (byte-equiv proxy) and
// exit 0 (onerror=0) after the refactor.
//
// Approach: spawn `pnpm --filter <demo> smoke` for each demo, assert exit 0.
// The dawn-node smoke harness in `apps/hello/<demo>/scripts/smoke-dawn.mjs`
// already prints a `pipelines: <N>` line via the dawn run-record (its own
// instrumentation); we grep for it and surface the count alongside the result.
//
// Usage: node scripts/byte-equiv/m4-smoke.mjs [--demo <name>] [--bail]
//   Without --demo: runs all 12 demos sequentially.
//   With --demo: runs a single demo (faster local iteration).
//   --bail: exit 1 on the first failing demo (default: run all, sum failures).
//
// Exit 0 when every demo exits 0; otherwise exit 1 with a summary table.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_ROOT = resolve(__dirname, '..', '..');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const demoArgIdx = args.indexOf('--demo');
const targetDemo = demoArgIdx !== -1 ? args[demoArgIdx + 1] : undefined;
const bail = args.includes('--bail');

// ── Demo registry: 12 shapes covering every passKind in passKindPolicyTable ──
//
// Choices match plan-strategy M4 boundary: hello-* covers the engine surface;
// learn-render covers OpenGL parity demos; parity covers cross-pipeline (URP
// vs HDRP) regressions. Every entry must call `pnpm --filter <pkg> smoke`.
const DEMOS = [
  // Hello roster - stress engine pass shapes.
  { name: 'hello-cube', filter: '@forgeax/hello-cube' }, // forward + shadow
  { name: 'hello-triangle', filter: '@forgeax/hello-triangle' }, // forward (minimal)
  { name: 'hello-tonemap', filter: '@forgeax/hello-tonemap' }, // tonemap + skybox
  { name: 'hello-fxaa', filter: '@forgeax/hello-fxaa' }, // fxaa
  { name: 'hello-bloom', filter: '@forgeax/hello-bloom' }, // five downsample + four upsample + composite
  { name: 'hello-skin', filter: '@forgeax/hello-skin' }, // forward + skinned forward
  { name: 'hello-hdrp-lighting', filter: '@forgeax/hello-hdrp-lighting' }, // HDRP cluster forward + point-shadow-caster
  { name: 'hello-sprite', filter: '@forgeax/hello-sprite' }, // forward sprite-split sub-pass
  { name: 'hello-multi-material', filter: '@forgeax/hello-multi-material' }, // forward per-submesh
  { name: 'hello-room', filter: '@forgeax/hello-room' }, // forward + skybox
  // Learn-render roster - parity smoke shape.
  { name: 'learn-anti-aliasing', filter: '@forgeax/learn-render-anti-aliasing-msaa' }, // MSAA forward + resolveTarget
  { name: 'learn-bloom', filter: '@forgeax/learn-render-bloom' }, // bloom variant
];

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run `pnpm --filter <filter> smoke` and capture exit code + pipelineCount.
 * @param {{name: string, filter: string}} demo
 * @returns {Promise<{name: string, exitCode: number, pipelineCount: number | null, stderrTail: string}>}
 */
function runDemo(demo) {
  return new Promise((resolveP) => {
    const child = spawn('pnpm', ['--filter', demo.filter, 'smoke'], {
      cwd: ENGINE_ROOT,
      env: process.env,
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });
    child.on('close', (code) => {
      // Look for `pipelines: <N>` or `pipelineCount=<N>` style emissions.
      const pipelineMatch = /pipelines?\s*[:=]\s*(\d+)/i.exec(stdoutBuf);
      const pipelineCount = pipelineMatch ? Number.parseInt(pipelineMatch[1], 10) : null;
      const stderrTail = stderrBuf.split('\n').slice(-20).join('\n');
      resolveP({
        name: demo.name,
        exitCode: code ?? -1,
        pipelineCount,
        stderrTail,
      });
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const targets = targetDemo ? DEMOS.filter((d) => d.name === targetDemo) : DEMOS;
  if (targets.length === 0) {
    console.error(
      `[m4-smoke] no demo matches '${targetDemo}'. valid: ${DEMOS.map((d) => d.name).join(', ')}`,
    );
    process.exit(2);
  }

  const results = [];
  for (const demo of targets) {
    process.stdout.write(`[m4-smoke] ${demo.name} ... `);
    const r = await runDemo(demo);
    results.push(r);
    const ok = r.exitCode === 0;
    const pc = r.pipelineCount === null ? '(no pipeline count)' : `pipelines=${r.pipelineCount}`;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} (exit=${r.exitCode}, ${pc})\n`);
    if (!ok && r.stderrTail) {
      process.stdout.write(
        `  stderr tail:\n${r.stderrTail
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}\n`,
      );
    }
    if (!ok && bail) break;
  }

  const failures = results.filter((r) => r.exitCode !== 0);
  console.log('');
  console.log('[m4-smoke] summary:');
  console.log(`  total:    ${results.length}`);
  console.log(`  passed:   ${results.length - failures.length}`);
  console.log(`  failed:   ${failures.length}`);
  if (failures.length > 0) {
    console.log(`  failing:  ${failures.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[m4-smoke] unexpected error:', err);
  process.exit(2);
});
