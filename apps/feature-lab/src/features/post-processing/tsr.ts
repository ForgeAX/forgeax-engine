import { ANTIALIAS_TAA, ANTIALIAS_TSR, Camera, DynamicResolution } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnAliasingEdges } from './shared/scenes';

export default defineFeature({
  title: 'Temporal super resolution',
  catalog: 'Temporal super resolution',
  kind: 'visual',
  summary:
    'TSR adds opaque luminance, input-resolution Guide/Moire analysis and output-resolution temporal reconstruction. TAA remains the lower-cost temporal route. History is 1x output size. Compute devices use workgroup caches; WebGL2 uses HDR fragment/MRT passes with the same temporal rules.',
  expect:
    'ON: TSR at half input resolution, with stable output-sized history. OFF: TAAU at the same input and output sizes. Compare edges and temporal stability after both routes settle.',
  setup({ app, world, frames }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_TSR });
    world
      .addComponent(camera, {
        component: DynamicResolution,
        data: { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 },
      })
      .unwrap();
    return {
      toggle(on) {
        world.set(camera, Camera, { antialias: on ? ANTIALIAS_TSR : ANTIALIAS_TAA }).unwrap();
      },
      async checks() {
        await frames(16);
        const inspection = app.renderer.inspect();
        return new CheckList()
          .equal('temporal mode', inspection.temporal.mode, 'tsr')
          .ok(
            'submitted history',
            inspection.temporal.historyValid,
            `status=${inspection.temporal.status}`,
          )
          .equal('fixed input scale', inspection.dynamicResolution?.status, 'fixed')
          .ok(
            'TSR history accounted',
            inspection.temporal.historyBytes > 0,
            `bytes=${inspection.temporal.historyBytes}`,
          ).items;
      },
    };
  },
});
