import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { MaterialPipelineRequestCache } from '../assembly/material/pipeline-request-cache';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { SceneSlotFrame, SceneSlots } from '../scene/scene-slots';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

interface FrameCounts {
  readonly pipelineRequests: number;
  readonly identityLookups: number;
}

/**
 * One changed residual row per frame. Unlit rows stay on the CPU lane for
 * color and shadow, so every row is drawn by the residual recorders.
 */
async function residualFrameCounts(count: number): Promise<FrameCounts> {
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: rhi.createShaderModule,
      createShaderModuleImmediate: rhi.createShaderModuleImmediate,
    },
  );
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World({ assets: renderer.assetRegistry });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 12] } },
      { component: Camera, data: { fov: 1.2, aspect: 1, near: 0.1, far: 60, antialias: 0 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0.25, -1, -0.45], castShadow: true, cascadeCount: 2, mapSize: 64 },
    })
    .unwrap();
  const mesh = renderer.assetRegistry.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = renderer.assetRegistry.create(Materials.unlit([0.3, 0.4, 0.8, 1])).unwrap();
  const entities: EntityHandle[] = [];
  for (let index = 0; index < count; index++)
    entities.push(
      world
        .spawn(
          { component: Transform, data: { pos: [(index % 16) - 8, Math.floor(index / 16), 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
  const draw = (frame: number) => {
    const moved = entities[frame % entities.length];
    if (moved === undefined) throw new Error('missing residual row');
    world.set(moved, Transform, { pos: [frame % 3, -2, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    expect(drawn.ok, JSON.stringify(errors)).toBe(true);
  };
  // Settle asynchronous pipeline preparation before counting a steady frame.
  for (let frame = 0; frame < 6; frame++) {
    draw(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const pipelineRequests = vi.spyOn(MaterialPipelineRequestCache.prototype, 'get');
  const frameLookups = vi.spyOn(SceneSlotFrame.prototype, 'identitySlot');
  const sceneLookups = vi.spyOn(SceneSlots.prototype, 'lookup');
  draw(6);
  expect(errors).toEqual([]);
  const counts = {
    pipelineRequests: pipelineRequests.mock.calls.length,
    identityLookups: frameLookups.mock.calls.length + sceneLookups.mock.calls.length,
  };
  for (const spy of [pipelineRequests, frameLookups, sceneLookups]) spy.mockRestore();
  renderer.dispose();
  return counts;
}

it('resolves residual pipelines and Scene rows without per-row requests or identity lookups', async () => {
  // Both scales exceed the bounded 64-row inspection sample.
  const small = await residualFrameCounts(80);
  const large = await residualFrameCounts(240);
  // Draws sharing a material, Pass and geometry layout share one pipeline
  // resolution per view; rows address their Scene row without an identity search.
  expect(large.pipelineRequests).toBe(small.pipelineRequests);
  expect(large.identityLookups).toBe(small.identityLookups);
});
