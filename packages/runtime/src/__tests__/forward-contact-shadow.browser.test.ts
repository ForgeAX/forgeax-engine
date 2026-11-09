import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CONTACT_SHADOW_SIZE } from './contact-shadow.fixture';
import { verifyForwardContactShadow } from './helpers/forward-contact-shadow';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { describeForwardGtaoFailure } from './helpers/forward-gtao-failure';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('applies directional-only Forward contact shadows on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CONTACT_SHADOW_SIZE;
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
    const facts = await verifyForwardContactShadow(
      created.value.renderer,
      async (name, capture) => {
        const prefix = `artifacts/webgl2-six/contact/${backend}-${name}`;
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `${prefix}.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
        await commands.writeFile(
          `${prefix}.json`,
          JSON.stringify({ receipt: capture.receipt, format: capture.format, completedFrames: 60 }),
        );
      },
      async (draw, cause) => {
        await commands.writeFile(
          `artifacts/webgl2-six/contact/${backend}-failure.json`,
          JSON.stringify(describeForwardGtaoFailure(cause)),
        );
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        try {
          await draw();
        } catch {
          /* Retain the actual failing frame's work. */
        }
        (await recorder.frameBoundary()).unwrap();
        const tape = await pending;
        if (tape.ok)
          await commands.writeFile(
            `artifacts/webgl2-six/contact/${backend}-failure.rhitape`,
            base64Bytes(tape.value.bytes),
            'base64',
          );
      },
    );
    await commands.writeFile(
      `artifacts/webgl2-six/contact/${backend}-evidence.json`,
      JSON.stringify(facts),
    );
  } finally {
    await created.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
