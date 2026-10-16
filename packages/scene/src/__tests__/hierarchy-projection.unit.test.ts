import { Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { entityIndex } from '../../../ecs/src/entity-handle';
import { ChildOf, Transform } from '../index';
import { projectHierarchy } from '../systems/hierarchy-projection';
import { setMalformedParentEdge } from './fixtures/malformed-hierarchy-edge';

function childOf(world: World, parent: EntityHandle): EntityHandle {
  return world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
    .unwrap();
}

describe('scene hierarchy projection', () => {
  it('projects hierarchy edges without materializing unrelated live entity rows', () => {
    const world = new World();
    const roots = Array.from({ length: 2048 }, () => world.spawn().unwrap());
    const parent = roots[0];
    if (parent === undefined) throw Error('missing live root');
    const child = childOf(world, parent);
    const query = world.query.bind(world);
    let observedRows = 0;
    const probe = vi.spyOn(world, 'query').mockImplementation((...args) => {
      const result = query(...args);
      if (result.ok) {
        const iterate = result.value[Symbol.iterator].bind(result.value);
        vi.spyOn(result.value, Symbol.iterator).mockImplementation(function* () {
          const iterator = iterate();
          for (let row = iterator.next(); !row.done; row = iterator.next()) {
            observedRows++;
            yield row.value;
          }
        });
      }
      return result;
    });
    try {
      expect(projectHierarchy(world).getParent(child)).toBe(parent);
      expect(observedRows).toBe(0);
    } finally {
      probe.mockRestore();
    }
  });

  it('keeps a live parent edge even when the parent has no Transform', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = childOf(world, parent);

    const snapshot = projectHierarchy(world);

    expect(snapshot.getParent(child)).toBe(parent);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('cuts a stale parent edge and reports a machine-readable diagnostic', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = childOf(world, parent);
    const staleParent = world.spawn().unwrap();
    world.despawn(staleParent).unwrap();
    setMalformedParentEdge(world, child, staleParent);

    const snapshot = projectHierarchy(world);
    const diagnostic = snapshot.diagnostics[0];

    expect(snapshot.getParent(child)).toBeUndefined();
    expect(diagnostic?.code).toBe('hierarchy-broken');
    expect(diagnostic?.detail.entity).toBe(child);
    expect(diagnostic?.detail.parent).toBe(staleParent);
    expect(diagnostic?.expected).toContain('live entity');
    expect(diagnostic?.hint.length).toBeGreaterThan(0);
  });

  it('terminates self and multi-member cycles and sorts diagnostics by entity', () => {
    const world = new World();
    const self = childOf(world, world.spawn().unwrap());
    const a = childOf(world, world.spawn().unwrap());
    const b = childOf(world, world.spawn().unwrap());
    const c = childOf(world, world.spawn().unwrap());
    setMalformedParentEdge(world, self, self);
    setMalformedParentEdge(world, a, b);
    setMalformedParentEdge(world, b, c);
    setMalformedParentEdge(world, c, a);

    const snapshot = projectHierarchy(world);
    const cycleDiagnostics = snapshot.diagnostics.filter((item) => item.code === 'hierarchy-cycle');
    const diagnosticEntities = cycleDiagnostics.map((item) => item.detail.entity);

    expect(snapshot.getParent(self)).toBeUndefined();
    expect(snapshot.getParent(a)).toBeUndefined();
    expect(snapshot.getParent(b)).toBeUndefined();
    expect(snapshot.getParent(c)).toBeUndefined();
    expect(cycleDiagnostics).toHaveLength(4);
    expect(diagnosticEntities).toEqual([...diagnosticEntities].sort((x, y) => x - y));
    expect(cycleDiagnostics.every((item) => item.detail.parent !== undefined)).toBe(true);
  });

  it('does not invent a parent edge for a root entity', () => {
    const world = new World();
    const root = world.spawn().unwrap();

    expect(projectHierarchy(world).getParent(root)).toBeUndefined();
  });

  it('bounds hierarchy rebuild work by parent edges when unrelated roots change', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const roots = [parent, ...Array.from({ length: 1023 }, () => world.spawn().unwrap())];
    const child = childOf(world, parent);
    const first = projectHierarchy(world);
    world.spawn().unwrap();
    let visited = 0;
    const query = world.query.bind(world);
    const queries = vi.spyOn(world, 'query').mockImplementation((spec) => {
      const result = query(spec);
      if (result.ok) {
        const rows = result.value[Symbol.iterator].bind(result.value);
        vi.spyOn(result.value, Symbol.iterator).mockImplementation(function* () {
          const iterator = rows();
          for (let row = iterator.next(); !row.done; row = iterator.next()) {
            visited += 1;
            yield row.value;
          }
        });
      }
      return result;
    });
    try {
      const next = projectHierarchy(world);
      expect(next).not.toBe(first);
      expect([...next.parentOf]).toEqual([[child, parent]]);
      expect(next.diagnostics).toEqual([]);
      for (const root of roots) expect(next.getParent(root)).toBeUndefined();
      expect(visited).toBeLessThanOrEqual(2);
      expect(projectHierarchy(world)).toBe(next);
    } finally {
      queries.mockRestore();
    }
  });

  it('rejects a stale parent generation even when its entity slot is live again', () => {
    const world = new World();
    const child = childOf(world, world.spawn().unwrap());
    const stale = world.spawn().unwrap();
    world.despawn(stale).unwrap();
    const replacement = world.spawn().unwrap();
    expect(world.hasComponent(replacement, Entity)).toBe(true);
    expect(entityIndex(replacement)).toBe(entityIndex(stale));
    expect(replacement).not.toBe(stale);
    setMalformedParentEdge(world, child, stale);

    const snapshot = projectHierarchy(world);
    expect(snapshot.getParent(child)).toBeUndefined();
    expect(snapshot.diagnostics).toMatchObject([
      { code: 'hierarchy-broken', detail: { entity: child, parent: stale } },
    ]);
  });

  it('retains a reparented child when its former parent is deleted', () => {
    const world = new World();
    const former = world.spawn().unwrap();
    const parent = world.spawn().unwrap();
    const child = childOf(world, former);
    const first = projectHierarchy(world);
    world.set(child, ChildOf, { parent }).unwrap();
    world.despawn(former).unwrap();

    expect(projectHierarchy(world).parentOf).toEqual(new Map([[child, parent]]));
    expect(first.getParent(child)).toBe(former);
    world.despawn(parent).unwrap();
    expect(projectHierarchy(world).parentOf.size).toBe(0);
  });

  it('reuses a stable World projection and invalidates it after a hierarchy mutation', () => {
    const world = new World();
    const firstParent = world.spawn().unwrap();
    const secondParent = world.spawn().unwrap();
    const child = childOf(world, firstParent);

    const first = projectHierarchy(world);
    expect(projectHierarchy(world)).toBe(first);
    expect(first.getParent(child)).toBe(firstParent);

    world.set(child, ChildOf, { parent: secondParent }).unwrap();

    const second = projectHierarchy(world);
    expect(second).not.toBe(first);
    expect(second.getParent(child)).toBe(secondParent);
    expect(projectHierarchy(world)).toBe(second);
  });
});
