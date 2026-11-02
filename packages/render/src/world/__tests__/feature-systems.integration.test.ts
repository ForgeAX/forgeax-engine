import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../__tests__/feature-frame-driver';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer as constructRenderer } from '../../assembly/factory';
import { MeshFilter, MeshRenderer, MotionBlur } from '../../components';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  TONEMAP_ACES_FILMIC,
} from '../../components/camera';
import { createRenderFeatureHost, type RenderFeatureFrameInput } from '../../features/host';
import type { RenderFeaturePlanContext, RenderFeatureWork } from '../../features/plan';
import * as preparedResolverModule from '../../features/prepared-resolver';
import type { RenderFeature } from '../../features/types';
import { worldRenderResources } from '../../publication/resource-scope';
import {
  RENDER_FEATURE_ABORT_SYSTEM,
  RENDER_FEATURE_COMMIT_SYSTEM,
  RENDER_FEATURE_VIEWS_SYSTEM,
  RENDER_MOTION_BLUR_PLAN_SYSTEM,
  renderFeatureSystemName,
} from '../feature-systems';
import * as renderWorldModule from '../render-world';
import { RenderCleanup, RenderCommit, RenderPrepare } from '../render-world';

const PASS = 'synthetic.feature-system-pass';

function syntheticFeature(extracted: number[]): RenderFeature<undefined> {
  return {
    identity: 'synthetic.feature-system',
    shaderModuleMode: 'immediate',
    extract: (context) => {
      extracted.push(context.frameNumber);
      return ok(undefined);
    },
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

it("prepares each installed Feature in RenderPrepare of the Renderer's Render World", async () => {
  const preparedResolver = vi.spyOn(preparedResolverModule, 'createPreparedResolver');
  const created: EcsWorld[] = [];
  const realCreate = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = realCreate();
    created.push(world);
    return world;
  });
  const extracted: number[] = [];
  const renderer = await constructRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi, features: [syntheticFeature(extracted)] },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  spy.mockRestore();
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const renderWorld = created.find((world) =>
      world
        .scheduleData()
        .some(
          (schedule) =>
            schedule.name === 'RenderPrepare' &&
            schedule.systems.some(
              (system) => system.name === renderFeatureSystemName('synthetic.feature-system'),
            ),
        ),
    );
    expect(renderWorld).toBeDefined();
    if (renderWorld === undefined) return;
    expect(renderWorld.scheduleData().some((s) => s.name === 'RenderFeaturePrepare')).toBe(false);
    const errors: { code?: string; detail?: unknown }[] = [];
    renderer.onError((error) => errors.push(error as { code?: string; detail?: unknown }));

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
            bloom: BLOOM_DISABLED,
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
    expect(extracted).toHaveLength(1);
    // Feature materials resolve in Prepare, before Queue establishes a recording attempt.
    const prepared = preparedResolver.mock.calls.at(0);
    expect(Array.from(prepared ?? []).at(2)).toEqual([worldRenderResources(world)]);
    expect(renderer.perFramePassNames.some((name) => name.includes(PASS))).toBe(true);

    // An installed Feature whose system no longer runs leaves the batch
    // incomplete: recording reports it and submits no frame.
    renderWorld
      .removeSystem(RenderPrepare, renderFeatureSystemName('synthetic.feature-system'))
      .unwrap();
    const submitted = vi.spyOn(renderer.device.queue, 'submit');
    renderer.draw(frame);
    expect(extracted).toHaveLength(1);
    expect(submitted).not.toHaveBeenCalled();
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'render-feature-batch-incomplete',
        detail: { missing: ['synthetic.feature-system'] },
      }),
    );
  } finally {
    preparedResolver.mockRestore();
    renderer.dispose();
  }
});

it('records Features only from the input render-feature-views prepared', async () => {
  const created: EcsWorld[] = [];
  const realCreate = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = realCreate();
    created.push(world);
    return world;
  });
  const extracted: number[] = [];
  const renderer = await constructRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi, features: [syntheticFeature(extracted)] },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  ).finally(() => spy.mockRestore());
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World({ assets: renderer.assetRegistry });
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const errors: { code?: string; detail?: unknown }[] = [];
    renderer.onError((error) => errors.push(error as { code?: string; detail?: unknown }));
    const frame = { leases: [lease], camera: { lease }, environment: { lease } };
    expect(renderer.draw(frame).ok).toBe(true);
    expect(extracted).toHaveLength(1);
    const renderWorld = created.find((candidate) =>
      candidate
        .scheduleData()
        .some((schedule) =>
          schedule.systems.some((system) => system.name === RENDER_FEATURE_VIEWS_SYSTEM),
        ),
    );
    if (renderWorld === undefined) throw new Error('Missing Feature Render World');
    expect(renderWorld.removeSystem(RenderPrepare, RENDER_FEATURE_VIEWS_SYSTEM).ok).toBe(true);
    // Recording never re-derives the input: the view reports it and records no Features.
    renderer.draw(frame);
    expect(extracted).toHaveLength(1);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'render-feature-input-unavailable',
        detail: expect.objectContaining({ reason: 'not-prepared' }),
      }),
    );
  } finally {
    renderer.dispose();
  }
});

