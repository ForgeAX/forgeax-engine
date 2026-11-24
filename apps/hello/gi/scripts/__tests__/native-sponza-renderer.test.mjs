import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';

import {
  assembleNativeSponzaRendererHost,
  captureNativeSurfaceAfterFrame,
  evaluateNativeSurfacePresentation,
  inspectNativeSponzaGi,
} from '../native-sponza-renderer.mjs';

for (const traversal of ['ray-query', 'global-sdf']) {
  test(`native Screen Probe inspection reads its shared ${traversal} field`, () => {
    const acceleration = traversal === 'ray-query'
      ? { blasBuilt: 1, tlasBuilt: 1, bytesBuilt: 48 } : undefined;
    const actual = inspectNativeSponzaGi({
      gather: 'screen-probe', state: 'ready', submittedFrames: 23, generation: 7,
      field: { gather: 'irradiance-field', state: 'ready', traversal, generation: 3, acceleration,
        traversalFallback: traversal === 'global-sdf' ? 'hardware-ray-query-disabled' : undefined },
    });
    assert.equal(actual.state, 'ready');
    assert.equal(actual.fieldState, 'ready');
    assert.equal(actual.traversal, traversal);
    assert.equal(actual.traversalFallback,
      traversal === 'global-sdf' ? 'hardware-ray-query-disabled' : undefined);
    assert.deepEqual([actual.generation, actual.fieldGeneration], [7, 3]);
    assert.equal(actual.fieldAcceleration, acceleration ?? null);
  });
}

test('native GI inspection keeps gather state distinct from pending or absent field facts', () => {
  const pending = inspectNativeSponzaGi({ gather: 'screen-probe', state: 'ready', submittedFrames: 3,
    field: { gather: 'irradiance-field', state: 'preparing' } });
  assert.equal(pending.state, 'ready');
  assert.equal(pending.fieldState, 'preparing');
  assert.equal(pending.traversal, undefined);
  const absent = inspectNativeSponzaGi({ gather: 'screen-probe', state: 'ready', submittedFrames: 3 });
  assert.equal(absent.state, 'ready');
  assert.equal(absent.fieldState, undefined);
  assert.equal(absent.traversal, undefined);
  const field = inspectNativeSponzaGi({ gather: 'irradiance-field', state: 'ready', submittedFrames: 7,
    traversal: 'global-sdf', traversalFallback: 'hardware-ray-query-disabled' });
  assert.equal(field.traversal, 'global-sdf');
  assert.equal(field.fieldState, 'ready');
  const exact = inspectNativeSponzaGi({ state: 'ready', submittedFrames: 7 });
  assert.equal(exact.traversal, undefined);
  assert.equal(exact.state, 'ready');
  assert.deepEqual(inspectNativeSponzaGi(undefined), { state: 'off', submittedFrames: 0, failed: false,
    generation: null, fieldGeneration: null, fieldAcceleration: null });
});

test('native Sponza builds its World from the Runtime assembly asset owner', () => {
  const subscribed = [];
  const renderer = {
    subscribe(listener) {
      subscribed.push(listener);
      return () => {};
    },
  };
  const assets = new AssetRegistry();
  const errors = [];
  const host = assembleNativeSponzaRendererHost(
    { ok: true, value: { renderer, assets } },
    errors,
  );

  assert.ok(host.world instanceof World);
  assert.equal(host.renderer, renderer);
  assert.equal(host.assets, assets);
  assert.equal(host.world.assets, assets);
  assert.equal(subscribed.length, 1);

  const failure = new Error('renderer event');
  subscribed[0]({ kind: 'error', error: failure });
  assert.deepEqual(errors, [failure]);
  assets.dispose();
});

test('native Sponza reports a structured Runtime construction failure', () => {
  const failure = { code: 'renderer-host-failed', detail: { owner: 'runtime' } };
  assert.throws(
    () => assembleNativeSponzaRendererHost({ ok: false, error: failure }),
    /native Renderer bootstrap failed:.*renderer-host-failed/,
  );
});

test('native Surface may configure after the first completed blocked frame', () => {
  let configuration = null;
  const context = {
    getConfiguration: () => configuration,
    supportedTextureUsages: 0x10,
    supportedAlphaModes: ['opaque'],
  };
  const request = { info: { vendor: 'nvidia', device: 'RTX 4080', architecture: 'Ada' } };

  assert.equal(captureNativeSurfaceAfterFrame(context, request, 1), undefined);
  assert.deepEqual(evaluateNativeSurfacePresentation('blocked', false), { ready: false, invalid: false });
  assert.deepEqual(evaluateNativeSurfacePresentation('blocked', true), { ready: false, invalid: false });
  assert.deepEqual(evaluateNativeSurfacePresentation('ready', false), { ready: false, invalid: true });

  const adapterInfo = { vendor: 'nvidia', device: 'RTX 4080', architecture: 'Ada' };
  configuration = {
    device: { adapterInfo, features: new Set(['timestamp-query']) },
    format: 'bgra8unorm',
    alphaMode: 'opaque',
    colorSpace: 'srgb',
  };
  assert.deepEqual(captureNativeSurfaceAfterFrame(context, request, 3, {
    width: 1600,
    height: 900,
    scaleFactor: 2,
    visible: true,
  }), {
    configuredFrameId: 3,
    rendererDevice: { info: adapterInfo, features: ['timestamp-query'] },
    surface: {
      format: 'bgra8unorm',
      usage: undefined,
      viewFormats: [],
      alphaMode: 'opaque',
      colorSpace: 'srgb',
      extent: { width: 1600, height: 900, scaleFactor: 2 },
      supportedTextureUsages: 0x10,
      supportedAlphaModes: ['opaque'],
    },
  });
  assert.deepEqual(evaluateNativeSurfacePresentation('ready', true), { ready: true, invalid: false });
});

test('native Surface configuration must identify the Renderer adapter', () => {
  const context = {
    getConfiguration: () => ({
      device: {
        adapterInfo: { vendor: 'intel', device: 'UHD 770', architecture: 'Gen12' },
        features: new Set(),
      },
      format: 'bgra8unorm',
      alphaMode: 'opaque',
      colorSpace: 'srgb',
    }),
  };
  assert.throws(
    () => captureNativeSurfaceAfterFrame(
      context,
      { info: { vendor: 'nvidia', device: 'RTX 4080', architecture: 'Ada' } },
      1,
    ),
    /differs from Surface-compatible adapter request: vendor, device, architecture/,
  );
});
