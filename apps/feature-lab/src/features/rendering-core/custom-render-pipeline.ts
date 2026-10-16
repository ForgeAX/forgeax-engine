import { World } from '@forgeax/engine/ecs';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine/render/authoring';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera, spawnStage } from '../../lab/stage';

const SCENE_PASS = 'lab-custom-scene';

const pipeline: RenderPipeline = {
  build({ graph, observationCaptureDomains }, topology) {
    const color = createRenderPipelineTarget(graph, 'lab-color', {
      format: 'rgba16float',
      size: 'surface',
    });
    if (!color.ok) return color;
    const depth = createRenderPipelineTarget(graph, 'lab-depth', {
      format: 'depth32float-stencil8',
      size: 'surface',
    });
    if (!depth.ok) return depth;
    const scene = addTypedScenePass(graph, {
      name: SCENE_PASS,
      color: color.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
      colorClearValues: [[1, 0, 1, 1]],
    });
    if (!scene.ok) return scene;
    const surface = importRenderPipelineSurface(graph, topology);
    if (!surface.ok) return surface;
    return addTypedOutputTransformPass(graph, color.value, surface.value.storage, {
      outputOnly: true,
      observationCaptureDomains,
    });
  },
};

export default defineFeature({
  title: 'Custom RenderPipeline',
  catalog: 'Custom RenderPipeline',
  kind: 'probe',
  summary:
    'createRenderer(canvas, { pipeline }) installs a construction-time RenderPipeline from @forgeax/engine/render/authoring: a typed scene pass into its own target plus the output transform. Submission stays renderer-owned; App does not forward this option.',
  expect:
    'All checks pass on a hidden canvas: the renderer builds the custom graph (its scene pass and present are recorded, no Standard post stages), the receipt completes, and the observed final image is the magenta clear from the custom pass.',
  async setup({ world, frames }) {
    spawnStage(world);
    await frames(1);
    return {
      async checks() {
        const checks = new CheckList();
        const [{ createRenderer }, { forgeaxBundlerAdapter }] = await Promise.all([
          import('@forgeax/engine/runtime'),
          import('virtual:forgeax/bundler'),
        ]);
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const created = await createRenderer(canvas, { pipeline }, forgeaxBundlerAdapter());
        checks.ok(
          'createRenderer with pipeline ok',
          created.ok,
          created.ok ? undefined : created.error.message,
        );
        if (!created.ok) return checks.items;
        const renderer = created.value;
        const own = new World();
        spawnCamera(own);
        const lease = renderer.attach(own);
        checks.ok('attach ok', lease.ok, lease.ok ? undefined : lease.error.code);
        if (lease.ok) {
          const input = {
            leases: [lease.value],
            camera: { lease: lease.value },
            environment: { lease: lease.value },
          };
          own.update(1 / 60);
          renderer.draw(input);
          renderer.requestObservation?.(['final-display']);
          own.update(1 / 60);
          const drawn = renderer.draw(input);
          checks.ok('draw ok', drawn.ok, drawn.ok ? undefined : drawn.error.code);
          if (drawn.ok) {
            const completed = await drawn.value.completed;
            checks.ok(
              'receipt completed',
              completed.ok,
              completed.ok ? undefined : completed.error.code,
            );
            const passes = renderer.inspect().perFramePassNames;
            checks
              .ok('custom scene pass recorded', passes.includes(SCENE_PASS), passes.join(','))
              .ok(
                'no Standard bloom stage',
                !passes.some((name) => name.includes('bloom')),
                passes.join(','),
              );
            const observed = await renderer.observe(drawn.value, { include: ['final-display'] });
            const final = observed.ok ? observed.value.observations?.[0] : undefined;
            checks.ok(
              'final image observed',
              final !== undefined,
              observed.ok ? 'no observation' : observed.error.code,
            );
            if (final !== undefined) {
              const offset = final.metadata.bytesPerRow * 32 + 32 * 4;
              const [c0 = 0, c1 = 0, c2 = 0] = final.bytes.subarray(offset, offset + 3);
              checks.ok(
                'pixel is the magenta clear',
                c0 > 200 && c1 < 60 && c2 > 200,
                `bytes=${c0},${c1},${c2} format=${final.metadata.format}`,
              );
            }
          }
        }
        await renderer.dispose();
        return checks.items;
      },
    };
  },
});
