import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Instances, MeshFilter, MeshRenderer, Visibility } from '../../components';
import { createRenderSourceState, readRenderSourceChanges } from '../render-source';

describe('source render changes', () => {
  function fixture() {
    const world = new World({ assets: new AssetRegistry() });
    const spawn = () =>
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: {} },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
    const entity = spawn();
    world.update(1 / 60).unwrap();
    const source = createRenderSourceState(world);
    source.batch.accept();
    const members = new Set<number>([entity]);
    const observe = () => readRenderSourceChanges(world, source, members);
    return { world, entity, spawn, source, members, observe };
  }

  it('keeps unaccepted content pending and clears it only after acceptance', () => {
    const f = fixture();
    f.world.set(f.entity, MeshRenderer, { preparePipelines: true }).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.observe().changes.content.has(f.entity)).toBe(true);
    const retry = f.observe();
    expect(retry.changes.content.has(f.entity)).toBe(true);
    retry.accept();
    expect(f.observe().changes.content.size).toBe(0);
  });

  it('retires the previous full entity identity when a slot is reused', () => {
    const f = fixture();
    f.world.despawn(f.entity).unwrap();
    const replacement = f.spawn();
    f.world.update(1 / 60).unwrap();
    const { changes } = f.observe();
    expect(replacement).not.toBe(f.entity);
    expect(changes.removed.has(f.entity)).toBe(true);
    expect(changes.content.has(replacement)).toBe(true);
  });

  it('projects a visibility edit through renderable descendants of a non-renderable parent', () => {
    const f = fixture();
    const parent = f.world
      .spawn({ component: Transform, data: {} }, { component: Visibility, data: { state: 1 } })
      .unwrap();
    f.world.addComponent(f.entity, { component: ChildOf, data: { parent } }).unwrap();
    f.world.update(1 / 60).unwrap();
    f.observe().accept();
    f.world.set(parent, Visibility, { state: 0 }).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.observe().changes.content.has(f.entity)).toBe(true);
  });
  it('discards without advancing and rejects reuse of a closed candidate', () => {
    const f = fixture();
    f.world.set(f.entity, MeshRenderer, { preparePipelines: true }).unwrap();
    const discarded = f.observe();
    discarded.discard();
    expect(() => discarded.accept()).toThrow('closed');
    const accepted = f.observe();
    expect(accepted.changes.content.has(f.entity)).toBe(true);
    accepted.accept();
    expect(() => accepted.accept()).toThrow('closed');
    expect(f.observe().changes.changed.size).toBe(0);
  });

  it('rejects source mutation during preparation without losing the pending edits', () => {
    const f = fixture();
    f.world.set(f.entity, MeshRenderer, { preparePipelines: true }).unwrap();
    const stale = f.observe();
    f.world.set(f.entity, MeshRenderer, { preparePipelines: false }).unwrap();
    expect(() => stale.validate()).toThrow();
    expect(() => stale.accept()).toThrow();
    const retry = f.observe();
    expect(retry.changes.content.has(f.entity)).toBe(true);
    retry.accept();
    expect(f.observe().changes.changed.size).toBe(0);
  });

  it('classifies instance value edits separately from retained content', () => {
    const f = fixture();
    f.world
      .addComponent(f.entity, { component: Instances, data: { transforms: new Float32Array(16) } })
      .unwrap();
    f.observe().accept();
    f.world.set(f.entity, Instances, { transforms: new Float32Array(16).fill(1) }).unwrap();
    const candidate = f.observe();
    expect(candidate.changes.changed.has(f.entity)).toBe(true);
    expect(candidate.changes.content.has(f.entity)).toBe(false);
    candidate.accept();
    f.world.removeComponent(f.entity, Instances).unwrap();
    expect(f.observe().changes.content.has(f.entity)).toBe(true);
  });

  it('keeps each consumer cursor independent for the same source', () => {
    const f = fixture();
    const second = createRenderSourceState(f.world);
    second.batch.accept();
    f.world.set(f.entity, MeshRenderer, { preparePipelines: true }).unwrap();
    f.observe().accept();
    expect(f.observe().changes.content.size).toBe(0);
    const candidate = readRenderSourceChanges(f.world, second, f.members);
    expect(candidate.changes.content.has(f.entity)).toBe(true);
    candidate.accept();
    expect(readRenderSourceChanges(f.world, second, f.members).changes.content.size).toBe(0);
  });
});
