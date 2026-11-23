import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { describeForwardGtaoFailure } from './helpers/forward-gtao-failure';
import { createForwardGtaoSceneDataConsumer } from './helpers/forward-gtao-scene-data';
import { MorphOriginalFrame } from './helpers/morph-original-frame';
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
  const surfaceNormal = createForwardGtaoSceneDataConsumer(MORPH_SURFACE_SIZE, MORPH_SURFACE_SIZE);
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  const created = await constructRuntimeRendererHost(canvas, {
    rhi: recorder.backend.rhi,
    features: [surfaceNormal.feature],
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
  const original = new MorphOriginalFrame(recorder, () => created.value.renderer.inspect());
  try {
    expect(created.value.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyMorphSurface(
      created.value,
      surfaceNormal,
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
      async (_draw, cause) => {
        const prefix = `artifacts/webgl2-six/morph/${backend}-${skin ? 'skin' : 'mesh'}-failure`;
        const evidence = original.evidence();
        await commands.writeFile(
          `${prefix}.json`,
          JSON.stringify({
            failure: describeForwardGtaoFailure(cause),
            ...evidence,
            tape: undefined,
          }),
        );
        if (evidence.tape !== undefined)
          await commands.writeFile(
            `${prefix}-original-operation.rhitape`,
            base64Bytes(evidence.tape),
            'base64',
          );
      },
      original,
    );
  } finally {
    original.dispose();
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
