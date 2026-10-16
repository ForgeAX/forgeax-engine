import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../index';
import { projectHierarchy, type SceneHierarchyDiagnostic } from '../systems/hierarchy-projection';
import { setMalformedParentEdge } from './fixtures/malformed-hierarchy-edge';

describe('scene hierarchy projection contract', () => {
  it('exposes stable parent edges and diagnostic detail without throwing', () => {
    const world = new World();
    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    const snapshot = projectHierarchy(world);

    expect(snapshot.parentOf.get(child)).toBe(parent);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('keeps every diagnostic machine-readable and deterministically ordered', () => {
    const world = new World();
    const first = world.spawn({ component: Transform, data: {} }).unwrap();
    const second = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: first } })
      .unwrap();
    const third = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: second } })
      .unwrap();
    setMalformedParentEdge(world, second, third);

    const diagnostics: readonly SceneHierarchyDiagnostic[] = projectHierarchy(world).diagnostics;

    expect(diagnostics.map((item) => item.detail.entity)).toEqual(
      [...diagnostics.map((item) => item.detail.entity)].sort((a, b) => a - b),
    );
    for (const diagnostic of diagnostics) {
      expect(['hierarchy-cycle', 'hierarchy-broken']).toContain(diagnostic.code);
      expect(diagnostic.expected).toEqual(expect.any(String));
      expect(diagnostic.hint).toEqual(expect.any(String));
      expect(diagnostic.detail.entity).toEqual(expect.any(Number));
      expect(diagnostic.detail.parent).toEqual(expect.any(Number));
    }
  });
});
