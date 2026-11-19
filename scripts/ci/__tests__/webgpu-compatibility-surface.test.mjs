import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { collectSurface, surfaceChanges } from '../check-webgpu-compatibility.mjs';

test('reviews changed descriptors, new bypasses, WGSL and deleted owner inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-surface-'));
  const write = (name, text) => {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    write('.gitignore', '.wasm-build/\n');
    write('packages/rhi-wgpu/.wasm-build/ignored.ts', 'navigator.gpu');
    for (const name of ['packages', 'apps', 'templates'])
      mkdirSync(join(root, name), { recursive: true });
    write('packages/rhi/src/index.ts', 'interface Queue {}');
    write('packages/rhi-webgpu/src/device.ts', 'device.createTexture({usage: 1})');
    write('packages/plain/src/plain.ts', 'const unrelated = 1');
    const before = collectSurface(root);
    write('packages/rhi-webgpu/src/device.ts', 'device.createTexture({usage: 2})');
    write('apps/new/src/raw.ts', 'navigator.gpu.requestAdapter()');
    write('packages/shader/src/a.wgsl', '@compute @workgroup_size(1) fn main() {}');
    write('packages/rhi-webgpu/src/__tests__/a.test.ts', 'navigator.gpu');
    rmSync(join(root, 'packages/rhi/src/index.ts'));
    assert.deepEqual(surfaceChanges(before, collectSurface(root)), [
      { file: 'apps/new/src/raw.ts', change: 'added' },
      { file: 'packages/rhi-webgpu/src/device.ts', change: 'changed' },
      { file: 'packages/rhi/src/index.ts', change: 'removed' },
      { file: 'packages/shader/src/a.wgsl', change: 'added' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial reviewed snapshot retains every unreviewed change and deletion', () => {
  const previous = {
    'packages/rhi/src/index.ts': 'old-rhi',
    'packages/shader/src/water.wgsl': 'old-water',
    'packages/render/src/unreviewed.ts': 'old-render',
  };
  const current = {
    'packages/rhi/src/index.ts': 'reviewed-rhi',
    'packages/shader/src/water.wgsl': 'new-water',
  };
  const partial = {
    ...previous,
    'packages/rhi/src/index.ts': current['packages/rhi/src/index.ts'],
  };
  assert.deepEqual(surfaceChanges(partial, current), [
    { file: 'packages/render/src/unreviewed.ts', change: 'removed' },
    { file: 'packages/shader/src/water.wgsl', change: 'changed' },
  ]);
});

test('compatibility surface review gates shared input production before downstream fanout', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const [coreId, core] = Object.entries(workflow.jobs).find(([, job]) => job.name === 'ci-core');
  const position = core.steps.findIndex(
    (step) => step.name === 'WebGPU compatibility surface review',
  );
  const install = core.steps.findIndex((step) => step.name === 'Install (frozen)');
  const build = core.steps.findIndex((step) => step.name === 'Build package JavaScript once');
  assert.ok(install >= 0 && position > install && build > position);
  assert.match(core.steps[position].run, /node scripts\/ci\/check-webgpu-compatibility\.mjs/);
  assert.equal(
    Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.name === 'WebGPU compatibility surface review').length,
    1,
  );
  assert.ok(workflow.jobs['primary-pnpm'].needs.includes(coreId));
});
