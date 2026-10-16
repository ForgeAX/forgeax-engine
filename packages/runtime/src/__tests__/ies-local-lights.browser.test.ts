import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { IES_TEST_SIZE, verifyLocalIes } from './ies-local-lights.fixture';
import { verifyLocalIesReplay } from './ies-local-lights-replay.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

// Keep all four light/path combinations. The publication cases also exercise
// the complete profile assertions; neither carrier repeats their plain variants.
for (const [path, kind, combined] of [
  ['forward', 'point', false],
  ['deferred', 'rect', false],
  ['deferred', 'point', true],
  ['forward', 'rect', true],
] as const) {
  it(`renders ${path} ${kind} IES ${combined ? 'with publication and shadow/source texture' : ''} in Browser`, {
    timeout: 180_000,
  }, async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = IES_TEST_SIZE;
    document.body.append(canvas);
    const recorder = attachRecorder(webgpu).unwrap();
    const identity = { source: `ies-${kind}`, epoch: 1 };
    const host = renderValue(
      await constructRuntimeRendererHost(canvas, {
        rhi: recorder.backend.rhi,
        ...(combined ? { publicationSource: identity } : {}),
      }),
    );
    const save = async (name: string, bytes: Uint8Array) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(`artifacts/ies-point-area/browser/${name}`, btoa(binary), 'base64');
    };
    try {
      const samples = await verifyLocalIes(host.renderer, kind, path, {
        recorder,
        combined,
        ...(combined
          ? {
              publication: {
                assets: host.assets,
                identity,
              },
            }
          : {}),
        async capture(name, tape, image) {
          const shot = await page.elementLocator(canvas).screenshot({ base64: true });
          await save(
            `${name}.png`,
            Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) =>
              c.charCodeAt(0),
            ),
          );
          await save(`${name}.luminance-f32`, new Uint8Array(image.buffer));
          if (tape === undefined) return;
          await save(`${name}.rhitape`, tape.bytes);
          await verifyLocalIesReplay(name, tape, image, save);
        },
      });
      await save(
        `${path}-${kind}-${combined ? 'combined-' : ''}samples.json`,
        new TextEncoder().encode(JSON.stringify(samples, null, 2)),
      );
    } finally {
      renderValue(await host.renderer.dispose());
      canvas.remove();
      (await recorder.dispose()).unwrap();
    }
  });
}
