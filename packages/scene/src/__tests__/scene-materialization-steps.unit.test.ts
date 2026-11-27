import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { type AssetHandle, err, ok, type SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildOf,
  Children,
  Name,
  propagateTransforms,
  sceneEntityAddressKey,
  Transform,
  worldApplyMountOverride,
  worldDespawnScene,
  worldGetSceneInstanceState,
} from '../index';
import { prepareSceneTransformsSteps } from '../instances/preparation';
import {
  type SceneInstantiationContext,
  worldInstantiateSceneSteps,
} from '../instances/scene-instances';
import { retainSceneSourceReferences } from '../instances/source-references';

const SceneInstance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});
const Link = defineComponent('StreamFixtureLink', { target: 'entity' });

function fixture(authorDisabled = false, siblings = 0) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of [SceneInstance, ChildOf, Children, Name, Transform, Link, Disabled])
    world.components.register(component).unwrap();
  const child = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        floor: {
          components: {
            Transform: { pos: [1, 0, 0] },
            Name: { value: 'floor' },
            ...(authorDisabled ? { Disabled: {} } : {}),
          },
        },
        wall: {
          components: {
            Transform: {},
            ChildOf: { parent: 'floor' },
            StreamFixtureLink: { target: 'floor' },
          },
        },
      },
    })
    .unwrap();
  const handle = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        yard: { components: { Transform: {}, Name: { value: 'yard' } } },
        ...Object.fromEntries(
          Array.from({ length: siblings }, (_, index) => [
            `wing-${index}`,
            { components: {}, instance: { source: child } },
          ]),
        ),
        room: {
          components: { Transform: {}, ChildOf: { parent: 'yard' } },
          instance: {
            source: child,
            overrides: [
              {
                target: ['wall'],
                components: {
                  Name: { value: 'brick' },
                  ...(authorDisabled ? { Disabled: {} } : {}),
                },
              },
            ],
          },
        },
      },
    })
    .unwrap();
  const records = runtimeAssets(assets);
  const capture = records.beginContentCapture(handle).unwrap();
  let lease = capture.step(1).unwrap();
  while (lease === undefined) lease = capture.step(1).unwrap();
  const members: EntityHandle[] = [];
  const authoredDisabled = new Set<EntityHandle>();
  const heldSources: Array<{ readonly release: () => void; released: boolean }> = [];
  const context: SceneInstantiationContext = {
    incremental: true,
    applyOverride: (entity, override) => {
      const applied = worldApplyMountOverride(world, entity, override);
      if (applied.ok && override.comp === 'Disabled') authoredDisabled.add(entity);
      return applied;
    },
    resolveSource: (source) => ok(source as AssetHandle<'scene'>),
    resolveAsset: (reference) => {
      const result = lease.read<SceneAsset>(reference);
      return result.ok ? result : err(result.error as never);
    },
    materialize: (components) => {
      const authored = components.some(({ component }) => component === Disabled);
      const result = world.spawn(
        ...components,
        ...(authored ? [] : [{ component: Disabled, data: {} }]),
      );
      if (result.ok) {
        members.push(result.value);
        if (authored) authoredDisabled.add(result.value);
      }
      return result;
    },
    retainSource: (source) => {
      const retained = retainSceneSourceReferences(world, source);
      if (!retained.ok) return retained;
      const held = { release: retained.value, released: false };
      heldSources.push(held);
      return ok(() => {
        held.released = true;
        held.release();
      });
    },
  };
  const retire = () => {
    for (const entity of [...members].reverse()) {
      const result = world.despawn(entity);
      if (!result.ok && result.error.code !== 'stale-entity') throw result.error;
    }
    assets.release(handle).unwrap();
    assets.release(child).unwrap();
    const task = lease.retire().unwrap();
    while (!task.inspect().done) task.step(1).unwrap();
  };
  return {
    assets,
    world,
    child,
    handle,
    lease,
    context,
    members,
    authoredDisabled,
    heldSources,
    retire,
  };
}

