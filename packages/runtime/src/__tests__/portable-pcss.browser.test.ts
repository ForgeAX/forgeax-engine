import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { PCSS_SIZE, verifyPortablePcss } from './helpers/portable-pcss';

it.each(['webgpu', 'wgpu-webgl2'] as const)('qualifies PCSS blocker-distance penumbra on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PCSS_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
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
    await verifyPortablePcss(created.value.renderer, recorder, (name, bytes) =>
      commands.writeFile(
        `artifacts/webgl2-six/pcss/${backend}-${name}`,
        base64Bytes(bytes),
        'base64',
      ),
    );
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
