import { Camera, TONEMAP_ACES_FILMIC, TONEMAP_NONE } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { passChecks, spawnHdrRamp } from './shared/scenes';

export default defineFeature({
  title: 'HDR scene color',
  catalog: 'HDR scene color',
  kind: 'visual',
  summary:
    'The Standard scene renders into a linear-HDR target and the output transform applies exposure and the curve; with tonemap none the same transform clamps radiance above 1.',
  expect:
    'ON (HDR + ACES): the five spheres form a visible brightness ramp from dim orange to near-white. OFF (LDR): the three brightest spheres clip to the same flat saturated orange-yellow.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, {
      eye: [0, 1.2, 5],
      target: [0, 0.7, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    spawnHdrRamp(world);
    return {
      toggle(on) {
        world
          .set(camera, Camera, { tonemap: on ? TONEMAP_ACES_FILMIC : TONEMAP_NONE } as never)
          .unwrap();
      },
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        return [
          ...passChecks(inspection.perFramePassNames, [
            'linear-hdr-observation',
            'output-transform',
          ]),
          ...new CheckList()
            .ok('output display-encoded', inspection.output.displayEncoded)
            .ok(
              'output error absent',
              inspection.output.error === undefined,
              JSON.stringify(inspection.output.error),
            ).items,
        ];
      },
    };
  },
});
