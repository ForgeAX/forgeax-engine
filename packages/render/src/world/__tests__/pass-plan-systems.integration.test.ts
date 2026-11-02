import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { Materials } from '../../materials';
import { RENDER_OPAQUE_PLAN_SYSTEM, RENDER_TRANSMISSION_PLAN_SYSTEM } from '../pass-plan-systems';
import * as renderWorldModule from '../render-world';
import { RenderQueue } from '../render-world';
import { RENDER_SSR_ADMISSION_SYSTEM } from '../ssr-admission-systems';

async function plannedScene(options: {
  readonly renderPath: 'forward' | 'deferred';
  readonly transmission: number;
}) {
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
  const profiled = renderer.setProfile({
    ...renderer.inspect().profile,
    renderPath: options.renderPath,
    ssao: false,
  });
  if (!profiled.ok) throw profiled.error;
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
  const material = assets
    .create(
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: options.transmission,
        roughness: 0.4,
      }),
    )
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
  const renderWorld = (system: string) => {
    const found = created.find((candidate) =>
      candidate
        .scheduleData()
        .some((schedule) => schedule.systems.some((entry) => entry.name === system)),
    );
    if (found === undefined) throw new Error('Missing planned Render World');
    return found;
  };
  return { renderer, errors, draw, renderWorld };
}

it('compiles the transmission backdrop only from the render-transmission-plan RenderQueue system', async () => {
  const { renderer, errors, draw, renderWorld } = await plannedScene({
    renderPath: 'forward',
    transmission: 0.8,
  });
  try {
    await draw();
    await draw();
    expect(errors).toEqual([]);
    // The planned demand built the backdrop lane.
    expect(renderer.inspect().transmission).toMatchObject({ activeCount: 1, needsRoughMips: true });
    expect(renderer.inspect().perFramePassNames).toContain('transmission-backdrop-copy');
    const world = renderWorld(RENDER_TRANSMISSION_PLAN_SYSTEM);
    expect(world.removeSystem(RenderQueue, RENDER_TRANSMISSION_PLAN_SYSTEM).ok).toBe(true);
    // Compile has no other transmission authority: the frame fails naming the system.
    await expect(draw()).rejects.toThrow('did not submit');
    expect(JSON.stringify(errors)).toContain(RENDER_TRANSMISSION_PLAN_SYSTEM);
    expect(JSON.stringify(errors)).toContain('graph-build-failed');
    expect(JSON.stringify(errors)).toContain('pass-plan-missing');
  } finally {
    await renderer.dispose();
  }
});

it('compiles the opaque G-buffer lane only from the render-opaque-plan RenderQueue system', async () => {
  const { renderer, errors, draw, renderWorld } = await plannedScene({
    renderPath: 'deferred',
    transmission: 0,
  });
  try {
    await draw();
    await draw();
    expect(errors).toEqual([]);
    // The planned Deferred lane built the G-buffer instead of the Forward main pass.
    const passes = renderer.inspect().perFramePassNames;
    expect(passes).toContain('g-buffer');
    expect(passes).not.toContain('main');
    const world = renderWorld(RENDER_OPAQUE_PLAN_SYSTEM);
    expect(world.removeSystem(RenderQueue, RENDER_OPAQUE_PLAN_SYSTEM).ok).toBe(true);
    // Compile has no other lane authority: the frame fails naming the system.
    await expect(draw()).rejects.toThrow('did not submit');
    expect(JSON.stringify(errors)).toContain(RENDER_OPAQUE_PLAN_SYSTEM);
    expect(JSON.stringify(errors)).toContain('graph-build-failed');
    expect(JSON.stringify(errors)).toContain('pass-plan-missing');
  } finally {
    await renderer.dispose();
  }
});

it('admits the deferred SSR lane only from the render-ssr-admission RenderQueue system', async () => {
  const { renderer, errors, draw, renderWorld } = await plannedScene({
    renderPath: 'deferred',
    transmission: 0,
  });
  try {
    await draw();
    await draw();
    expect(errors).toEqual([]);
    const world = renderWorld(RENDER_SSR_ADMISSION_SYSTEM);
    expect(world.removeSystem(RenderQueue, RENDER_SSR_ADMISSION_SYSTEM).ok).toBe(true);
    // Compile has no other SSR authority: the frame fails naming the system.
    await expect(draw()).rejects.toThrow('did not submit');
    expect(JSON.stringify(errors)).toContain(`${RENDER_SSR_ADMISSION_SYSTEM} did not admit`);
  } finally {
    await renderer.dispose();
  }
});
