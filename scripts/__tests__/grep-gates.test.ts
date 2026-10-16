// grep-gates.test.ts (M4 w13) — fixture-driven coverage of the four shader
// pipeline grep gates after the feat-20260511-naga-rhi-wgpu-merge rewrite.
//
// Six violation fixtures (>=5 per plan-tasks #w13 acceptanceCheck) plus one
// happy-path fixture (all four gates exit 0):
//
//   (1) shader-runtime-deps-bad          -> check-shader-runtime-deps.mjs
//   (2) shader-no-compiler-import-bad    -> check-shader-no-compiler-import.mjs
//   (3) shader-dist-bad                  -> check-shader-no-naga-in-dist.mjs
//   (4) shader-naga-shim-bad             -> check-shader-no-naga-in-dist.mjs
//                                           (legacy naga_wasm leakage class)
//   (5) reverse-coupling-shader-compiler-bad -> check-concern-reverse-coupling.mjs
//   (6) reverse-coupling-rhi-wgpu-bad        -> check-concern-reverse-coupling.mjs
//   (7) happy                            -> all four gates exit 0
//
// Reference:
//   - requirements §AC-05 (grep-gate fail-fast)
//   - plan-strategy §D-P6 (banned pattern rewrite + reverse-coupling guards)
//   - charter prop 4 explicit failure + architecture-principles #4 + #5

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const fixturesDir = resolve(__dirname, 'fixtures', 'grep-gates');

const scripts = {
  noNagaInDist: resolve(repoRoot, 'scripts/check-shader-no-naga-in-dist.mjs'),
  runtimeDeps: resolve(repoRoot, 'scripts/check-shader-runtime-deps.mjs'),
  noCompilerImport: resolve(repoRoot, 'scripts/check-shader-no-compiler-import.mjs'),
  reverseCoupling: resolve(repoRoot, 'scripts/check-concern-reverse-coupling.mjs'),
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(scriptPath: string, args: string[] = []): RunResult {
  const r = spawnSync('node', [scriptPath, ...args], {
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

describe('grep gates — fail-fast on banned patterns', () => {
  it('(1) shader-runtime-deps-bad: @forgeax/engine-wgpu-wasm in shader deps -> exit 1', () => {
    const pkgPath = resolve(fixturesDir, 'shader-runtime-deps-bad/packages/shader/package.json');
    const r = run(scripts.runtimeDeps, [pkgPath]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 \(b\) FAIL/);
    expect(r.stderr).toMatch(/@forgeax\/wgpu-wasm/);
  });

  it('(2) shader-no-compiler-import-bad: src imports @forgeax/engine-wgpu-wasm -> exit 1', () => {
    const srcRoot = resolve(fixturesDir, 'shader-no-compiler-import-bad/packages/shader/src');
    const r = run(scripts.noCompilerImport, [srcRoot]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 \(c\) FAIL/);
    expect(r.stderr).toMatch(/@forgeax\/wgpu-wasm/);
  });

  it('(3) shader-dist-bad: dist js leaks @forgeax/engine-naga -> exit 1', () => {
    const distRoot = resolve(fixturesDir, 'shader-dist-bad/packages/shader/dist');
    const r = run(scripts.noNagaInDist, [distRoot]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 \(a\) FAIL/);
    expect(r.stderr).toMatch(/@forgeax\/naga/);
  });

  it('(4) shader-naga-shim-bad: dist js leaks legacy naga_wasm symbol -> exit 1', () => {
    const distRoot = resolve(fixturesDir, 'shader-naga-shim-bad/packages/shader/dist');
    const r = run(scripts.noNagaInDist, [distRoot]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-06 \(a\) FAIL/);
    expect(r.stderr).toMatch(/naga_wasm/);
  });

  it('(5) reverse-coupling-shader-compiler-bad: shader-compiler imports rhi-wgpu -> exit 1', () => {
    const root = resolve(fixturesDir, 'reverse-coupling-shader-compiler-bad');
    const r = run(scripts.reverseCoupling, ['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/concern-reverse-coupling FAIL/);
    expect(r.stderr).toMatch(/shader-compiler -> rhi-wgpu/);
  });

  it('(6) reverse-coupling-rhi-wgpu-bad: rhi-wgpu imports naga -> exit 1', () => {
    const root = resolve(fixturesDir, 'reverse-coupling-rhi-wgpu-bad');
    const r = run(scripts.reverseCoupling, ['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/concern-reverse-coupling FAIL/);
    expect(r.stderr).toMatch(/rhi-wgpu -> naga/);
  });
});

describe('grep gates — happy path (no violations)', () => {
  const happyRoot = resolve(fixturesDir, 'happy');

  it('(7a) runtime-deps gate: clean shader/package.json -> exit 0', () => {
    const pkgPath = resolve(happyRoot, 'packages/shader/package.json');
    const r = run(scripts.runtimeDeps, [pkgPath]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 \(b\) OK/);
  });

  it('(7b) no-compiler-import gate: clean shader/src -> exit 0', () => {
    const srcRoot = resolve(happyRoot, 'packages/shader/src');
    const r = run(scripts.noCompilerImport, [srcRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 \(c\) OK/);
  });

  it('(7c) no-naga-in-dist gate: clean shader/dist -> exit 0', () => {
    const distRoot = resolve(happyRoot, 'packages/shader/dist');
    const r = run(scripts.noNagaInDist, [distRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-06 \(a\) OK/);
  });

  it('(7d) reverse-coupling gate: forward-direction deps -> exit 0', () => {
    const r = run(scripts.reverseCoupling, ['--root', happyRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/concern-reverse-coupling OK/);
  });
});
