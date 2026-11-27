import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Entity, FixedTime, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok, type SceneAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { Camera, Materials } from '../../../render/src/index';
import { extractSource } from '../../../render/src/render-system-extract-tail';
import { PersistentRenderScene } from '../../../render/src/scene/render-scene';
import {
  type PersistentRenderCandidateRequest,
  SceneComposition,
} from '../../../render/src/scene/scene-composition';
import { RenderGraphError } from '../../../render-graph';
import { AppLevelOwner } from '../levels/app-level-owner';
import { createLevelCandidate } from '../levels/candidate';
import type { CandidateRenderHost } from '../levels/candidate-render-source';
import { LEVEL_STREAMING_SOURCE_COMPONENTS } from '../levels/source-preflight';

vi.mock('@forgeax/engine-render', () => import('../../../render/src/index'));
vi.mock('@forgeax/engine-render/internal', () => import('../../../render/src/internal'));

it('retries actual Source retirement after an ordinary pending composition settles', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const composition = new SceneComposition({ assets });
  const view = new PersistentRenderScene({}, composition, false);
  const lease = createRenderReadLease(world);
  const unregister = registerPropagateTransforms(world);
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const material = assets.create(Materials.standard({ baseColor: '#ffffff' })).unwrap();
  const mesh = assets
    .create({
      ...createPrimitiveMesh('cube').unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: material }],
    })
    .unwrap();
  const scene = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        member: {
          components: { Transform: {}, MeshFilter: { assetHandle: mesh }, MeshRenderer: {} },
        },
      },
    })
    .unwrap();
  const build = (request: PersistentRenderCandidateRequest) =>
    extractSource(world, assets, composition.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
    });
  const draw = () => view.extractComposition(world, assets, build, lease);
  const candidate = createLevelCandidate({
    world,
    assets,
    scene,
    render: {
      current: () => true,
      beginStagedGroup(source, content) {
        const begun = composition.beginStagedGroup(source, content, lease);
        return begun.ok ? ok({ source: begun.value }) : begun;
      },
    },
  });
  try {
    world.update(0).unwrap();
    draw();
    const baseRows = composition.entry?.projection.slotsSnapshot().length ?? 0;
    let result = candidate.step();
    for (let step = 0; result.ok && step < 10000; step++) result = candidate.step();
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'native-preparation-incomplete' } },
    });
    expect(composition.entry?.projection.slotsSnapshot().length).toBeGreaterThan(baseRows);
    // A real unaccepted ordinary extraction occupies the existing edit boundary.
    composition.extract(world, assets, build, lease);
    expect(candidate.retireStep()).toMatchObject({
      ok: false,
      error: { detail: { reason: 'busy' } },
    });
    expect(candidate.inspect().cleanupFailure).toBeUndefined();
    draw();
    for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++)
      candidate.retireStep().unwrap();
    expect(candidate.inspect().phase).toBe('retired');
    expect(composition.entry?.projection.slotsSnapshot()).toHaveLength(baseRows);
    expect(candidate.members.every((entity) => !world.get(entity, Entity).ok)).toBe(true);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
  } finally {
    view.dispose();
    composition.dispose();
    unregister();
    assets.dispose();
  }
});

