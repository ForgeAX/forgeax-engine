import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
  Skylight,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

it('refreshes frame resources without rebuilding retained geometry, including mixed edits', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const mesh = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const sun = world
    .spawn({ component: DirectionalLight, data: { intensity: 1, direction: [0, -1, 0] } })
    .unwrap();
  const lamp = world
    .spawn(
      { component: Transform, data: { pos: [1, 2, 3] } },
      { component: PointLight, data: { intensity: 2, range: 10 } },
    )
    .unwrap();
  const sky = world.spawn({ component: Skylight, data: { intensity: 0.1 } }).unwrap();
  world.update(0).unwrap();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene();
  const requests: PersistentRenderCandidateRequest[] = [];
  const build = (request: PersistentRenderCandidateRequest) => {
    requests.push(request);
    return extractFrames([world], 0, undefined, undefined, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  };
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
  try {
    draw();
    requests.length = 0;
    const edits = [
      () => world.set(camera, Camera, { exposure: 1.5, aspect: 1.25 }).unwrap(),
      () => world.set(sun, DirectionalLight, { intensity: 3, direction: [0.5, -1, 0] }).unwrap(),
      () => world.set(lamp, PointLight, { intensity: 4, range: 7 }).unwrap(),
      () => world.set(sky, Skylight, { intensity: 0.2 }).unwrap(),
      () =>
        world.addComponent(camera, { component: MotionBlur, data: { shutterAngle: 180 } }).unwrap(),
      () => world.removeComponent(camera, MotionBlur).unwrap(),
      () => {
        world.set(camera, Camera, { exposure: 2 }).unwrap();
        world.set(mesh, Transform, { pos: [0.25, 0, 0] }).unwrap();
      },
      () => world.despawn(lamp).unwrap(),
    ];
    for (const edit of edits) {
      edit();
      world.update(0).unwrap();
      const frame = draw();
      const oracle = extractFrames([world], 0);
      expect(frame.cameras).toEqual(oracle.cameras);
      expect(frame.lights).toEqual(oracle.lights);
      expect(frame.skylight).toEqual(oracle.skylight);
      expect(frame.renderables.map((row) => [row.entityKey, [...row.transform.world]])).toEqual(
        oracle.renderables.map((row) => [row.entityKey, [...row.transform.world]]),
      );
      expect(requests).not.toContain('full');
      expect(scene.inspect().fullRebuilds).toBe(1);
      requests.length = 0;
    }
  } finally {
    lease.dispose();
    scene.dispose();
  }
});

it('retries consumed transforms when a mixed source publication fails', () => {
  const world = new World();
  registerPropagateTransforms(world);
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
    .unwrap();
  const spawnMesh = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const moved = spawnMesh();
  const content = spawnMesh();
  world.update(0).unwrap();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene();
  let failPartial = false;
  const build = (request: PersistentRenderCandidateRequest) => {
    if (failPartial && typeof request === 'object') {
      failPartial = false;
      throw new Error('source publication failed');
    }
    return extractFrames([world], 0, undefined, undefined, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  };
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
  try {
    draw();
    world.set(moved, Transform, { pos: [2, 0, 0] }).unwrap();
    world.set(content, MeshRenderer, { lightingChannels: 2 }).unwrap();
    world.update(0).unwrap();
    failPartial = true;
    expect(draw).toThrow('source publication failed');
    const recovered = draw();
    const oracle = extractFrames([world], 0, undefined, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    expect(
      recovered.renderables.map((row) => [
        row.entityKey,
        row.lightingChannels,
        [...row.transform.world],
      ]),
    ).toEqual(
      oracle.renderables.map((row) => [
        row.entityKey,
        row.lightingChannels,
        [...row.transform.world],
      ]),
    );
    expect(scene.inspect().fullRebuilds).toBe(1);
  } finally {
    lease.dispose();
    scene.dispose();
  }
});

it('keeps untouched World hidden reports during partial edits and removals', () => {
  const worlds = [new World(), new World()];
  const entities = worlds.map((world) => {
    registerPropagateTransforms(world);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();
    world.update(0).unwrap();
    return entity;
  });
  const leases = worlds.map((world) => createRenderReadLease(world));
  const [firstWorld, secondWorld] = worlds;
  const [firstEntity, secondEntity] = entities;
  if (
    firstWorld === undefined ||
    secondWorld === undefined ||
    firstEntity === undefined ||
    secondEntity === undefined
  )
    throw new Error('expected two Worlds and entities');
  const scene = new PersistentRenderScene();
  const options = { cull: 'none', retainHidden: true } as const;
  const build = (request: PersistentRenderCandidateRequest) =>
    extractFrames(worlds, 0, undefined, undefined, scene.materialSnapshotCacheStore(), {
      ...options,
      renderables: request,
    });
  const check = () => {
    const frame = scene.extractComposition(
      worlds,
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      build,
      leases,
    );
    const oracle = extractFrames(worlds, 0, undefined, undefined, undefined, options);
    const hidden = (value: typeof frame) =>
      value.hiddenEntityReports.map((report) => `${report.world.identity}:${report.entity}`).sort();
    expect(hidden(frame)).toEqual(hidden(oracle));
    expect(frame.visibilityStats).toEqual(oracle.visibilityStats);
  };
  try {
    check();
    firstWorld.set(firstEntity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    firstWorld.update(0).unwrap();
    check();
    secondWorld.despawn(secondEntity).unwrap();
    secondWorld.update(0).unwrap();
    check();
  } finally {
    for (const lease of leases) lease.dispose();
    scene.dispose();
  }
});
