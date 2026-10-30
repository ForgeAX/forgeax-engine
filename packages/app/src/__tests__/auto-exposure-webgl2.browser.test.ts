import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createApp } from '../browser';

it('presents 60 real WebGL2 frames with authored auto exposure using its fallback', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  await wgpu.ensureReady();
  let completed = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const observe = (event: Event) => {
    if ((event as CustomEvent).detail?.presentation === 'ready' && ++completed >= 60)
      resolveReady();
  };
  canvas.addEventListener('forgeax:frame-completed', observe);
  const created = await createApp(
    canvas,
    { rhi: wgpu.rhi },
    {
      shaderManifestUrl: '/shaders/manifest.json',
    },
  );
  expect(created.ok, created.ok ? undefined : JSON.stringify(created.error)).toBe(true);
  if (!created.ok) return;
  const app = created.value;
  const stopErrors = app.onError(rejectReady);
  const timer = setTimeout(
    () => rejectReady(new Error('WebGL2 did not complete 60 frames')),
    90_000,
  );
  try {
    expect(app.renderer.inspect().capabilities).toMatchObject({
      backendKind: 'wgpu-webgl2',
      compute: false,
      storageBuffer: false,
    });
    app.world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: perspective({
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 20,
            exposure: {
              kind: 'auto',
              fallback: 0.6,
              compensationEv: 1,
              rangeEv: [-2, 1],
              rates: [2, 1],
            },
          }),
        },
      )
      .unwrap();
    const started = app.start();
    expect(started.ok, started.ok ? undefined : JSON.stringify(started.error)).toBe(true);
    await ready;
    app.stop();
    const output = app.renderer.inspect().output;
    expect(output.autoExposure).toMatchObject({
      requested: { kind: 'auto', fallback: expect.closeTo(0.6, 5) },
      actual: expect.closeTo(0.6, 5),
      actualState: 'fallback',
      cost: { histogramBytes: 0, passCount: 0, physicalPassCount: 0 },
      receipt: { committed: false },
      recentFailure: {
        code: 'auto-exposure-capability-unavailable',
        detail: { capability: 'compute' },
      },
    });
    expect(output.graphPassNames.some((name) => name.startsWith('auto-exposure-'))).toBe(false);
    expect(app.lastError).toBeUndefined();
  } finally {
    canvas.removeEventListener('forgeax:frame-completed', observe);
    clearTimeout(timer);
    stopErrors();
    await app.dispose();
    canvas.remove();
  }
});

it('completes hidden WebGL2 preparation through the direct Unlit shadow path', {
  timeout: 90_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  await wgpu.ensureReady();
  const created = await createApp(
    canvas,
    { rhi: wgpu.rhi },
    {
      shaderManifestUrl: '/shaders/manifest.json',
    },
  );
  if (!created.ok) throw created.error;
  const app = created.value;
  let completed = 0;
  let ready = 0;
  let last: { readonly presentation: string } | undefined;
  const observe = (event: Event) => {
    last = (event as CustomEvent).detail;
    completed++;
    if (last?.presentation === 'ready') ready++;
  };
  canvas.addEventListener('forgeax:frame-completed', observe);
  try {
    const assets = app.assets;
    if (assets === undefined) throw new Error('WebGL2 preparation requires the asset service');
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    app.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [], preparePipelines: true } },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    app.world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          direction: [-0.5, -1, -0.3],
          color: [1, 1, 1],
          intensity: 3,
          mapSize: 64,
          cascadeCount: 1,
        },
      })
      .unwrap();
    app.world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: perspective({ fov: Math.PI / 4, aspect: 1, near: 0.1, far: 20 }),
        },
      )
      .unwrap();
    app.start().unwrap();
    await expect.poll(() => completed, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
    expect(ready, JSON.stringify(last)).toBeGreaterThan(0);
    expect(last?.presentation).toBe('ready');
    expect(app.lastError).toBeUndefined();
  } finally {
    canvas.removeEventListener('forgeax:frame-completed', observe);
    await app.dispose();
    canvas.remove();
  }
});
