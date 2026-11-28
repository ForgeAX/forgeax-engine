import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { model, type StandardMaterialOptions } from '@forgeax/engine-modeling';
// @ts-expect-error built output of a sibling package, no declaration beside the .mjs path
import { attachRecorder, buildFrameModel, decodeTape } from '../../../../rhi-debug/dist/index.mjs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, type Rgb } from '../../case/render';
import { LOW_NORMALS, SLOTS } from '../asset';
import { fitView, meshPositions, TURRET_AMBIENT } from '../frame';

/**
 * C-600 turret asset, dotted-edge diagnosis: one RHI Debug capture of the close frame of the low turret
 * (plain slot materials, the board render spec camera). Writes the frame, the tape and a work summary to
 * FORGEAX_CASE_OUT; FORGEAX_C4_NEAR overrides the camera near plane for the depth-precision check.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WORK = process.env.FORGEAX_C4_WORK ?? '/tmp/c4-turret-asset/work';
const NEAR = process.env.FORGEAX_C4_NEAR === undefined ? undefined : Number(process.env.FORGEAX_C4_NEAR);
const CAPTURE = process.env.FORGEAX_C4_CAPTURE === '1';
const READY = OUT !== undefined && existsSync(join(WORK, 'low-uv.fxem'));
const WIDTH = 1600;
const HEIGHT = 1200;
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe.skipIf(!READY)('C-600 turret asset: RHI Debug capture of the close frame (Dawn)', () => {
  it('captures the close frame', { timeout: 1800000 }, async () => {
    const low = model({ budget: { work: 4e9 } });
    low.append(new Uint8Array(readFileSync(join(WORK, 'low-uv.fxem'))));
    const out = low.toMesh({ normals: LOW_NORMALS });
    if (!out.ok) throw out.error;
    const mesh = out.value.mesh;
    const all = meshPositions(mesh);
    const near: number[] = [];
    for (let i = 0; i < all.length; i += 3) {
      const lz = all[i + 2] as number;
      if (lz > 6 && lz < 24 && Math.abs(all[i] as number) < 9.5) near.push(all[i] as number, all[i + 1] as number, all[i + 2] as number);
    }
    const view = fitView(near, DIRECTION, WIDTH / HEIGHT, CASE_FOV, 0.84);
    const slotColors: Record<string, Rgb> = {};
    const slotMaterials: Record<string, (t: unknown) => StandardMaterialOptions> = {};
    for (const [slot, s] of Object.entries(SLOTS)) {
      const options = { baseColor: [linear(s.baseColor[0]), linear(s.baseColor[1]), linear(s.baseColor[2]), 1], metallic: s.metallic, roughness: s.roughness } as StandardMaterialOptions;
      slotMaterials[slot] = () => options;
      slotColors[slot] = [linear(s.baseColor[0]), linear(s.baseColor[1]), linear(s.baseColor[2])] as unknown as Rgb;
    }
    slotColors.Default = [0.5, 0.52, 0.55];
    // @ts-expect-error built output of a sibling package, no declaration beside the .mjs path
    const recorder = CAPTURE ? attachRecorder(await import('../../../../rhi-webgpu/dist/index.mjs')).unwrap() : undefined;
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: slotColors,
      view,
      clearColor: CLEAR,
      far: 400,
      ambientIrradiance: TURRET_AMBIENT,
      ...(NEAR === undefined ? {} : { near: NEAR }),
      ...(recorder === undefined ? {} : { rhi: recorder.backend.rhi }),
      materials: slotMaterials as never,
    });
    try {
      renderer.aim(view);
      const first = await renderer.render(mesh);
      expect(renderer.covered(first)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      mkdirSync(OUT as string, { recursive: true });
      const tag = NEAR === undefined ? 'near0.01' : `near${NEAR}`;
      writeFileSync(join(OUT as string, `close-${tag}.png`), PNG.sync.write(first));
      if (recorder !== undefined) {
        const capturing = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const again = await renderer.render(mesh);
        (await recorder.frameBoundary()).unwrap();
        const captured = (await capturing).unwrap();
        const tape = decodeTape(captured.bytes).unwrap();
        const frame = buildFrameModel(tape);
        writeFileSync(join(OUT as string, 'close.rhitape'), captured.bytes);
        writeFileSync(join(OUT as string, 'close-capture.png'), PNG.sync.write(again));
        writeFileSync(join(OUT as string, 'close-frame.json'), JSON.stringify({ digest: captured.digest, byteLength: captured.byteLength, passes: frame.passes, works: frame.works.map((w: { workIndex: number; pipeline?: { descriptor?: { desc?: { label?: string } } }; attachments: unknown }) => ({ workIndex: w.workIndex, pipeline: w.pipeline?.descriptor?.desc?.label ?? null, attachments: w.attachments })), unseededResources: frame.unseededResources }, null, 1));
      }
      expect(renderer.state()).toBe('alive');
    } finally {
      await renderer.dispose();
      if (recorder !== undefined) (await recorder.dispose()).unwrap();
    }
  });
});
