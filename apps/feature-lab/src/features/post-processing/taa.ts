import { ANTIALIAS_NONE, ANTIALIAS_TAA, Camera } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnAliasingEdges } from './shared/scenes';

export default defineFeature({
  title: 'TAA',
  catalog: 'TAA',
  kind: 'visual',
  summary:
    'Camera.antialias = ANTIALIAS_TAA jitters the projection and accumulates two histories into an unjittered, supersampled output.',
  expect:
    'ON: after a few frames the thin bars converge to smooth, continuous anti-aliased lines. OFF: hard stair-steps and dotted, broken bars.',
  setup({ app, world, frames }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_TAA });
    return {
      toggle(on) {
        world
          .set(camera, Camera, { antialias: on ? ANTIALIAS_TAA : ANTIALIAS_NONE } as never)
          .unwrap();
      },
      async checks() {
        await frames(3);
        const temporal = app.renderer.inspect().temporal;
        return new CheckList()
          .equal('temporal mode', temporal.mode, 'taa')
          .ok('history valid', temporal.historyValid, `status=${temporal.status}`)
          .ok(
            'history bytes allocated',
            temporal.historyBytes > 0,
            `historyBytes=${temporal.historyBytes}`,
          ).items;
      },
    };
  },
});
