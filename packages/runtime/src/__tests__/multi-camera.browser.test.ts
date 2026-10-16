import { RhiError } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyMultiCamera } from './multi-camera.fixture';
import { verifyMultiCameraVfx } from './multi-camera-vfx.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

it.each([
  'world',
  'publication',
] as const)('composes independent camera views and replays Browser WebGPU through %s', {
  timeout: 180_000,
}, async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  document.body.append(canvas);
  const identity = { source: 'multi-camera', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  let rejectSubmit = false;
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ssrIdentity: gbufferReplayIdentity,
      ...(mode === 'publication' ? { publicationSource: identity } : {}),
      rhiInstrumentation: {
        beforeSubmit: () => {
          if (!rejectSubmit) return undefined;
          rejectSubmit = false;
          return new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'injected submit failure',
            hint: 'retry the same camera frame',
          });
        },
      },
    }),
  );
  try {
    await verifyMultiCamera(
      host.renderer,
      recorder,
      async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(
          `artifacts/multi-camera/${mode === 'world' ? 'browser' : 'publication-browser'}/${name}`,
          btoa(binary),
          'base64',
        );
      },
      canvas,
      () => {
        rejectSubmit = true;
      },
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 16 : 60,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});

// Dawn owns direct World VFX; Browser owns its native publication transport.
it('simulates published VFX and replays two Browser camera views', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyMultiCameraVfx({
      canvas,
      shaderManifestUrl: '/shaders/manifest.json',
      publication: true,
      warmupFrames: import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 12 : 60,
      cook: commands.cookVfxMeshLighting,
      save: async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(
          `artifacts/multi-camera/publication-browser/${name}`,
          btoa(binary),
          'base64',
        );
      },
    });
  } finally {
    canvas.remove();
  }
});
