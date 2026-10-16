#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '../../..');
const requiredSources = [
  'packages/render/src/instances-derived-bounds.ts',
  'packages/render/src/render-system-extract.ts',
  'packages/render/src/gpu-driven/view-gpu.ts',
  'apps/hello/gltf-instancing/src/__tests__/instanced-drawcall.dawn.test.ts',
];
const requiredTokens = [
  ['packages/render/src/instances-derived-bounds.ts', 'deriveInstancesUnionBounds'],
  ['packages/render/src/render-system-extract.ts', 'deriveInstancesUnionBounds'],
  ['packages/render/src/gpu-driven/view-gpu.ts', 'candidate.instanceOrdinal'],
  ['packages/render/src/gpu-driven/view-gpu.ts', 'primitive.transformIndex'],
  [
    'apps/hello/gltf-instancing/src/__tests__/instanced-drawcall.dawn.test.ts',
    'renderer-derived union',
  ],
];

for (const path of requiredSources) {
  const absolute = resolve(repoRoot, path);
  const source = readFileSync(absolute, 'utf8');
  for (const [tokenPath, token] of requiredTokens.filter(([candidate]) => candidate === path)) {
    if (!source.includes(token)) {
      throw new Error(`instances smoke: ${tokenPath} is missing ${token}`);
    }
  }
}

const vitest = resolve(repoRoot, 'node_modules/.bin/vitest');
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
const result = spawnSync(
  vitest,
  [
    'run',
    '--project=dawn',
    'apps/hello/gltf-instancing/src/__tests__/instanced-drawcall.dawn.test.ts',
    '--maxWorkers=1',
    '--retry=0',
  ],
  { cwd: repoRoot, env: childEnv, stdio: 'inherit' },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('[deep-agent-feedback] instances culling smoke: PASS');
console.log(
  JSON.stringify({
    backend: 'dawn-node',
    runtime: 'passed',
    cpu: 'renderer-derived-union-bounds',
    gpu: 'per-instance-frustum-cull',
    emptyInstances: 'zero-draw',
    invalidBounds: 'conservative-no-cull',
    hardwareFps: 'not-claimed',
  }),
);