describe('resumable Scene materialization', () => {
  it('reuses fixed nested compilations without sharing member identity or overrides', () => {
    const measured = (fixedSource: boolean) => {
      const f = fixture(false, 16);
      const context = { ...f.context, ...(fixedSource ? { fixedSource: true as const } : {}) };
      const work = worldInstantiateSceneSteps(f.world, f.handle, context);
      let resumes = 0;
      let next = work.next();
      while (!next.done) {
        resumes++;
        next = work.next();
      }
      const root = next.value.unwrap();
      const state = worldGetSceneInstanceState(f.world, root).unwrap();
      const walls = ['room', ...Array.from({ length: 16 }, (_, index) => `wing-${index}`)].map(
        (key) => {
          const wall = state.bindings.get(sceneEntityAddressKey([key, 'wall']));
          const floor = state.bindings.get(sceneEntityAddressKey([key, 'floor']));
          expect(wall).toBeDefined();
          expect(floor).toBeDefined();
          expect(f.world.get(wall as EntityHandle, Link).unwrap().target).toBe(floor);
          const name = f.world.get(wall as EntityHandle, Name);
          if (key === 'room') expect(name.unwrap().value).toBe('brick');
          else expect(name.ok).toBe(false);
          return wall;
        },
      );
      expect(new Set(walls).size).toBe(17);
      worldDespawnScene(f.world, root).unwrap();
      f.retire();
      expect(runtimeAssets(f.assets).inspect().assets).toBe(0);
      return resumes;
    };
    const ordinary = measured(false);
    const fixed = measured(true);
    expect(fixed).toBeLessThan(ordinary);
  });
  it('keeps partial members disabled and preserves nested identities, references and overrides', () => {
    const f = fixture();
    const ordinary = f.world.query({ read: [Transform] }).unwrap();
    const steps = worldInstantiateSceneSteps(f.world, f.handle, f.context);
    let next = steps.next();
    let observations = 0;
    while (!next.done) {
      observations++;
      expect([...ordinary]).toHaveLength(0);
      for (const entity of f.members) expect(f.world.hasComponent(entity, Disabled)).toBe(true);
      // Replace arena scratch between resumes while another World frame advances.
      f.world.update(1 / 60).unwrap();
      next = steps.next();
    }
    expect(observations).toBeGreaterThan(30);
    const root = next.value.unwrap();
    const state = worldGetSceneInstanceState(f.world, root).unwrap();
    const floor = state.bindings.get(sceneEntityAddressKey(['room', 'floor']));
    const wall = state.bindings.get(sceneEntityAddressKey(['room', 'wall']));
    expect(floor).toBeDefined();
    expect(wall).toBeDefined();
    if (floor === undefined || wall === undefined) throw new Error('missing nested bindings');
    expect(f.world.get(wall, Link).unwrap().target).toBe(floor);
    expect(f.world.get(wall, Name).unwrap().value).toBe('brick');
    expect(f.world.get(wall, ChildOf).unwrap().parent).toBe(floor);
    expect(f.members).toHaveLength(6);
    worldDespawnScene(f.world, root).unwrap();
    expect(f.heldSources.every((held) => held.released)).toBe(true);
    f.retire();
    expect(runtimeAssets(f.assets).inspect().assets).toBe(0);
  });

  it('unwinds the recursive stack and releases unattached source holds when cancelled mid-instance', () => {
    const f = fixture();
    const stack = new Set<number>();
    const steps = worldInstantiateSceneSteps(f.world, f.handle, f.context, undefined, stack);
    let next = steps.next();
    while (!next.done && f.members.length < 2) next = steps.next();
    expect(next.done).toBe(false);
    expect(f.heldSources.some((held) => !held.released)).toBe(true);
    steps.return(err({ code: 'stale-entity' } as never));
    expect(stack.size).toBe(0);
    expect(f.heldSources.every((held) => held.released)).toBe(true);
    f.retire();
    expect(f.world.inspect().entityCount).toBe(0);
    expect(runtimeAssets(f.assets).inspect().assets).toBe(0);
  });

  it('rejects a malformed nested field before the first member is materialized', () => {
    const f = fixture();
    const context: SceneInstantiationContext = {
      ...f.context,
      resolveAsset: (reference) =>
        reference === f.child
          ? ok({
              kind: 'scene',
              entities: { bad: { components: { Transform: { pos: 'bad' } } } },
            } as unknown as SceneAsset)
          : f.context.resolveAsset(reference),
    };
    const steps = worldInstantiateSceneSteps(f.world, f.handle, context);
    let next = steps.next();
    while (!next.done) next = steps.next();
    expect(next.value).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
    expect(f.members).toHaveLength(0);
    f.retire();
  });

  it('keeps direct and nested-override author Disabled intent distinct from temporary preparation tags', () => {
    const f = fixture(true);
    const steps = worldInstantiateSceneSteps(f.world, f.handle, f.context);
    let next = steps.next();
    while (!next.done) next = steps.next();
    const root = next.value.unwrap();
    expect(f.authoredDisabled.size).toBe(2);
    const prepare = prepareSceneTransformsSteps(f.world, {
      members: f.members,
      authorDisabled: f.authoredDisabled,
      isCurrent: f.lease.matchesCurrent,
    });
    let prepared = prepare.next();
    while (!prepared.done) prepared = prepare.next();
    expect(prepared.value.unwrap()).toBe(6);
    for (const entity of f.members) {
      if (!f.authoredDisabled.has(entity)) f.world.removeComponent(entity, Disabled).unwrap();
    }
    propagateTransforms(f.world).unwrap();
    for (const entity of f.authoredDisabled)
      expect(f.world.hasComponent(entity, Disabled)).toBe(true);
    expect([...f.world.query({ read: [Transform] }).unwrap()]).toHaveLength(4);
    worldDespawnScene(f.world, root).unwrap();
    f.retire();
  });

  it('retires an allocated managed state when its synthetic root is refused before adoption', () => {
    const f = fixture();
    const allocated = vi.spyOn(f.world, 'allocUniqueRef');
    const context: SceneInstantiationContext = {
      ...f.context,
      materialize: (components) =>
        components.some(({ component }) => component === SceneInstance)
          ? err({
              code: 'asset-budget-exceeded',
              expected: 'root capacity',
              hint: 'drain current work',
            } as never)
          : f.context.materialize(components),
    };
    const steps = worldInstantiateSceneSteps(f.world, f.handle, context);
    let next = steps.next();
    while (!next.done) next = steps.next();
    expect(next.value).toMatchObject({ ok: false, error: { code: 'asset-budget-exceeded' } });
    expect(allocated).toHaveBeenCalledTimes(1);
    const managed = allocated.mock.results[0]?.value;
    expect(f.world.resolveUniqueRef(managed).ok).toBe(false);
    expect(f.heldSources.every((held) => held.released)).toBe(true);
    allocated.mockRestore();
    f.retire();
    expect(runtimeAssets(f.assets).inspect().assets).toBe(0);
  });
});
