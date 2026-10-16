import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const LEGACY_SURFACE = [
  'renderer.ready',
  'renderer.device',
  'renderer.store',
  'renderer.assets',
  'renderer.readPixels',
  'renderer.observeCurrentFrame',
  'renderer.attachWorld',
  'renderer.detachWorld',
  'renderer.installRenderFeature',
  'renderer.uninstallRenderFeature',
  'RendererCreateOptions',
  'RendererBackend',
  'GpuResourceStore',
  'readRenderLease',
  'renderReadLease',
  'rawDevice',
  'rawQueue',
  'rawEncoder',
  'render-v2',
  'URP_PIPELINE_ID',
  'HDRP_PIPELINE_ID',
  'projectionLedger',
  'RenderFeatureGraphBufferRegistry',
  'RenderFeatureGpuWorkResolver',
];

const OWNER_FILES = [
  'packages/render/src/assembly/factory.ts',
  'packages/render/src/authoring.ts',
  'packages/render/src/construct-renderer.ts',
  'packages/runtime/src/createRenderer.ts',
  'packages/app/src/create-app.ts',
];

test('render owners do not publish the retired architecture surface', () => {
  const hits = [];
  for (const path of OWNER_FILES) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
    for (const token of LEGACY_SURFACE) {
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(token)) hits.push(`${path}:${index + 1}: ${token}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('legacy surface gate keeps intentional variants in the same forbidden set', () => {
  const variants = ['ready', 'raw device', 'registry getter', 'second frame path', 'concrete host'];
  assert.deepEqual(variants, [
    'ready',
    'raw device',
    'registry getter',
    'second frame path',
    'concrete host',
  ]);
});
