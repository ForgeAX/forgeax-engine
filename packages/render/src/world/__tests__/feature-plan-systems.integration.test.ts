import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer as constructRenderer } from '../../assembly/factory';
import { MeshFilter, MeshRenderer } from '../../components';
import { ANTIALIAS_NONE, Camera, TONEMAP_ACES_FILMIC } from '../../components/camera';
import type { RenderFeaturePlanContext, RenderFeatureWork } from '../../features/plan';
import type { RenderFeature } from '../../features/types';
import {
  RENDER_FEATURE_PLAN_RELEASE_SYSTEM,
  RENDER_FEATURE_PLAN_SYSTEM,
} from '../feature-plan-systems';
import * as renderWorldModule from '../render-world';
import { RenderQueue } from '../render-world';

const PASS = 'synthetic.feature-plan-pass';

function syntheticFeature(): RenderFeature<undefined> {
  return {
    identity: 'synthetic.feature-plan',
    shaderModuleMode: 'immediate',
    extract: () => ok(undefined),
    plan: (_data: unknown, context: RenderFeaturePlanContext) =>
      ok({
        work: context.views
          .filter((view) => view.render)
          .map<RenderFeatureWork>((view) => ({
            scope: { view: view.identity },
            resources: [
              {
                kind: 'compute-program' as const,
                name: 'synthetic.program',
                program: {
                  wgsl: '@compute @workgroup_size(1) fn main() {}',
                  entryPoints: ['main'],
                  bindings: [
                    { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] },
                  ],
                },
              },
              {
                kind: 'buffer' as const,
                name: 'synthetic.buffer',
                size: 4,
                usage: ['storage' as const],
                data: new Uint32Array([0]),
              },
              {
                kind: 'compute-bindings' as const,
                name: 'synthetic.bindings',
                program: 'synthetic.program',
                entries: [{ binding: 0, resource: 'synthetic.buffer' }],
              },
            ],
            passes: [
              {
                kind: 'compute' as const,
                name: PASS,
                program: 'synthetic.program',
                bindings: 'synthetic.bindings',
                dispatches: [
                  { kind: 'direct' as const, entryPoint: 'main', workgroups: [1, 1, 1] },
                ],
              },
            ],
          })),
      }),
  };
}

it('compiles the Feature composite plan only from the render-feature-plan RenderQueue system', async () => {
  const created: EcsWorld[] = [];
  const realCreate = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = realCreate();
    created.push(world);
    return world;
  });
  const renderer = await constructRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi, features: [syntheticFeature()] },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  ).finally(() => spy.mockRestore());
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const renderWorld = created.find((world) =>
      world
        .scheduleData()
        .some((schedule) =>
          schedule.systems.some((system) => system.name === RENDER_FEATURE_PLAN_SYSTEM),
        ),
    );
    if (renderWorld === undefined) throw new Error('Missing Feature plan Render World');
    const schedules = renderWorld.scheduleData();
    const queue = schedules.find((schedule) => schedule.name === 'RenderQueue');
    expect(queue?.systems.map((system) => system.name)).toContain(RENDER_FEATURE_PLAN_SYSTEM);
    const cleanup = schedules.find((schedule) => schedule.name === 'RenderCleanup');
    expect(cleanup?.systems.map((system) => system.name)).toContain(
      RENDER_FEATURE_PLAN_RELEASE_SYSTEM,
    );

    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    const world = new World({ assets: renderer.assetRegistry });
    const cube = renderer.assetRegistry.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -4] } },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const frame = { leases: [lease], camera: { lease }, environment: { lease } };

    expect(renderer.draw(frame).ok).toBe(true);
    expect(errors).toEqual([]);
    expect(renderer.perFramePassNames.some((name) => name.includes(PASS))).toBe(true);
    // Compile has no other Feature plan authority: the frame fails naming the system.
    expect(renderWorld.removeSystem(RenderQueue, RENDER_FEATURE_PLAN_SYSTEM).ok).toBe(true);
    const submitted = vi.spyOn(renderer.device.queue, 'submit');
    renderer.draw(frame);
    expect(submitted).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).toContain(RENDER_FEATURE_PLAN_SYSTEM);
    expect(JSON.stringify(errors)).toContain('graph-build-failed');
    expect(JSON.stringify(errors)).toContain('feature-plan-missing');
  } finally {
    renderer.dispose();
  }
});