it('keeps a queued Scene moving while an obsolete native graph retires and the same Source retries', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  const scene = assets
    .create<SceneAsset>({ kind: 'scene', entities: { member: { components: { Transform: {} } } } })
    .unwrap();
  const native = Promise.withResolvers<void>();
  const renderInspections = vi.fn();
  const staleGraphRetired = vi.fn();
  let firstGraph = true;
  const begun = vi.fn<CandidateRenderHost['beginStagedGroup']>((observation) => {
    let retired = false;
    const status = () => ({
      phase: retired ? ('retired' as const) : ('resident-input' as const),
      members: observation.members.length,
      admitted: 0,
      reserved: 0,
    });
    return ok({
      source: {
        hasRasterRows: true,
        acceptSource: () => ok(undefined),
        setActive: () => ok(undefined),
        isCurrent: () => !retired,
        inspect: () => {
          renderInspections();
          return status();
        },
        step: () => ok(status()),
        retireStep() {
          retired = true;
          return ok(status());
        },
      },
      prepareViews(current) {
        const obsolete = firstGraph;
        firstGraph = false;
        const work = (function* () {
          yield native.promise;
          if (obsolete)
            throw new RenderGraphError({
              code: 'graph-preparation-invalid',
              expected: 'the original native import owner after the yield',
              hint: 'prepare the current View',
            });
        })();
        return Object.assign(work, {
          isCurrent: () => !obsolete && current(),
          isObsolete: () => obsolete && current(),
          retire: async () => {
            if (obsolete) staleGraphRetired();
            return ok(undefined);
          },
        });
      },
    });
  });
  const owner = new AppLevelOwner({
    world,
    assets,
    now: () => 0,
    render: () => ({ current: () => true, beginStagedGroup: begun }),
    physics: () => undefined,
    stopped: () => true,
  });
  try {
    const first = owner.create(scene).unwrap();
    const next = owner.create(scene).unwrap();
    for (let turn = 0; turn < 4; turn++) owner.step();
    expect(first.inspect()).toMatchObject({ phase: 'native', pending: expect.any(Promise) });
    expect(next.inspect()).toMatchObject({ phase: 'resident-source', members: 2 });
    expect(begun).toHaveBeenCalledTimes(1);
    renderInspections.mockClear();
    const fixedBefore = world.getResource(FixedTime).tick;
    owner.beginFrame();
    world.update(1 / 60).unwrap();
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(fixedBefore);
    expect(renderInspections).not.toHaveBeenCalled();
    native.resolve();
    for (let turn = 0; turn < 64 && first.inspect().phase !== 'prepared'; turn++) {
      await first.inspect().pending;
      owner.step();
    }
    expect(first.inspect().phase).toBe('prepared');
    expect(staleGraphRetired).toHaveBeenCalledOnce();
  } finally {
    native.resolve();
    await owner.closeStopped();
    assets.dispose();
  }
});

it('admits one synchronous participation transaction per App frame across fixed catch-up', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  const scene = assets
    .create<SceneAsset>({ kind: 'scene', entities: { member: { components: { Transform: {} } } } })
    .unwrap();
  const selected = vi.fn((_active: boolean) => ok(undefined));
  let stopped = false;
  const owner = new AppLevelOwner({
    world,
    assets,
    now: () => 0,
    physics: () => undefined,
    stopped: () => stopped,
    render: () => ({
      current: () => true,
      beginStagedGroup(observation) {
        let retired = false;
        const status = () => ({
          phase: retired ? ('retired' as const) : ('resident-input' as const),
          members: observation.members.length,
          admitted: 0,
          reserved: 0,
        });
        return ok({
          source: {
            hasRasterRows: false,
            acceptSource: () => ok(undefined),
            setActive: selected,
            isCurrent: () => !retired,
            inspect: status,
            step: () => ok(status()),
            retireStep() {
              retired = true;
              return ok(status());
            },
          },
          prepareViews() {
            throw new Error('empty raster group has no Views');
          },
        });
      },
    }),
  });
  try {
    const first = owner.create(scene).unwrap();
    const second = owner.create(scene).unwrap();
    for (let turn = 0; turn < 4; turn++) owner.step();
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['prepared', 'prepared']);
    first.target('active').unwrap();
    second.target('active').unwrap();
    const beforeSimulationOnly = world.getResource(FixedTime).tick;
    owner.beginFrame(false);
    world.update(1 / 60).unwrap();
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(beforeSimulationOnly);
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['prepared', 'prepared']);
    expect(selected).not.toHaveBeenCalled();
    const fixedBefore = world.getResource(FixedTime).tick;
    owner.beginFrame();
    world.update(2 / 60).unwrap();
    expect(world.getResource(FixedTime).tick - fixedBefore).toBeGreaterThanOrEqual(2);
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['active', 'prepared']);
    expect(selected.mock.calls).toEqual([[true]]);
    owner.beginFrame();
    world.update(1 / 60).unwrap();
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['active', 'active']);

    first.target('prepared').unwrap();
    second.target('prepared').unwrap();
    owner.beginFrame(false);
    world.update(1 / 60).unwrap();
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['active', 'active']);
    expect(selected.mock.calls).toEqual([[true], [true]]);
    owner.beginFrame();
    world.update(2 / 60).unwrap();
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['prepared', 'active']);
    owner.beginFrame();
    world.update(1 / 60).unwrap();
    expect([first.inspect().phase, second.inspect().phase]).toEqual(['prepared', 'prepared']);
    expect(selected.mock.calls).toEqual([[true], [true], [false], [false]]);
  } finally {
    stopped = true;
    await owner.closeStopped();
    assets.dispose();
  }
});
