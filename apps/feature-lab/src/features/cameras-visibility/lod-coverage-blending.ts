import { createMeshBuilder, createPlaneGeometry } from '@forgeax/engine/geometry';
import { Materials, MeshFilter } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { material, spawnCamera, spawnMesh, spawnSun } from '../../lab/stage';
import { serial } from './support/serial';
import { nextReceipt } from './support/target';

const ASPECT = 16 / 9;

function level(low: boolean): MeshAsset {
  const base = createPlaneGeometry(low ? 1.6 : 2, 2, low ? 1 : 4, low ? 1 : 4).unwrap();
  const count = (base.attributes.position as Float32Array).length / 3;
  const color = Float32Array.from({ length: count * 4 }, (_, i) =>
    i % 4 === (low ? 1 : 0) || i % 4 === 3 ? 1 : 0,
  );
  return createMeshBuilder({
    attributes: { ...base.attributes, color },
    indices: base.indices ?? [],
  })
    .build()
    .unwrap();
}

export default defineFeature({
  title: 'Adjacent LOD coverage blending',
  catalog: 'Adjacent LOD coverage blending',
  kind: 'visual',
  summary:
    'MeshAsset.lodHysteresis turns the LOD switch into a screen-coverage band where the two adjacent levels share complementary dithered coverage (both levels selected by the GPU LOD pass).',
  expect:
    'ON: the plane sits inside the 0.1 transition band, so red (LOD0) and green (LOD1) pixels interleave as a dither. OFF: lodHysteresis is 0, the switch is hard and the plane is solid green.',
  setup({ app, world, frames }) {
    const assets = app.assets;
    if (assets === undefined)
      return {
        toggle() {},
        async checks() {
          return new CheckList().ok('app.assets available', false).items;
        },
      };
    const lowerGuid = assets.parseGuid('019a0000-0000-7000-8000-0000000fe125');
    assets.catalog(lowerGuid, level(true)).unwrap();
    const root = level(false);
    const mesh = (width: number) =>
      world.allocSharedRef('MeshAsset', {
        ...root,
        lods: [{ mesh: lowerGuid, screenCoverage: 0.5 }],
        lodHysteresis: width,
      });
    const blended = mesh(0.1);
    const hard = mesh(0);
    const white = material(
      world,
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 1,
        specular: 0,
        renderState: { cullMode: 'none' },
      }),
    );
    spawnSun(world, { direction: [0, 0, -1], intensity: 3 });
    const half = Math.SQRT2 / 0.475;
    spawnCamera(world, {
      eye: [0, 0, 3],
      target: [0, 0, 0],
      data: {
        projection: 1,
        left: -half * ASPECT,
        right: half * ASPECT,
        bottom: -half,
        top: half,
        near: 0.1,
        far: 20,
        clearColor: [0, 0, 0, 1],
      },
    });
    const plane = spawnMesh(world, blended, white, { pos: [0, 0, 0] });
    // GPU LOD encodes one indirect slot per level and the selector readback
    // only keeps the latest submit, so the levels that reached the screen are
    // counted from the exact receipt's display pixels: LOD0 is red, LOD1 green.
    const drawnLevels = async (name: string, expected: number, checks: CheckList) => {
      const requested = app.renderer.requestObservation?.(['final-display']);
      if (requested !== undefined && !requested.ok) {
        checks.ok(name, false, requested.error.code);
        return;
      }
      const observed = await app.renderer.observe(await nextReceipt(app), {
        include: ['final-display'],
      });
      const frame = observed.ok
        ? observed.value.observations?.find((entry) => entry.domain === 'final-display')
        : undefined;
      if (frame === undefined) {
        checks.ok(name, false, observed.ok ? 'no final-display observation' : observed.error.code);
        return;
      }
      const { width, height, bytesPerRow, format } = frame.metadata;
      const [r, g] = format.startsWith('bgra') ? [2, 1] : [0, 1];
      let red = 0;
      let green = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const at = y * bytesPerRow + x * 4;
          const rv = frame.bytes[at + r] ?? 0;
          const gv = frame.bytes[at + g] ?? 0;
          if (rv > 128 && gv < 64) red++;
          else if (gv > 128 && rv < 64) green++;
        }
      const levels = (red > 64 ? 1 : 0) + (green > 64 ? 1 : 0);
      checks.ok(name, levels === expected, JSON.stringify({ red, green, levels }));
    };
    return {
      toggle(on) {
        world.set(plane, MeshFilter, { assetHandle: on ? blended : hard } as never);
      },
      checks: serial(async () => {
        const checks = new CheckList();
        await frames(3);
        await drawnLevels('inside the band both levels draw', 2, checks);
        world.set(plane, MeshFilter, { assetHandle: hard } as never);
        await frames(3);
        await drawnLevels('hard switch draws one level', 1, checks);
        world.set(plane, MeshFilter, { assetHandle: blended } as never);
        await frames(3);
        return checks.items;
      }),
    };
  },
});
