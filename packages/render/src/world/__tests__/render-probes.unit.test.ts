import { describe, expect, it, vi } from 'vitest';
import type { ReflectionProbeFact } from '../../reflection/projection';
import { RenderReflectionProbe, renderProbesOf } from '../render-probes';
import { createRenderWorld } from '../render-world';

function probe(entityKey: number, priority = 0, worldId = 0): ReflectionProbeFact {
  return {
    worldId,
    entityKey,
    center: [entityKey, 0, 0],
    halfExtents: [1, 1, 1],
    priority,
    intensity: 1,
    resolution: 64,
    revision: 1,
  };
}

function fixture() {
  const world = createRenderWorld();
  const owner = renderProbesOf(world);
  const spies = {
    spawn: vi.spyOn(world, 'spawn'),
    despawn: vi.spyOn(world, 'despawn'),
    set: vi.spyOn(world, 'set'),
  };
  const frame = (facts: readonly ReflectionProbeFact[]) => {
    owner.adopt(facts);
    return owner.rebuild(world.query({ read: [RenderReflectionProbe] }).unwrap());
  };
  const reset = () => {
    for (const spy of Object.values(spies)) spy.mockClear();
  };
  const rows = () => [...world.query({ read: [RenderReflectionProbe] }).unwrap()].length;
  return { frame, spies, reset, rows };
}

describe('RenderProbes', () => {
  it('holds one entity per source probe and sorts the roster by source identity', () => {
    const { frame, rows } = fixture();
    const roster = frame([probe(9, 0, 1), probe(4, 0, 1), probe(7, 0, 0)]);
    expect(rows()).toBe(3);
    expect(roster.facts.map((fact) => `${fact.worldId}:${fact.entityKey}`)).toEqual([
      '0:7',
      '1:4',
      '1:9',
    ]);
  });

  it('writes nothing and keeps the roster on a steady frame', () => {
    const { frame, spies, reset } = fixture();
    const facts = [probe(1), probe(2)];
    const first = frame(facts);
    reset();
    expect(frame(facts)).toBe(first);
    expect(frame([probe(1), probe(2)])).toBe(first);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('edits and removes a probe with one entity operation and moves the revision', () => {
    const { frame, spies, reset, rows } = fixture();
    const first = frame([probe(1), probe(2), probe(3)]);
    reset();
    const edited = frame([probe(1), probe(2, 5), probe(3)]);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
    expect(edited.revision).toBeGreaterThan(first.revision);
    expect(edited.facts[1]?.priority).toBe(5);
    reset();
    const removed = frame([probe(1), probe(3)]);
    expect(spies.despawn).toHaveBeenCalledTimes(1);
    expect(spies.set).not.toHaveBeenCalled();
    expect(rows()).toBe(2);
    expect(removed.facts.map((fact) => fact.entityKey)).toEqual([1, 3]);
    reset();
    frame([probe(1), probe(3), probe(4)]);
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(rows()).toBe(3);
  });

  it('empties the roster when every probe leaves', () => {
    const { frame, rows } = fixture();
    frame([probe(1)]);
    expect(frame([]).facts).toEqual([]);
    expect(rows()).toBe(0);
  });
});
