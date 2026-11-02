import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer, exposeRenderer } from '../../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { GpuScene } from '../../gpu-scene';
import { SceneComposition } from '../../scene/scene-composition';
import * as renderWorlds from '../render-world';
import { RenderCommit } from '../render-world';
import { RENDER_SCENE_COMMIT_SYSTEM } from '../scene-row-systems';

vi.mock('../render-world', async (actual) => {
  const module = await actual<typeof import('../render-world')>();
  return { ...module, createRenderWorld: vi.fn(module.createRenderWorld) };
});

it.each([
  0, 2,
])('advances the shared GPU Scene once per accepted Renderer submission ($0 CameraViews)', async (views) => {
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement,
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const created = vi.mocked(renderWorlds.createRenderWorld).mock.results.at(-1);
  if (created?.type !== 'return') throw new Error('the Renderer creates its Render World');
  const renderWorld = created.value;
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  for (let index = 0; index < Math.max(1, views); index++) {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 8] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, antialias: ANTIALIAS_NONE, bloom: BLOOM_DISABLED },
        },
      )
      .unwrap();
    if (views > 0) world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
  }
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const composition = vi.spyOn(SceneComposition.prototype, 'commitFrame');
  const stamp = vi.spyOn(GpuScene.prototype, 'commitFrame');
  const draw = async (moved: number) => {
    world.set(entity, Transform, { pos: [moved, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    composition.mockClear();
    stamp.mockClear();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) return false;
    return (await frame.value.completed).ok;
  };
  try {
    const commit = renderWorld.scheduleData().find((schedule) => schedule.name === 'RenderCommit');
    expect(commit?.systems.map((system) => system.name)).toContain(RENDER_SCENE_COMMIT_SYSTEM);
    const system = commit?.systems.find(({ name }) => name === RENDER_SCENE_COMMIT_SYSTEM);
    expect(JSON.stringify(system)).toContain('ViewSubmission');
    for (let frame = 0; frame < 3; frame++) {
      expect(await draw(frame)).toBe(true);
      // Once per Renderer submission, however many views drew the shared rows.
      expect(composition).toHaveBeenCalledTimes(1);
      expect(stamp).toHaveBeenCalledTimes(1);
    }

    // A rejected submission advances nothing.
    const submit = vi
      .spyOn(RhiNullQueue.prototype, 'submit')
      .mockReturnValueOnce(err(new RhiError({ code: 'internal-error', expected: 'x', hint: 'y' })));
    expect(await draw(4)).toBe(false);
    submit.mockRestore();
    expect(composition).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(await draw(5)).toBe(true);
    expect(stamp).toHaveBeenCalledTimes(1);

    // Without the system the accepted frame no longer advances the GPU Scene stamp.
    renderWorld.removeSystem(RenderCommit, RENDER_SCENE_COMMIT_SYSTEM).unwrap();
    expect(await draw(6)).toBe(true);
    expect(composition).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  } finally {
    composition.mockRestore();
    stamp.mockRestore();
    lease.dispose();
    expect((await renderer.dispose()).ok).toBe(true);
  }
});
