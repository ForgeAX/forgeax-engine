import { Camera, perspective } from '@forgeax/engine-render';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createApp } from '../browser';
import { attachBrowserRhiRecorder } from '../host-adapter';

it('keeps the RHI Debug recorder on WebGL2 when navigator.gpu has no adapter', {
  timeout: 120_000,
}, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.append(canvas);
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => null },
  });
  try {
    const created = await createApp(canvas, undefined, {
      shaderManifestUrl: '/shaders/manifest.json',
      attachRhiRecorder: attachBrowserRhiRecorder,
    });
    expect(created.ok, created.ok ? undefined : JSON.stringify(created.error)).toBe(true);
    if (!created.ok) return;
    try {
      expect(created.value.renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
      expect(created.value.rhiCapture).toBeDefined();
      created.value.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 4, aspect: 1, near: 0.1, far: 20 }),
              clearColor: [0.25, 0.5, 0.75, 1],
            },
          },
        )
        .unwrap();
      const started = created.value.start();
      expect(started.ok, started.ok ? undefined : JSON.stringify(started.error)).toBe(true);
      if (started.ok) {
        const captured = await created.value.rhiCapture?.captureFrame({
          snapshotTimeoutMs: 10_000,
        });
        expect(captured?.ok, captured?.ok ? undefined : JSON.stringify(captured?.error)).toBe(true);
        expect(captured?.ok ? captured.value.byteLength : 0).toBeGreaterThan(0);
        created.value.stop();
      }
    } finally {
      await created.value.dispose();
    }
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', descriptor);
    canvas.remove();
  }
});

it('records the explicitly selected WebGL2 RHI even when navigator.gpu exists', {
  timeout: 120_000,
}, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.append(canvas);
  let nativeProbes = 0;
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: async () => {
        nativeProbes++;
        throw new Error('wrong backend');
      },
    },
  });
  try {
    await wgpu.ensureReady();
    const created = await createApp(
      canvas,
      { rhi: wgpu.rhi },
      {
        shaderManifestUrl: '/shaders/manifest.json',
        attachRhiRecorder: attachBrowserRhiRecorder,
      },
    );
    expect(created.ok, created.ok ? undefined : JSON.stringify(created.error)).toBe(true);
    expect(nativeProbes).toBe(0);
    if (!created.ok) return;
    try {
      expect(created.value.renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
      expect(created.value.rhiCapture).toBeDefined();
      created.value.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 4, aspect: 1, near: 0.1, far: 20 }),
              clearColor: [0.25, 0.5, 0.75, 1],
            },
          },
        )
        .unwrap();
      expect(created.value.start().ok).toBe(true);
      const captured = await created.value.rhiCapture?.captureFrame({ snapshotTimeoutMs: 10_000 });
      expect(captured?.ok, captured?.ok ? undefined : JSON.stringify(captured?.error)).toBe(true);
      expect(captured?.ok ? captured.value.byteLength : 0).toBeGreaterThan(0);
      created.value.stop();
    } finally {
      await created.value.dispose();
    }
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', descriptor);
    canvas.remove();
  }
});
