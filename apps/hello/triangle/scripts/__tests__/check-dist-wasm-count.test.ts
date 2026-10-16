// check-dist-wasm-count.test - fixture-driven coverage of the ship-runtime
// 0-wasm-download gate (feat-20260511-naga-rhi-wgpu-merge w14).
//
// AC-06 main-path 0-wasm invariant: the static import graph rooted at
// dist/index.html's `<script type="module" src=...>` entry MUST NOT reach
// any build-core symbol (`wgpu_wasm` / `@forgeax/engine-wgpu-wasm` / `@forgeax/engine-naga`).
// Dynamic `import(...)` edges are deliberately ignored — vite emits them as
// lazy chunks, which is the documented main-path 0-wasm behavior.
//
// Six cases (4 in-memory fixtures + 2 happy-path against real dist):
//   (1) clean static graph                                  -> exit 0
//   (2) static import leaks wgpu_wasm symbol                -> exit 1
//   (3) static import leaks @forgeax/engine-naga symbol            -> exit 1
//   (4) dynamic import containing build-core symbol (legal) -> exit 0
//   (5) missing dist/index.html                             -> exit 2
//   (6) real apps/hello/triangle/dist                       -> exit 0 (smoke)
//
// References:
//   - plan-strategy §R-S2 (vite 8 wasm asset dedup verification)
//   - plan-strategy §L-2 (ship-runtime 0-wasm-download gate)
//   - AGENTS.md §RHI / WebGPU "M3 engine factory wiring" channels 1/2/3

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const gateScript = resolve(repoRoot, 'apps/hello/triangle/scripts/check-dist-wasm-count.mjs');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(distRoot: string): RunResult {
  const r = spawnSync('node', [gateScript, distRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function buildFixture(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

describe('check-dist-wasm-count.mjs — ship-runtime 0-wasm gate', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'dist-wasm-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('(1) clean static graph -> exit 0', () => {
    buildFixture(tmpRoot, {
      'index.html': '<script type="module" src="/assets/main.js"></script>',
      'assets/main.js': 'import "./other.js"; from"./other.js"',
      'assets/other.js': 'export const ok = 1;',
    });
    const r = runGate(tmpRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 ship-runtime 0-wasm OK/);
  });

  it('(2) static import leaks wgpu_wasm symbol -> exit 1', () => {
    buildFixture(tmpRoot, {
      'index.html': '<script type="module" src="/assets/main.js"></script>',
      'assets/main.js': 'import "./chunk.js"; from"./chunk.js"',
      'assets/chunk.js': 'export const wgpu_wasm = 1;',
    });
    const r = runGate(tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 ship-runtime 0-wasm FAIL/);
    expect(r.stderr).toMatch(/wgpu_wasm/);
  });

  it('(3) static import leaks @forgeax/engine-naga symbol -> exit 1', () => {
    buildFixture(tmpRoot, {
      'index.html': '<script type="module" src="/assets/main.js"></script>',
      'assets/main.js': 'import "./chunk.js"; from"./chunk.js"',
      'assets/chunk.js': 'import { parse } from "@forgeax/engine-naga"; export { parse };',
    });
    const r = runGate(tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 ship-runtime 0-wasm FAIL/);
    expect(r.stderr).toMatch(/@forgeax\/engine-naga/);
  });

  it('(4) dynamic import with build-core symbol is legal -> exit 0', () => {
    buildFixture(tmpRoot, {
      'index.html': '<script type="module" src="/assets/main.js"></script>',
      'assets/main.js': 'import("./lazy.js").then(m => m.go())',
      'assets/lazy.js': 'export const wgpu_wasm = 1; export const go = () => wgpu_wasm;',
    });
    const r = runGate(tmpRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 ship-runtime 0-wasm OK/);
  });

  it('(5) missing dist/index.html -> exit 2', () => {
    const r = runGate(join(tmpRoot, 'nonexistent'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot read/);
  });
});

describe('check-dist-wasm-count.mjs — real dist smoke (best-effort)', () => {
  it('(6) real apps/hello/triangle/dist passes when present', () => {
    const realDist = resolve(repoRoot, 'apps/hello/triangle/dist');
    const stat = spawnSync('ls', ['-d', realDist], { encoding: 'utf8' });
    if (stat.status !== 0) {
      // No dist on this machine (e.g. before first vite build). Gate is
      // exercised by the M4 CI sweep `pnpm --filter @forgeax/hello-triangle build`
      // followed by the same script. Skip silently to keep `pnpm test:unit`
      // green on fresh checkouts.
      return;
    }
    const r = runGate(realDist);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 ship-runtime 0-wasm OK/);
  });
});
