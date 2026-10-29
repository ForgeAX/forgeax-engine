import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
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
import { Materials } from '../materials';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

it('refreshes frame resources without rebuilding retained geometry, including mixed edits', () => {
  const assets = new AssetRegistry();
  const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const world = new World({ assets });
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
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, intensity: 1, direction: [0, -1, 0] },
    })
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
    return extractFrames([world], 0, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  };
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, assets, build, [lease]);
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
  const assets = new AssetRegistry();
  const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
    .unwrap();
  const spawnMesh = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
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
    return extractFrames([world], 0, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  };
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, assets, build, [lease]);
  try {
    draw();
    world.set(moved, Transform, { pos: [2, 0, 0] }).unwrap();
    world.set(content, MeshRenderer, { lightingChannels: 2 }).unwrap();
    world.update(0).unwrap();
    failPartial = true;
    expect(draw).toThrow('source publication failed');
    const recovered = draw();
    const oracle = extractFrames([world], 0, assets, undefined, {
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
  const owners = [new AssetRegistry(), new AssetRegistry()] as const;
  const assets = owners[0];
  const worlds = owners.map((assets) => new World({ assets }));
  const entities = worlds.map((world, index) => {
    const owner = owners[index];
    if (owner === undefined) throw new Error('expected a World asset owner');
    const meshHandle = owner.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    registerPropagateTransforms(world);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
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
    extractFrames(worlds, 0, assets, scene.materialSnapshotCacheStore(), {
      ...options,
      renderables: request,
    });
  const check = () => {
    const frame = scene.extractComposition(
      worlds,
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      build,
      leases,
    );
    const oracle = extractFrames(worlds, 0, assets, undefined, options);
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

it('keeps pending temporal sources hidden until the same identity publishes an accepted material', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: {} },
      { component: MotionBlur, data: { shutterAngle: 180 } },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const lease = createRenderReadLease(world),
    scene = new PersistentRenderScene();
  let available = true;
  const build = (request: PersistentRenderCandidateRequest) => {
    const frame = extractFrames([world], 0, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
    return !available && typeof request === 'object'
      ? { ...frame, renderables: [], dispatch: [] }
      : frame;
  };
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, assets, build, [lease]);
  try {
    expect(draw().renderables.length).toBe(1);
    available = false;
    world.set(entity, MeshRenderer, { lightingChannels: 2 }).unwrap();
    world.update(0).unwrap();
    const pending = draw();
    expect(pending.renderables.length).toBe(0);
    expect(pending.dispatch.length).toBe(0);
    available = true;
    const ready = draw();
    expect(ready.renderables.length).toBe(1);
    expect(ready.renderables.at(0)?.entityKey).toBe(entity);
    expect(ready.renderables.at(0)?.lightingChannels).toBe(2);
    expect(pending.renderables.length).toBe(0);
    expect(scene.inspect().fullRebuilds).toBe(1);
  } finally {
    lease.dispose();
    scene.dispose();
    assets.dispose();
  }
});

it('does not read retired material versions while an authored temporal source is hidden', () => {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  registerPropagateTransforms(world);
  const material = assets.create(Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap();
  const geometry = createPrimitiveMesh('cube').unwrap();
  const mesh = assets
    .create({
      ...geometry,
      materialSlots: geometry.materialSlots.map((slot) => ({ ...slot, defaultMaterial: material })),
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: {} },
      { component: MotionBlur, data: { shutterAngle: 180 } },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  world.update(0).unwrap();
  const lease = createRenderReadLease(world),
    scene = new PersistentRenderScene({ assets });
  const build = (request: PersistentRenderCandidateRequest) =>
    extractFrames([world], 0, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  const draw = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, assets, build, [lease]);
  try {
    const initial = draw();
    expect(initial.renderables.length).toBe(1);
    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    world.update(0).unwrap();
    const hidden = draw();
    expect(hidden.renderables.length).toBe(0);
    expect(hidden.dispatch.length).toBe(0);
    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    world.update(0).unwrap();
    const shown = draw();
    expect(shown.renderables.length).toBe(1);
    expect(shown.renderables.at(0)?.entityKey).toBe(entity);
    expect(shown.renderables.at(0)?.temporal?.reactive).toBe(true);
    expect(hidden.renderables.length).toBe(0);
    expect(initial.renderables.length).toBe(1);
    expect(scene.inspect().fullRebuilds).toBe(1);
  } finally {
    lease.dispose();
    scene.dispose();
    assets.dispose();
  }
});
