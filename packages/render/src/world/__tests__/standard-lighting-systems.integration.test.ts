import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../../components';
import { Materials } from '../../materials';
import * as lightingPreparation from '../../pipeline/standard-lighting/prepare';
import * as renderWorldModule from '../render-world';
import { RenderPrepare } from '../render-world';
import { RENDER_STANDARD_LIGHTING_SYSTEM } from '../standard-lighting-systems';

it('records Standard lighting only from the render-standard-lighting RenderPrepare system', async () => {
  const created: EcsWorld[] = [];
  const createRenderWorld = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = createRenderWorld();
    created.push(world);
    return world;
  });
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  ).finally(() => spy.mockRestore());
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const assets = renderer.assetRegistry;
  const world = new World({ assets });
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const lease = attachment.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
    )
    .unwrap();
  world
    .spawn({ component: DirectionalLight, data: { direction: [0.2, -1, 0.1], castShadow: false } })
    .unwrap();
  const material = assets
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.4 }))
    .unwrap();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const errors: unknown[] = [];
  const prepare = vi.spyOn(lightingPreparation, 'prepareStandardLighting');
  renderer.onError((error) => errors.push(error));
  const draw = async () => {
    world.update().unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) throw drawn.error;
    if (drawn.value !== undefined) {
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
    }
  };
  try {
    await draw();
    await draw();
    expect(prepare).toHaveBeenCalledTimes(2);
    const firstScratch = prepare.mock.calls[0]?.[1];
    expect(firstScratch).toBeDefined();
    expect(prepare.mock.calls[1]?.[1]).toBe(firstScratch);
    expect(errors).toEqual([]);
    expect(renderer.inspect().perFramePassNames).toContain('main');
    const renderWorld = created.find((candidate) =>
      candidate
        .scheduleData()
        .some((schedule) =>
          schedule.systems.some((system) => system.name === RENDER_STANDARD_LIGHTING_SYSTEM),
        ),
    );
    if (renderWorld === undefined) throw new Error('Missing lit Render World');
    expect(renderWorld.removeSystem(RenderPrepare, RENDER_STANDARD_LIGHTING_SYSTEM).ok).toBe(true);
    // Recording has no other lighting authority: the frame fails naming the system.
    await expect(draw()).rejects.toThrow('did not submit');
    expect(JSON.stringify(errors)).toContain(`${RENDER_STANDARD_LIGHTING_SYSTEM} did not prepare`);
  } finally {
    prepare.mockRestore();
    await renderer.dispose();
  }
});
