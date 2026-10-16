import { ANTIALIAS_TAA, DynamicResolution } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnAliasingEdges } from './shared/scenes';

const HALF = { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 } as const;

export default defineFeature({
  title: 'TAAU dynamic resolution',
  catalog: 'TAAU dynamic resolution',
  kind: 'visual',
  summary:
    'A DynamicResolution companion on a TAA camera renders the scene at a reduced internal extent and upsamples through TAA history (TAAU); equal min/max means a fixed scale.',
  expect:
    'ON (fixed 0.5 scale): the thin bars look softer and slightly blocky/shimmering, because only a quarter of the pixels are shaded. OFF: full-resolution TAA with crisp, smooth bars.',
  setup({ app, world, frames }) {
    const camera = spawnAliasingEdges(world, { antialias: ANTIALIAS_TAA });
    world.addComponent(camera, { component: DynamicResolution, data: HALF }).unwrap();
    return {
      toggle(on) {
        if (on) world.addComponent(camera, { component: DynamicResolution, data: HALF }).unwrap();
        else world.removeComponent(camera, DynamicResolution).unwrap();
      },
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        const dr = inspection.dynamicResolution;
        return new CheckList()
          .equal('dynamic resolution status', dr?.status, 'fixed')
          .ok(
            'internal extent is half the output extent, floored to 8-pixel alignment',
            dr?.extent !== undefined &&
              dr.extent.internalWidth === Math.floor((dr.extent.outputWidth * 0.5) / 8) * 8 &&
              dr.extent.internalHeight === Math.floor((dr.extent.outputHeight * 0.5) / 8) * 8,
            `extent=${JSON.stringify(dr?.extent)}`,
          )
          .equal('temporal mode', inspection.temporal.mode, 'taa').items;
      },
    };
  },
});
