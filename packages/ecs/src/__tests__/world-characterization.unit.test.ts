import { Update } from '../schedule-token';
// M1 w1: World facade characterization tests.
//
// These tests lock all public World method behaviors so the M1 extraction
// (w2-w5) can proceed with a behavioral baseline. Every test must pass
// identically before and after the refactor.
//
// Coverage: spawn, despawn, get, set, addComponent, removeComponent, update,
// resources, inspection, addSystem, and addSystems.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { defineSystemSet } from '../schedule';
import { World } from '../world';

// ── shared test components ──

const Position = defineComponent('W1Position', { x: 'f32', y: 'f32' });
const Velocity = defineComponent('W1Velocity', { vx: 'f32', vy: 'f32' });

// ──────────────────────────────────────────────────────────────────────
// spawn
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: spawn characterization', () => {
  it('spawns a single-component entity', () => {
    const w = new World();
    const r = w.spawn({ component: Position, data: { x: 1, y: 2 } });
    expect(r.ok).toBe(true);
    const e = r.unwrap();
    const pos = w.get(e, Position).unwrap();
    expect(pos.x).toBe(1);
    expect(pos.y).toBe(2);
  });

  it('spawns a multi-component entity', () => {
    const w = new World();
    const r = w.spawn(
      { component: Position, data: { x: 0, y: 0 } },
      { component: Velocity, data: { vx: 1, vy: 2 } },
    );
    expect(r.ok).toBe(true);
    const e = r.unwrap();
    const pos = w.get(e, Position).unwrap();
    const vel = w.get(e, Velocity).unwrap();
    expect(pos.x).toBe(0);
    expect(vel.vx).toBe(1);
  });

  it('spawn applies defaults for missing fields', () => {
    const w = new World();
    const r = w.spawn({ component: Position, data: {} });
    expect(r.ok).toBe(true);
    const e = r.unwrap();
    const pos = w.get(e, Position).unwrap();
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it('spawn returns unique entity handles', () => {
    const w = new World();
    const e1 = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const e2 = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    expect(e1).not.toBe(e2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// despawn
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: despawn characterization', () => {
  it('despawns an entity and makes get return stale-entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.despawn(e);
    expect(r.ok).toBe(true);
    const gr = w.get(e, Position);
    expect(gr.ok).toBe(false);
    if (!gr.ok) expect(gr.error.code).toBe('stale-entity');
  });

  it('despawn is idempotent on stale handles', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    w.despawn(e).unwrap();
    const r = w.despawn(e);
    expect(r.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// get
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: get characterization', () => {
  it('get returns component data for a live entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 3, y: 4 } }).unwrap();
    const r = w.get(e, Position);
    expect(r.ok).toBe(true);
    expect(r.unwrap().x).toBe(3);
    expect(r.unwrap().y).toBe(4);
  });

  it('get returns component-not-present for missing component', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.get(e, Velocity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('component-not-present');
  });

  it('get returns stale-entity for dead entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    w.despawn(e).unwrap();
    const r = w.get(e, Position);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('stale-entity');
  });

  it('get returns the Entity self-handle', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const ent = w.get(e, Entity).unwrap();
    expect(ent.self).toBe(e);
  });
});

// ──────────────────────────────────────────────────────────────────────
// set
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: set characterization', () => {
  it('set updates component fields on a live entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.set(e, Position, { x: 10 });
    expect(r.ok).toBe(true);
    const pos = w.get(e, Position).unwrap();
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(0);
  });

  it('set returns component-not-present for missing component', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.set(e, Velocity, { vx: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('component-not-present');
  });

  it('set returns stale-entity for dead entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    w.despawn(e).unwrap();
    const r = w.set(e, Position, { x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('stale-entity');
  });
});

