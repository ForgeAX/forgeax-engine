import { ANTIALIAS_TAA, DynamicResolution } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

export default defineFeature({
  title: 'TAAU dynamic resolution',
  catalog: 'TAAU dynamic resolution',
  kind: 'probe',
  summary:
    'DynamicResolution on a TAA Camera scales internal Standard targets from asynchronous GPU timing; TAAU history and output stay at presentation size.',
  expect:
    'PASS when equal min/max bounds report status fixed at about half the canvas extent, an adaptive range reports a live status, and removing the component clears the inspection.',
  setup({ app, world, frames, canvas }) {
    const { camera } = spawnStage(world, { eye: [0, 1.5, 5], data: { antialias: ANTIALIAS_TAA } });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.9, 0.4, 0.1, 1] }), {
      pos: [0, 0.8, 0],
    });
    return {
      checks: serial(async () => {
        const checks = new CheckList();
        const fixedBounds = { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 };
        if (world.hasComponent(camera, DynamicResolution))
          world.set(camera, DynamicResolution, fixedBounds).unwrap();
        else
          world.addComponent(camera, { component: DynamicResolution, data: fixedBounds }).unwrap();
        await frames(4);
        const fixed = app.renderer.inspect().dynamicResolution;
        checks.equal('equal bounds are fixed', fixed?.status, 'fixed');
        const extent = fixed?.extent;
        checks.ok('fixed extent reported', extent !== undefined);
        if (extent !== undefined) {
          checks.near('scale is 0.5', extent.scale, 0.5, 1e-3);
          checks.ok(
            'internal extent is about half the output',
            Math.abs(extent.internalWidth - extent.outputWidth / 2) <= 8 &&
              Math.abs(extent.internalHeight - extent.outputHeight / 2) <= 8,
            JSON.stringify(extent),
          );
          checks.equal(
            'output stays at presentation size',
            [extent.outputWidth, extent.outputHeight],
            [canvas.width, canvas.height],
          );
        }
        world.set(camera, DynamicResolution, { minScale: 0.5, maxScale: 1 }).unwrap();
        await frames(30);
        const adaptive = app.renderer.inspect().dynamicResolution;
        checks.ok(
          'adaptive range reports a live status',
          adaptive !== undefined && adaptive.status !== 'fixed',
          JSON.stringify(adaptive),
        );
        checks.ok(
          'component survives adaptive frames',
          world.hasComponent(camera, DynamicResolution),
        );
        if (world.hasComponent(camera, DynamicResolution))
          world.removeComponent(camera, DynamicResolution).unwrap();
        await frames(3);
        checks.equal(
          'removing the component clears the inspection',
          app.renderer.inspect().dynamicResolution,
          undefined,
        );
        return checks.items;
      }),
    };
  },
});
