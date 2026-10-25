// propagate-transforms.dawn.test.ts -- vitest dawn project (AC-04) CPU-only
// propagateTransforms behaviour test.
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: node + setupFiles ./vitest.setup-webgpu.ts injects
//   globalThis.navigator.gpu (provided by dawn.node native binding).
//
// The derived world mat4 lives in the paired `GlobalTransform.world` column
// (column-major 16 floats). Tests read that column via the ECS array view and
// assert the translation column (m[12,13,14]).
//
// Scope (w6 acceptanceCheck):
//   (a) root-only entity: GlobalTransform.world translation = local translation
//   (b) 2-level hierarchy: child.world = parent.world x child local
//   (c) stale ChildOf ref: Result.err(RhiError({ code: 'hierarchy-broken' }))
//   (d) N=3 deep chain: composition stacks correctly
//
// Although propagateTransforms is pure CPU code (no GPU access), the test is
// duplicated under the dawn layer so the AC-04 gate executes in both the
// browser GPU env and the dawn-node env -- matching plan-strategy §4 test
// matrix + requirements AC-04 two-layer coverage.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { componentId } from '../../../ecs/src/component';
import { worldInternal } from '../../../ecs/src/world-internal';

function identityTransformData() {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

// Read the resolved world mat4 (column-major 16 floats) from the
// GlobalTransform world column array view. Translation lives in column 3
// (m[12,13,14]).
function worldOf(world: World, entity: EntityHandle): Float32Array {
  const view = readRenderArrayView(world, entity, GlobalTransform, 'world');
  if (view === undefined) throw new Error('GlobalTransform.world view missing');
  return view as Float32Array;
}

describe('propagate-transforms.dawn - root-down DFS + stale ChildOf fail-fast (AC-04)', () => {
  it('root entity: GlobalTransform.world translation = local translation (identity chain)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [3, 4, 5],
          quat: [0, 0, 0, 1],
          scale: [2, 2, 2],
        },
      })
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const w = worldOf(world, root);
    expect(w.length).toBe(16);
    expect(w[12]).toBeCloseTo(3, 5);
    expect(w[13]).toBeCloseTo(4, 5);
    expect(w[14]).toBeCloseTo(5, 5);
    // Scale 2 lands on the diagonal of the rotation/scale 3x3 block.
    expect(w[0]).toBeCloseTo(2, 5);
  });

  it('2-level hierarchy: child.world = parent.world x child local (translation compose)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [10, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();
    const child = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [2, 3, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wc = worldOf(world, child);
    // parent translation (10,0,0) composed with child local translation
    // (2,3,0) and identity rotation/scale -> world position (12,3,0).
    expect(wc[12]).toBeCloseTo(12, 5);
    expect(wc[13]).toBeCloseTo(3, 5);
    expect(wc[14]).toBeCloseTo(0, 5);
    // Root world translation unaffected (identity chain writes).
    const wr = worldOf(world, root);
    expect(wr[12]).toBeCloseTo(10, 5);
  });

  it('N=3 deep hierarchy: grandchild position chains through two parent translations', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          pos: [1, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();
    const mid = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [2, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const leaf = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [4, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: ChildOf, data: { parent: mid } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wl = worldOf(world, leaf);
    // 1 + 2 + 4 = 7 along x-axis.
    expect(wl[12]).toBeCloseTo(7, 5);
  });

  it('identity scene layer inherits a transformed parent byte-for-byte', () => {
    const world = new World();
    const parent = world
      .spawn({ component: Transform, data: { pos: [7, -3, 11], scale: [2, 2, 2] } })
      .unwrap();
    const layer = world
      .spawn(
        { component: Transform, data: identityTransformData() },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    expect(worldOf(world, layer)).toEqual(worldOf(world, parent));
    world.set(layer, Transform, { pos: [1, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    expect(worldOf(world, layer)[12]).toBe(9);
  });

  it('stale ChildOf ref: Result.err(RhiError({ code: "hierarchy-broken" }))', () => {
    const world = new World();
    const ghost = world
      .spawn({
        component: Transform,
        data: identityTransformData(),
      })
      .unwrap();
    world.despawn(ghost).unwrap();
    const parent = world
      .spawn({
        component: Transform,
        data: identityTransformData(),
      })
      .unwrap();
    const orphan = world
      .spawn(
        {
          component: Transform,
          data: identityTransformData(),
        },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();

    // Public relationship writes reject stale targets. Deliberately corrupt
    // only the source column through the package-internal seam to preserve
    // this diagnostic regression for malformed imported/editor state.
    const archetype = world[worldInternal].getEntityArchetype(orphan);
    const records = world[worldInternal].getRecords();
    if (archetype === undefined) throw new Error('orphan row missing');
    const tableRow = archetype.rows[records.archetypeRow[orphan & 0xffffff] ?? -1];
    if (tableRow === undefined) throw new Error('orphan table row missing');
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