// ──────────────────────────────────────────────────────────────────────
// addComponent / removeComponent
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: addComponent / removeComponent characterization', () => {
  it('addComponent adds a component to an existing entity', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.addComponent(e, { component: Velocity, data: { vx: 1, vy: 2 } });
    expect(r.ok).toBe(true);
    const vel = w.get(e, Velocity).unwrap();
    expect(vel.vx).toBe(1);
  });

  it('addComponent returns component-already-present for duplicate', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.addComponent(e, { component: Position, data: { x: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('component-already-present');
  });

  it('removeComponent removes a component from an entity', () => {
    const w = new World();
    const e = w
      .spawn(
        { component: Position, data: { x: 0, y: 0 } },
        { component: Velocity, data: { vx: 1, vy: 2 } },
      )
      .unwrap();
    const r = w.removeComponent(e, Position);
    expect(r.ok).toBe(true);
    const gr = w.get(e, Position);
    expect(gr.ok).toBe(false);
    if (!gr.ok) expect(gr.error.code).toBe('component-not-present');
    const vel = w.get(e, Velocity).unwrap();
    expect(vel.vx).toBe(1);
  });

  it('removeComponent returns component-not-present for missing component', () => {
    const w = new World();
    const e = w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = w.removeComponent(e, Velocity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('component-not-present');
  });
});

// ──────────────────────────────────────────────────────────────────────
// update
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: update characterization', () => {
  it('update runs registered systems', () => {
    const w = new World();
    let called = false;
    w.addSystem(Update, {
      name: 'marker',
      queries: [],
      fn: () => {
        called = true;
      },
    });
    w.update();
    expect(called).toBe(true);
  });

  it('update on empty world completes silently', () => {
    const w = new World();
    expect(() => w.update()).not.toThrow();
  });

  it('update dispatches deferred commands (spawn via commands)', () => {
    const w = new World();
    let spawnedEntity: EntityHandle | null = null;
    w.addSystem(Update, {
      name: 'spawner',
      queries: [],
      fn: (_world, _results, commands) => {
        const e = commands.spawn({ component: Position, data: { x: 5, y: 5 } });
        spawnedEntity = e as unknown as EntityHandle;
      },
    });
    w.update();
    expect(spawnedEntity).not.toBeNull();
    if (spawnedEntity === null) throw new Error('spawnedEntity was null');
    const pos = w.get(spawnedEntity, Position).unwrap();
    expect(pos.x).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resources
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: resources characterization', () => {
  it('insertResource and getResource round-trip', () => {
    const w = new World();
    w.insertResource('myKey', 42);
    expect(w.hasResource('myKey')).toBe(true);
    expect(w.getResource<number>('myKey')).toBe(42);
  });

  it('hasResource returns false for unknown key', () => {
    const w = new World();
    expect(w.hasResource('nonexistent')).toBe(false);
  });

  it('removeResource deletes a resource', () => {
    const w = new World();
    w.insertResource('myKey', 42);
    w.removeResource('myKey');
    expect(w.hasResource('myKey')).toBe(false);
  });

  it('insertResource overwrites existing resource', () => {
    const w = new World();
    w.insertResource('myKey', 42);
    w.insertResource('myKey', 99);
    expect(w.getResource<number>('myKey')).toBe(99);
  });
});

// ──────────────────────────────────────────────────────────────────────
// inspection
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: inspection characterization', () => {
  it('inspect returns entity count', () => {
    const w = new World();
    expect(w.inspect().entityCount).toBe(0);
    w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    expect(w.inspect().entityCount).toBe(1);
  });

  it('inspect returns system count', () => {
    const w = new World();
    expect(w.inspect().systemCount).toBe(0);
    w.addSystem(Update, { name: 's1', queries: [], fn: () => {} });
    expect(w.inspect().systemCount).toBe(1);
  });

  it('inspect returns resource keys', () => {
    const w = new World();
    // World constructor registers protected Time and FixedTime resources
    const initialKeys = w.inspect().resourceKeys;
    expect(initialKeys).toContain('Time');
    expect(initialKeys).toContain('FixedTime');
    w.insertResource('k1', 1);
    expect(w.inspect().resourceKeys).toContain('k1');
  });

  it('inspect returns active components', () => {
    const w = new World();
    w.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const snap = w.inspect();
    expect(snap.activeComponents).toContain('W1Position');
  });

  it('inspect returns systems with set membership', () => {
    const w = new World();
    const TestSet = defineSystemSet({ name: 'test-set' });
    w.addSystems(Update, TestSet, [{ name: 's1', queries: [], fn: () => {} }]);
    const snap = w.inspect();
    const sys = snap.systems.find((s) => s.name === 's1');
    expect(sys).toBeDefined();
    expect(sys?.sets).toContain('test-set');
  });
});

// ──────────────────────────────────────────────────────────────────────
// addSystem / removeSystem / replaceSystem
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: addSystem / removeSystem / replaceSystem characterization', () => {
  it('addSystem registers a system', () => {
    const w = new World();
    w.addSystem(Update, { name: 'sys1', queries: [], fn: () => {} });
    expect(w.inspect().systemCount).toBe(1);
  });

  it('removeSystem removes a registered system', () => {
    const w = new World();
    w.addSystem(Update, { name: 'sys1', queries: [], fn: () => {} });
    const r = w.removeSystem(Update, 'sys1');
    expect(r.ok).toBe(true);
    expect(w.inspect().systemCount).toBe(0);
  });

  it('removeSystem returns error for unknown system', () => {
    const w = new World();
    const r = w.removeSystem(Update, 'nonexistent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('system-before-unknown');
  });

  it('replaceSystem replaces a system descriptor', () => {
    const w = new World();
    w.addSystem(Update, { name: 'sys1', queries: [], fn: () => {} });
    const r = w.replaceSystem(Update, 'sys1', { name: 'sys1', queries: [], fn: () => {} });
    expect(r.ok).toBe(true);
    expect(w.inspect().systemCount).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// addSystems
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: addSystems characterization', () => {
  it('addSystems registers systems into a set', () => {
    const w = new World();
    const TestSet = defineSystemSet({ name: 'test-set' });
    const r = w.addSystems(Update, TestSet, [
      { name: 's1', queries: [], fn: () => {} },
      { name: 's2', queries: [], fn: () => {} },
    ]);
    expect(r.ok).toBe(true);
    expect(w.inspect().systemCount).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// allocUniqueRef / allocSharedRef
// ──────────────────────────────────────────────────────────────────────

describe('M1 w1: allocUniqueRef / allocSharedRef characterization', () => {
  it('allocUniqueRef returns a unique handle', () => {
    const w = new World();
    const h = w.allocUniqueRef<'Test', number>('Test', 42);
    expect(typeof h).toBe('number');
  });

  it('allocSharedRef returns a shared handle', () => {
    const w = new World();
    const h = w.allocSharedRef<'Test', number>('Test', 42);
    expect(typeof h).toBe('number');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Managed arrays use atomic world.set writes.
// ──────────────────────────────────────────────────────────────────────
