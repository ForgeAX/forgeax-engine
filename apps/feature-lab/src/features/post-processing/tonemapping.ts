import {
  Camera,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { spawnHdrRamp } from './shared/scenes';

const CURVES = [
  [TONEMAP_LINEAR, 'linear'],
  [TONEMAP_REINHARD, 'reinhard'],
  [TONEMAP_REINHARD_EXTENDED, 'reinhard-extended'],
  [TONEMAP_CINEON, 'cineon'],
  [TONEMAP_ACES_FILMIC, 'aces-filmic'],
  [TONEMAP_AGX, 'agx'],
  [TONEMAP_NEUTRAL, 'neutral'],
] as const;

const curveName = (value: number): string =>
  CURVES.find(([v]) => v === value)?.[1] ?? String(value);

export default defineFeature({
  title: 'Tone Mapping',
  catalog: 'Tone Mapping',
  kind: 'visual',
  summary:
    'Camera.tonemap selects Linear, Reinhard, Reinhard Extended, Cineon, ACES Filmic, AgX or Neutral for the HDR-to-display curve. The toggle compares AgX with Linear.',
  expect:
    'ON (AgX): the bright spheres roll off toward desaturated near-white and the ramp stays readable. OFF (Linear): the three brightest spheres clip to identical saturated orange. The checks cycle all seven curves.',
  setup({ app, world, frames, hud }) {
    const { camera } = spawnStage(world, {
      eye: [0, 1.2, 5],
      target: [0, 0.7, 0],
      data: { tonemap: TONEMAP_AGX },
    });
    spawnHdrRamp(world);
    const setCurve = (value: number): void => {
      world.set(camera, Camera, { tonemap: value } as never).unwrap();
      hud.status(`tonemap = ${curveName(value)}`);
    };
    return {
      toggle(on) {
        setCurve(on ? TONEMAP_AGX : TONEMAP_LINEAR);
      },
      async checks() {
        const checks = new CheckList();
        for (const [curve, name] of CURVES) {
          setCurve(curve);
          await frames(3);
          const output = app.renderer.inspect().output;
          checks.ok(
            `${name} renders without output error`,
            output.error === undefined,
            JSON.stringify(output.error),
          );
        }
        setCurve(TONEMAP_AGX);
        await frames(2);
        return checks.items;
      },
    };
  },
});
