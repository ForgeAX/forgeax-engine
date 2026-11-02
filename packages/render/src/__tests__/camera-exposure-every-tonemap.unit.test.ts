// Camera.exposure is Three's `toneMappingExposure`: a linear multiplier applied
// before every tone operator. The Camera field doc once restricted it to the
// Reinhard-extended path, which led a Three port to rebalance light
// intensities instead of setting exposure under ACES Filmic. These gates pin
// the authored value through extraction into the Output Transform uniform; the
// shader side is pinned by tone-mapping-exposure.unit.test.ts in the shader
// package.
import { readFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from '../components';
import { extractCameraSnapshots, tonemapParams } from '../render-system-extract';
import { setActiveCamera } from '../systems/active-camera';

const OPERATORS = [
  ['reinhard-extended', TONEMAP_REINHARD_EXTENDED],
  ['reinhard', TONEMAP_REINHARD],
  ['linear', TONEMAP_LINEAR],
  ['cineon', TONEMAP_CINEON],
  ['aces-filmic', TONEMAP_ACES_FILMIC],
  ['agx', TONEMAP_AGX],
  ['neutral', TONEMAP_NEUTRAL],
] as const;

describe('Camera.exposure under every tone operator', () => {
  it.each(OPERATORS)('extracts exposure 0.3 into the %s Output Transform uniform', (name, mode) => {
    const world = new World();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: Camera,
          data: {
            ...perspective({
              fov: Math.PI / 4,
              aspect: 16 / 9,
              exposure: { kind: 'manual', multiplier: 0.3 },
            }),
            tonemap: mode,
          },
        },
      )
      .unwrap() as unknown as number;
    setActiveCamera(world, camera);
    const snapshot = extractCameraSnapshots(world)[0];
    expect(snapshot?.tonemap).toBe(name);
    expect(snapshot?.exposure).toBeCloseTo(0.3, 6);
    const view = new DataView(tonemapParams(snapshot as NonNullable<typeof snapshot>).buffer);
    expect(view.getFloat32(TONEMAP_PARAMS_LAYOUT.exposureOffset, true)).toBeCloseTo(0.3, 6);
    expect(view.getUint32(TONEMAP_PARAMS_LAYOUT.modeOffset, true)).toBe(mode);
  });

  it('documents exposure as applying to every operator, not only Reinhard-extended', () => {
    const doc = readFileSync(new URL('../components/camera.ts', import.meta.url), 'utf8');
    const exposureDoc = doc.slice(
      doc.indexOf(' *   exposure   ='),
      doc.indexOf(' *   whitePoint ='),
    );
    expect(exposureDoc).not.toContain("tonemap === 'reinhard-extended'");
    expect(exposureDoc).toContain("tonemap !== 'none'");
  });
});
