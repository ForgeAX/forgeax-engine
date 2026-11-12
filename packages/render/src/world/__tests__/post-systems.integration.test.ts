import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { RhiError } from '@forgeax/engine-rhi';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer as constructRenderer } from '../../assembly/factory';
import {
  ANTIALIAS_FXAA,
  BLOOM_ENABLED,
  Camera,
  TONEMAP_ACES_FILMIC,
} from '../../components/camera';
import {
  type PostSubmissionQueue,
  PostSubmissions,
  RENDER_POST_CLEANUP_SYSTEM,
  RENDER_POST_COMMIT_SYSTEM,
} from '../post-systems';
import * as renderWorldModule from '../render-world';
import { RenderCleanup, RenderCommit } from '../render-world';

async function createPostScenario() {
  const created: EcsWorld[] = [];
  const realCreate = renderWorldModule.createRenderWorld;
  const spy = vi.spyOn(renderWorldModule, 'createRenderWorld').mockImplementation(() => {
    const world = realCreate();
    created.push(world);
    return world;
  });
  const renderer = await constructRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  spy.mockRestore();
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_FXAA,
          tonemap: TONEMAP_ACES_FILMIC,
          bloom: BLOOM_ENABLED,
          bloomThreshold: 1,
          bloomIntensity: 1,
          bloomSmoothWidth: 0.01,
          bloomRadius: 0,
        },
      },
    )
    .unwrap();
  expect(world.update().ok).toBe(true);
  const draw = () => renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  const renderWorld = () => created.find((candidate) => candidate.hasResource(PostSubmissions));
  return { renderer, draw, renderWorld };
}

function systemsOf(world: EcsWorld, schedule: string): string[] {
  return (
    world
      .scheduleData()
      .find((data) => data.name === schedule)
      ?.systems.map((system) => system.name) ?? []
  );
}

it('commits the accepted view AA and bloom from RenderCommit', async () => {
  const { renderer, draw, renderWorld } = await createPostScenario();
  try {
    expect(draw().ok).toBe(true);
    const world = renderWorld();
    expect(world).toBeDefined();
    if (world === undefined) return;
    expect(systemsOf(world, RenderCommit.name)).toContain(RENDER_POST_COMMIT_SYSTEM);
    expect(systemsOf(world, RenderCleanup.name)).toContain(RENDER_POST_CLEANUP_SYSTEM);
    expect(renderer.inspect().observation.antialias).toBe('fxaa');
    expect(renderer.inspect().bloom.state).toBe('active');
  } finally {
    renderer.dispose();
  }
});

it('adopts no AA or bloom without the post commit system', async () => {
  const { renderer, draw, renderWorld } = await createPostScenario();
  try {
    const world = renderWorld();
    expect(world).toBeDefined();
    if (world === undefined) return;
    world.removeSystem(RenderCommit, RENDER_POST_COMMIT_SYSTEM).unwrap();
    expect(draw().ok).toBe(true);
    expect(renderer.inspect().observation.antialias).toBeUndefined();
    expect(renderer.inspect().bloom.state).not.toBe('active');
  } finally {
    renderer.dispose();
  }
});

it('discards an unsubmitted candidate only through the post cleanup system', async () => {
  const { renderer, draw, renderWorld } = await createPostScenario();
  const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'post queue submission succeeds',
    hint: 'repair the queue and retry the frame',
  });
  try {
    expect(draw().ok).toBe(true);
    const world = renderWorld();
    expect(world).toBeDefined();
    if (world === undefined) return;
    const queue = world.getResource<PostSubmissionQueue>(PostSubmissions);

    submit.mockReturnValueOnce(err(failure));
    expect(draw().ok).toBe(false);
    expect(queue.staged).toHaveLength(0);

    world.removeSystem(RenderCleanup, RENDER_POST_CLEANUP_SYSTEM).unwrap();
    submit.mockReturnValueOnce(err(failure));
    expect(draw().ok).toBe(false);
    expect(queue.staged).toHaveLength(1);
  } finally {
    submit.mockRestore();
    renderer.dispose();
  }
});