it('installs motion blur at construction and plans it only in render-motion-blur-plan', async () => {
  const created: EcsWorld[] = [];
  const realCreate = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = realCreate();
    created.push(world);
    return world;
  });
  const renderer = await constructRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  ).finally(() => spy.mockRestore());
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const motionBlurSystem = renderFeatureSystemName('forgeax.motion-blur');
    const renderWorld = created.find((world) =>
      world
        .scheduleData()
        .some((schedule) => schedule.systems.some((system) => system.name === motionBlurSystem)),
    );
    // Installed with the Renderer on a capable device, before any frame demands it.
    expect(renderWorld).toBeDefined();
    if (renderWorld === undefined) return;
    const schedule = () =>
      renderWorld.scheduleData().map((s) => [s.name, s.systems.map((system) => system.name)]);

    const world = new World({ assets: renderer.assetRegistry });
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
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
    expect(world.update().ok).toBe(true);
    const frame = { leases: [lease], camera: { lease }, environment: { lease } };
    expect(renderer.draw(frame).ok).toBe(true);
    expect(renderer.perFramePassNames).not.toContain('motion-blur');
    const before = schedule();

    world
      .addComponent(camera, {
        component: MotionBlur,
        data: { shutterAngle: 180, maxRadiusPixels: 8, sampleCount: 4, targetFps: 60 },
      })
      .unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frame).ok).toBe(true);
    expect(renderer.inspect().motionBlur?.execution?.program).toBe('motion-blur-compute');
    // The first demanding frame neither installs a Feature nor rebuilds the schedule.
    expect(schedule()).toEqual(before);

    // Recording never re-plans motion blur: without the system the Feature sees no input.
    expect(renderWorld.removeSystem(RenderPrepare, RENDER_MOTION_BLUR_PLAN_SYSTEM).ok).toBe(true);
    expect(renderer.draw(frame).ok).toBe(true);
    expect(renderer.inspect().motionBlur?.execution).toBeUndefined();
    expect(renderer.inspect().motionBlur?.passCount).toBe(0);
  } finally {
    renderer.dispose();
  }
});

function settlementFeature(events: string[]): RenderFeature<number> {
  return {
    identity: 'synthetic.settlement',
    extract: (context) => ok(context.frameNumber),
    plan: (_frame, context) =>
      ok({
        work: context.views.map((view) => ({
          scope: { view: view.identity },
          resources: [],
          passes: [],
        })),
      }),
    onFrameSubmitted: (frame, submission) =>
      events.push(
        `submitted:${frame}:${submission?.works.map((work) => JSON.stringify(work.scope)).join(',')}`,
      ),
    onFrameAborted: (frame) => events.push(`aborted:${frame}`),
  };
}

function settlementInput(identity: string, frameNumber: number): RenderFeatureFrameInput {
  return { identity, render: true, worlds: [], owner: 0, frameNumber, caps: {} as never };
}

it('settles a Feature frame only in render-feature-commit and render-feature-abort', () => {
  const events: string[] = [];
  const host = createRenderFeatureHost([
    settlementFeature(events) as RenderFeature<unknown>,
  ]).unwrap();
  try {
    // A rejected RenderSubmission aborts the frame and never acknowledges it.
    prepareFeatureFrame(host, [settlementInput('left', 1)]);
    abortFeatureFrame(host);
    expect(events).toEqual(['aborted:1']);

    // An accepted one acknowledges exactly the plans a submitted graph recorded.
    const batch = prepareFeatureFrame(host, [
      settlementInput('left', 2),
      settlementInput('right', 2),
    ]);
    submitFeatureFrame(host, batch.views.get('right')?.plans ?? []);
    expect(events).toEqual(['aborted:1', 'submitted:2:{"view":"right"}']);

    // Without render-feature-commit an accepted frame is never acknowledged:
    // render-feature-abort discards it.
    expect(host.world.removeSystem(RenderCommit, RENDER_FEATURE_COMMIT_SYSTEM).ok).toBe(true);
    prepareFeatureFrame(host, [settlementInput('left', 3)]);
    submitFeatureFrame(host);
    expect(events.at(-1)).toBe('aborted:3');

    // Without render-feature-abort a rejected frame stays open until the next
    // frame aborts it as stale: the abort is that system's product.
    expect(host.world.removeSystem(RenderCleanup, RENDER_FEATURE_ABORT_SYSTEM).ok).toBe(true);
    prepareFeatureFrame(host, [settlementInput('left', 4)]);
    abortFeatureFrame(host);
    expect(events.at(-1)).toBe('aborted:3');
    prepareFeatureFrame(host, [settlementInput('left', 5)]);
    expect(events.at(-1)).toBe('aborted:4');
  } finally {
    host.dispose();
  }
});

it('reports a Feature settlement failure through the host reporter without throwing', () => {
  const reported: unknown[] = [];
  const feature: RenderFeature<undefined> = {
    identity: 'synthetic.failing-settlement',
    extract: () => ok(undefined),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onFrameSubmitted: () => {
      throw new Error('submitted callback');
    },
  };
  const host = createRenderFeatureHost([feature], undefined, (error) =>
    reported.push(error),
  ).unwrap();
  try {
    prepareFeatureFrame(host, [settlementInput('main', 1)]);
    expect(() => submitFeatureFrame(host)).not.toThrow();
    expect(reported).toEqual([
      expect.objectContaining({
        code: 'internal-error',
        detail: expect.objectContaining({
          error: expect.objectContaining({ code: 'render-feature-settlement-failed' }),
        }),
      }),
    ]);
  } finally {
    host.dispose();
  }
});
