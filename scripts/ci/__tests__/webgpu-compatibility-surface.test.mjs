import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
