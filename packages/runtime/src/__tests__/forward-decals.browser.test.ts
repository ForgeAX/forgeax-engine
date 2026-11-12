import { encodePng } from '@forgeax/engine-image/png';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyDecals } from './decals.fixture';
import { base64Bytes } from './helpers/forward-gtao-capture';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('projects ordered color, normal and roughness decals before Forward lighting on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const replayCanvas = backend === 'wgpu-webgl2' ? document.createElement('canvas') : undefined;
  const replayBackend = backend === 'webgpu' ? webgpu : wgpu;
  const recorder = attachRecorder(replayBackend).unwrap();
  const created = await constructRuntimeRendererHost(canvas, {
    rhi: recorder.backend.rhi,
    rhiInstrumentation: {
      resolveSurfaceDevice: (device) =>
        ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  if (!created.ok) {
    canvas.remove();
    (await recorder.dispose()).unwrap();
    throw created.error;
  }
  try {
    expect(created.value.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyDecals(
      created.value.renderer,
      recorder,
      async (name, bytes) => {
        const prefix = `artifacts/webgl2-six/decals/${backend}-${name}`;
        await commands.writeFile(prefix, base64Bytes(bytes), 'base64');
        if (name.endsWith('.rgba'))
          await commands.writeFile(
            prefix.replace('.rgba', '.png'),
            base64Bytes(encodePng(128, 128, bytes)),
            'base64',
          );
      },
      60,
      'forward',
      { backend: replayBackend, compatibleSurface: replayCanvas },
    );
  } finally {
    await created.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    replayCanvas?.remove();
    canvas.remove();
  }
});
