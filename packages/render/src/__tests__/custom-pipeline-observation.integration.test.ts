import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '../authoring';
import { Camera } from '../components/camera';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const pipeline: RenderPipeline = {
  build({ graph, observationCaptureDomains }, topology) {
    const color = createRenderPipelineTarget(graph, 'custom-color', {
      format: 'rgba16float',
      size: 'surface',
    });
    if (!color.ok) return color;
    const depth = createRenderPipelineTarget(graph, 'custom-depth', {
      format: 'depth32float-stencil8',
      size: 'surface',
    });
    if (!depth.ok) return depth;
    const scene = addTypedScenePass(graph, {
      name: 'custom-scene',
      color: color.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
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

it('a custom pipeline output transform captures the armed final-display observation', async () => {
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi, pipeline },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  registerPropagateTransforms(world);
  world.spawn({ component: Transform, data: { pos: [0, 0, 4] } }, { component: Camera, data: {} });
  const input = {
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  };
  try {
    world.update(1 / 60).unwrap();
    expect(renderer.draw(input).ok).toBe(true);
    if (renderer.requestObservation === undefined)
      throw new Error('missing observation capability');
    const requested = renderer.requestObservation(['final-display']);
    if (!requested.ok) throw requested.error;
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw(input);
    if (!drawn.ok) throw drawn.error;
    expect(renderer.inspect().perFramePassNames).toContain('final-display-observation');
  } finally {
    await renderer.dispose();
  }
});
