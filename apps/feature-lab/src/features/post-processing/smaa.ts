import { ANTIALIAS_NONE, ANTIALIAS_SMAA, Camera } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { passChecks, spawnAliasingEdges } from './shared/scenes';

export default defineFeature({
  title: 'SMAA 1x',
  catalog: 'SMAA 1x',
  kind: 'visual',
  summary:
    'Camera.antialias = ANTIALIAS_SMAA runs SMAA 1x Medium (edge detection, area weights, neighborhood blend) at output resolution with no history.',
  expect: 'ON: long shallow bar edges become smooth gradients. OFF: hard stair-steps on every bar.',
  setup({ app, world, frames }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_SMAA });
    return {
      toggle(on) {
        world
          .set(camera, Camera, { antialias: on ? ANTIALIAS_SMAA : ANTIALIAS_NONE } as never)
          .unwrap();
      },
      async checks() {
        await frames(3);
        return passChecks(app.renderer.inspect().perFramePassNames, [
          'smaa-edges',
          'smaa-weights',
          'smaa-blend',
        ]);
      },
    };
  },
});
