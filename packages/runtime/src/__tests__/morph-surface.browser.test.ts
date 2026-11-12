import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { describeForwardGtaoFailure } from './helpers/forward-gtao-failure';
import { MORPH_SURFACE_SIZE, verifyMorphSurface } from './helpers/morph-surface';

it.each([
  { backend: 'webgpu', skin: false },
  { backend: 'wgpu-webgl2', skin: false },
  { backend: 'webgpu', skin: true },
  { backend: 'wgpu-webgl2', skin: true },
] as const)('feeds Morph surfaces to AO and SSR on $backend (skin=$skin)', {
  timeout: 180_000,
}, async ({ backend, skin }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MORPH_SURFACE_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  const created = await constructRuntimeRendererHost(canvas, {
    rhi: recorder.backend.rhi,
    rhiInstrumentation: {
      resolveSurfaceDevice: (device) =>
        ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
    ssrIdentity: {
      sourceHead: 'fixture:morph-surface',
      sourceTree: 'fixture:morph-surface',
      lockSha256: 'fixture:morph-surface',
      buildSha256: 'fixture:morph-surface',
    },
  });
  if (!created.ok) throw created.error;
  try {
    expect(created.value.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyMorphSurface(
      created.value,
      async (name, facts) => {
        await commands.writeFile(
          `artifacts/webgl2-six/morph/${backend}-${name}.json`,
          JSON.stringify(facts),
        );
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `artifacts/webgl2-six/morph/${backend}-${name}.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
      },
      skin,
      async (draw, cause) => {
        const prefix = `artifacts/webgl2-six/morph/${backend}-${skin ? 'skin' : 'mesh'}-failure`;
        await commands.writeFile(
          `${prefix}.json`,
          JSON.stringify(describeForwardGtaoFailure(cause)),
        );
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        try {
          await draw();
        } catch {
          /* Preserve the same failed frame's recorded work. */
        }
        (await recorder.frameBoundary()).unwrap();
        const captured = await pending;
        if (captured.ok)
          await commands.writeFile(
            `${prefix}.rhitape`,
            base64Bytes(captured.value.bytes),
            'base64',
          );
        else await commands.writeFile(`${prefix}-capture.json`, JSON.stringify(captured.error));
      },
    );
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
