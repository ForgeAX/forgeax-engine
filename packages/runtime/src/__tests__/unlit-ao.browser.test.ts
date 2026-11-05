import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { UNLIT_AO_SIZE, verifyUnlitAo } from './helpers/unlit-ao';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('renders Unlit and PBR-Skin AO with exact rigid, masked and posed surface normals on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = UNLIT_AO_SIZE;
  document.body.append(canvas);
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  if (backend === 'wgpu-webgl2')
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>> | undefined;
  try {
    host = await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
      },
    });
    if (!host.ok) throw host.error;
    expect(host.value.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyUnlitAo(host.value, recorder, async (lane, tape) => {
      await commands.writeFile(
        `artifacts/ao-validation/${backend}-skin-${lane}.json`,
        JSON.stringify({ digest: tape.digest, bytesBase64: base64Bytes(tape.bytes) }),
      );
    });
  } finally {
    if (host?.ok) expect((await host.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    if (backend === 'wgpu-webgl2') {
      if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', saved);
    }
    canvas.remove();
  }
});
