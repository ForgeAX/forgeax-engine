// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { componentId } from '../../../ecs/src/component';
import { worldInternal } from '../../../ecs/src/world-internal';

afterEach(() => vi.restoreAllMocks());
{
  // --- from propagate-transforms.test.ts ---

  interface LocalTrs {
    pos: number[];
    quat: number[];
    scale: number[];
  }

  function trs(overrides: Partial<LocalTrs> = {}): LocalTrs {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ...overrides,
    };
  }

  /** Independent reference compose(local.TRS) for in-test expectation. */
  function composeLocal(t: LocalTrs): Float32Array {
    const out = mat4.create();
    mat4.compose(out, t.pos, t.quat, t.scale);
    return out;
  }

  function readWorld(world: World, entity: EntityHandle): Float32Array {
    return world.get(entity, GlobalTransform).unwrap().world as Float32Array;
  }

  function expectMatClose(actual: Float32Array, expected: Float32Array): void {
    for (let i = 0; i < 16; i++) {
      expect(actual[i]).toBeCloseTo(expected[i] as number, 5);
    }
  }

  describe('w7 - propagate writes GlobalTransform.world mat4 (AC-05 / AC-06)', () => {
    it('root: world == compose(local.TRS) element-wise epsilon<=1e-5 (AC-06)', () => {
      const world = new World();
      const local = trs({ pos: [3, 4, 5], scale: [2, 2, 2] });
      const root = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, root);
      expectMatClose(view, composeLocal(local));
    });

    it('flat (no ChildOf, no extra component): world == compose(local) without registering anything (AC-06)', () => {
      const world = new World();
      // 90deg rotation about +Z: quat (0, 0, sin45, cos45) = (0, 0, SQRT1_2, SQRT1_2).
      const local = trs({ pos: [0, 7, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
      const flat = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, flat);
      expectMatClose(view, composeLocal(local));
    });

    it('child: world == parent.world x compose(local) element-wise epsilon<=1e-5 (AC-05)', () => {
      const world = new World();
      const parentLocal = trs({ pos: [10, 0, 0], scale: [2, 2, 2] });
      const childLocal = trs({ pos: [2, 3, 0] });
      const parent = world.spawn({ component: Transform, data: parentLocal }).unwrap();
      const child = world
        .spawn({ component: Transform, data: childLocal }, { component: ChildOf, data: { parent } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      // parent.world = compose(parentLocal); child.world = parent.world x compose(childLocal).
      const expectedParent = composeLocal(parentLocal);
      const expectedChild = mat4.create();
      mat4.multiply(expectedChild, expectedParent, composeLocal(childLocal));

      expectMatClose(readWorld(world, parent), expectedParent);
      expectMatClose(readWorld(world, child), expectedChild);

      // Sanity on the composed translation: parent scales child local pos by 2,
      // adds parent translation -> (10 + 2*2, 0 + 2*3, 0) = (14, 6, 0).
      const cv = readWorld(world, child);
      expect(cv[12]).toBeCloseTo(14, 5);
      expect(cv[13]).toBeCloseTo(6, 5);
      expect(cv[14]).toBeCloseTo(0, 5);
    });

    it('deep chain grandparent -> parent -> child: world stacks left-multiplied (AC-05)', () => {
      const world = new World();
      const gpLocal = trs({ pos: [1, 0, 0] });
      const pLocal = trs({ pos: [2, 0, 0] });
      const cLocal = trs({ pos: [4, 0, 0] });
      const gp = world.spawn({ component: Transform, data: gpLocal }).unwrap();
      const p = world
        .spawn({ component: Transform, data: pLocal }, { component: ChildOf, data: { parent: gp } })
        .unwrap();
      const c = world
        .spawn({ component: Transform, data: cLocal }, { component: ChildOf, data: { parent: p } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const gpWorld = composeLocal(gpLocal);
      const pWorld = mat4.create();
      mat4.multiply(pWorld, gpWorld, composeLocal(pLocal));
      const cWorld = mat4.create();
      mat4.multiply(cWorld, pWorld, composeLocal(cLocal));

      expectMatClose(readWorld(world, gp), gpWorld);
      expectMatClose(readWorld(world, p), pWorld);
      expectMatClose(readWorld(world, c), cWorld);

      // 1 + 2 + 4 = 7 along x.
      expect(readWorld(world, c)[12]).toBeCloseTo(7, 5);
    });

    it('ChildOf referencing a despawned parent: hierarchy-broken (existing missing-parent semantics)', () => {
      const world = new World();
      const ghost = world.spawn({ component: Transform, data: trs() }).unwrap();
      world.despawn(ghost).unwrap();
      const parent = world.spawn({ component: Transform, data: trs() }).unwrap();
      const child = world
        .spawn({ component: Transform, data: trs() }, { component: ChildOf, data: { parent } })
        .unwrap();

      // Public relationship writes reject stale targets.  Deliberately corrupt
      // only the source column through the package-internal seam to preserve
      // this diagnostic regression for malformed imported/editor state.
      const archetype = world[worldInternal].getEntityArchetype(child);
      const records = world[worldInternal].getRecords();
      if (archetype === undefined) throw new Error('child row missing');
      const tableRow = archetype.rows[records.archetypeRow[child & 0xffffff] ?? -1];
      if (tableRow === undefined) throw new Error('child table row missing');
      const table = world[worldInternal].getGraph().tables[archetype.tableId];
      const parentColumn = table?.storage.get(componentId(ChildOf))?.fields.get('parent');
      if (parentColumn === undefined) throw new Error('ChildOf.parent column missing');
      parentColumn.view[tableRow] = ghost as number;

      const r = propagateTransforms(world);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('hierarchy-broken');
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.expected.length).toBeGreaterThan(0);
    });
  });
}
