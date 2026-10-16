import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { componentSchema, defineComponent } from '../component';
import { componentDefinition } from '../component-schema';
import { ManagedBufferOutOfBoundsError } from '../errors';
import { getDerivedWriter } from '../internal';
import { defineRelationship, RelationshipIndex, relationshipRole } from '../relationship-index';
import { World } from '../world';
import { worldInternal } from '../world-internal';

describe('relationship index', () => {
  it('keeps source writable and target materialized/read-only by role', () => {
    const pair = defineRelationship({
      sourceName: 'IndexSource',
      sourceField: 'target',
      targetName: 'IndexTargets',
      targetField: 'sources',
    });
    expect(relationshipRole(pair.source)?.kind).toBe('source');
    expect(relationshipRole(pair.target)?.kind).toBe('target');
    expect(componentDefinition(pair.target).fields.sources?.transient).toBe(true);
    expect(componentSchema(pair.target).sources).toBe('array<entity>');
  });

  it('stores only source slots; World owns the materialized target array', () => {
    const index = new RelationshipIndex();
    const parentA = 1 as never;
    const parentB = 2 as never;
    const first = 11 as never;
    const second = 12 as never;
    index.attach(first, parentA, 0);
    index.attach(second, parentA, 1);
    expect(index.slotOf(second)).toBe(1);
    expect(index.detach(first)).toBe(true);
    index.updateSlot(second, parentA, 0);
    expect(index.slotOf(second)).toBe(0);
    index.reparent(second, parentB, 0);
    expect(index.targetOf(second)).toBe(parentB);
    expect(index.epoch).toBeGreaterThan(0);
  });

  it('recovers only from the supplied R source records', () => {
    const index = new RelationshipIndex();
    index.recover([
      [11 as never, 1 as never],
      [12 as never, 1 as never],
    ]);
    expect(index.slotOf(11 as never)).toBe(0);
    expect(index.slotOf(12 as never)).toBe(1);
    expect(index.targetOf(12 as never)).toBe(1);
  });

  it('materializes the target and rejects direct target writes', () => {
    const pair = defineRelationship({
      sourceName: 'WorldSource',
      sourceField: 'target',
      targetName: 'WorldTargets',
      targetField: 'sources',
    });
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: pair.source, data: { target } }).unwrap();
    expect(world.get(target, pair.target).unwrap().sources).toContain(source);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.set(target, pair.target, { sources: [] }).ok).toBe(false);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.removeComponent(target, pair.target).ok).toBe(false);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.addComponent(target, { component: pair.target, data: { sources: [] } }).ok).toBe(
      false,
    );
    world.spawn({ component: pair.target, data: { sources: [] } });
  });

  it('detaches public target arrays from the materialized mirror and index', () => {
    const pair = defineRelationship({
      sourceName: 'DetachedSource',
      sourceField: 'target',
      targetName: 'DetachedTargets',
      targetField: 'sources',
    });
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: pair.source, data: { target } }).unwrap();
    const beforeEpoch = world[worldInternal].getRelationshipEpoch(pair.source);
    const exposed = world.get(target, pair.target).unwrap().sources;

    exposed.fill(0);
    exposed[0] = 0;

    expect(Array.from(world.get(target, pair.target).unwrap().sources)).toEqual([source]);
    expect(
      Array.from(world[worldInternal].getRelationshipTargetEntities(pair.source, target)),
    ).toEqual([source]);
    expect(world.get(source, pair.source).unwrap().target).toBe(target);
    expect(world[worldInternal].getRelationshipEpoch(pair.source)).toBe(beforeEpoch);
  });

  it('routes source set, row mutation, reparent, and null detach through one mirror owner', () => {
    const pair = defineRelationship({
      sourceName: 'OwnedSource',
      sourceField: 'target',
      targetName: 'OwnedTargets',
      targetField: 'sources',
    });
    const world = new World();
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const source = world.spawn({ component: pair.source, data: { target: first } }).unwrap();

    expect(Array.from(world.get(first, pair.target).unwrap().sources)).toEqual([source]);
    world.set(source, pair.source, { target: second }).unwrap();
    expect(Array.from(world.get(first, pair.target).unwrap().sources)).toEqual([]);
    expect(Array.from(world.get(second, pair.target).unwrap().sources)).toEqual([source]);

    const row = world
      .query({ write: [pair.source] })
      .unwrap()
      .at(source);
    if (row === undefined) throw new Error('expected source row');
    row.mut(pair.source).target = first;
    expect(Array.from(world.get(second, pair.target).unwrap().sources)).toEqual([]);
    expect(Array.from(world.get(first, pair.target).unwrap().sources)).toEqual([source]);

    world.set(source, pair.source, { target: null }).unwrap();
    expect(Array.from(world.get(first, pair.target).unwrap().sources)).toEqual([]);

    const sourceQuery = world.query({ write: [pair.source] }).unwrap();
    const sourceSpans = sourceQuery.spans();
    expect(sourceSpans.ok).toBe(false);
    if (!sourceSpans.ok) expect(sourceSpans.error.detail.reason).toBe('relationship-component');
    const sourceWriter = getDerivedWriter(sourceQuery, pair.source);
    expect(sourceWriter.ok).toBe(false);
    if (!sourceWriter.ok) expect(sourceWriter.error.detail.reason).toBe('relationship-component');

    const targetQuery = world.query({ write: [pair.target] }).unwrap();
    const targetWriter = getDerivedWriter(targetQuery, pair.target);
    expect(targetWriter.ok).toBe(false);
    if (!targetWriter.ok) expect(targetWriter.error.detail.reason).toBe('relationship-component');
  });

  it('rejects stale source targets before changing owner state', () => {
    const pair = defineRelationship({
      sourceName: 'AtomicSource',
      sourceField: 'target',
      targetName: 'AtomicTargets',
      targetField: 'sources',
    });
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: pair.source, data: { target } }).unwrap();
    const stale = world.spawn().unwrap();
    world.despawn(stale).unwrap();
    const beforeValue = world.get(source, pair.source).unwrap().target;
    const beforeMirror = Array.from(world.get(target, pair.target).unwrap().sources);
    const beforeMutation = world[worldInternal].getMutationEpoch();
    const beforeRelationship = world[worldInternal].getRelationshipEpoch(pair.source);
    const result = world.set(source, pair.source, { target: stale });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('stale-entity');
    expect(world.get(source, pair.source).unwrap().target).toBe(beforeValue);
    expect(Array.from(world.get(target, pair.target).unwrap().sources)).toEqual(beforeMirror);
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeMutation);
    expect(world[worldInternal].getRelationshipEpoch(pair.source)).toBe(beforeRelationship);

    const row = world
      .query({ write: [pair.source] })
      .unwrap()
      .at(source);
    if (row === undefined) throw new Error('expected source row after stale rejection');
    expect(() => {
      row.mut(pair.source).target = stale;
    }).toThrow('stale');
    expect(world.get(source, pair.source).unwrap().target).toBe(beforeValue);
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeMutation);
    expect(world[worldInternal].getRelationshipEpoch(pair.source)).toBe(beforeRelationship);
  });

  it('prepares mirror capacity before source structural mutation on allocation failure', () => {
    const Required = defineComponent('CapacityAtomicRequired', {});
    const pair = defineRelationship({
      sourceName: 'CapacityAtomicSource',
      sourceField: 'target',
      targetName: 'CapacityAtomicTargets',
      targetField: 'sources',
      sourceRequires: [Required],
    });
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn().unwrap();
    const pool = world[worldInternal].getBufferPool();
    const originalAlloc = pool.alloc;
    const beforeMutation = world[worldInternal].getMutationEpoch();
    const beforeStructure = world[worldInternal].getStructureEpoch();
    const beforeRelationship = world[worldInternal].getRelationshipEpoch(pair.source);
    Object.defineProperty(pool, 'alloc', {
      configurable: true,
      value: () => err(new ManagedBufferOutOfBoundsError(4, 0)),
    });
    try {
      const result = world.addComponent(source, { component: pair.source, data: { target } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('managed-buffer-out-of-bounds');
      expect(world.hasComponent(source, pair.source)).toBe(false);
      expect(world.hasComponent(source, Required)).toBe(false);
      expect(world.hasComponent(target, pair.target)).toBe(false);
      expect(world[worldInternal].getMutationEpoch()).toBe(beforeMutation);
      expect(world[worldInternal].getStructureEpoch()).toBe(beforeStructure);
      expect(world[worldInternal].getRelationshipEpoch(pair.source)).toBe(beforeRelationship);
      expect(pool._liveCount()).toBe(0);
    } finally {
      Object.defineProperty(pool, 'alloc', { configurable: true, value: originalAlloc });
    }
  });
});
