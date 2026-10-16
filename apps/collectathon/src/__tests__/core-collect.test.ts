// m3-1 -- core-collect counting closure + GameProgress SSOT unit tests (TDD red
// before m3-3 resources.ts + m3-7 core-collect.ts impl).
//
// The collect system's per-frame body reads the player's CollidingEntities set
// (a runtime physics-tick output) and despawns Cores -- that wiring is exercised
// by human/sandbox runtime. What IS unit-testable -- and what plan-strategy
// AC-13 (pickup) + AC-18 (HUD SSOT single-writer) demand a gate on -- is the
// pure decision logic the system delegates to:
//
//   - createGameProgress(total): the GameProgress SSOT factory (resources.ts)
//   - resolveCollisions(colliding, isCore): which colliding entities are Cores
//   - applyCollect(progress, n): score += n, the SINGLE GameProgress writer
//   - allCollected(progress): score === total gate (drives portal-activate)
//   - tickElapsed(progress, dt): elapsed seconds accumulation
//
// These tests fail until apps/collectathon/src/resources.ts and
// apps/collectathon/src/systems/core-collect.ts export them.

import { describe, expect, it } from 'vitest';
import { allCollected, createGameProgress, tickElapsed } from '../resources';
import { applyCollect, resolveCollisions } from '../systems/core-collect';

describe('createGameProgress (GameProgress SSOT factory, AC-18)', () => {
  it('initializes score=0, total from arg, health=3, elapsed=0', () => {
    const p = createGameProgress(12);
    expect(p.score).toBe(0);
    expect(p.total).toBe(12);
    expect(p.health).toBe(3);
    expect(p.elapsed).toBe(0);
  });

  it('carries the core count as total (level Core count drives the win gate)', () => {
    expect(createGameProgress(0).total).toBe(0);
    expect(createGameProgress(15).total).toBe(15);
  });
});

describe('resolveCollisions (which colliding entities are collectible Cores)', () => {
  // isCore is the caller-supplied predicate (real system: world.get(e, Core).ok).
  it('returns only the entities the Core predicate accepts', () => {
    const colliding = [10, 11, 12, 13];
    const cores = new Set([11, 13]);
    const hits = resolveCollisions(colliding, (e) => cores.has(e));
    expect(hits).toEqual([11, 13]);
  });

  it('returns empty when no colliding entity is a Core (Guardian/other filtered)', () => {
    const hits = resolveCollisions([20, 21], () => false);
    expect(hits).toEqual([]);
  });

  it('returns empty for an empty colliding set', () => {
    expect(resolveCollisions([], () => true)).toEqual([]);
  });

  it('accepts a Uint32Array colliding set (CollidingEntities.entities runtime shape)', () => {
    const colliding = Uint32Array.of(5, 6, 7);
    const cores = new Set([6]);
    expect(resolveCollisions(colliding, (e) => cores.has(e))).toEqual([6]);
  });
});

describe('applyCollect (the SINGLE GameProgress.score writer, AC-18)', () => {
  it('adds n to score and returns the same progress object (in-place SSOT write)', () => {
    const p = createGameProgress(5);
    const out = applyCollect(p, 2);
    expect(out.score).toBe(2);
    expect(out).toBe(p);
  });

  it('is monotonic across calls (each collect increments)', () => {
    const p = createGameProgress(5);
    applyCollect(p, 1);
    applyCollect(p, 1);
    applyCollect(p, 1);
    expect(p.score).toBe(3);
  });

  it('collecting zero Cores leaves score unchanged', () => {
    const p = createGameProgress(5);
    applyCollect(p, 0);
    expect(p.score).toBe(0);
  });

  it('never writes total / health / elapsed (only score is the collect output)', () => {
    const p = createGameProgress(5);
    applyCollect(p, 3);
    expect(p.total).toBe(5);
    expect(p.health).toBe(3);
    expect(p.elapsed).toBe(0);
  });
});

describe('allCollected (score === total win gate, drives portal-activate)', () => {
  it('false while score < total', () => {
    const p = createGameProgress(3);
    applyCollect(p, 2);
    expect(allCollected(p)).toBe(false);
  });

  it('true exactly when score reaches total', () => {
    const p = createGameProgress(3);
    applyCollect(p, 3);
    expect(allCollected(p)).toBe(true);
  });

  it('a zero-Core level is collected from the start (degenerate total=0)', () => {
    expect(allCollected(createGameProgress(0))).toBe(true);
  });
});

describe('tickElapsed (timer seconds accumulation on the SSOT)', () => {
  it('accumulates dt into elapsed seconds', () => {
    const p = createGameProgress(1);
    tickElapsed(p, 0.5);
    tickElapsed(p, 0.25);
    expect(p.elapsed).toBeCloseTo(0.75, 6);
  });

  it('returns the same progress object (in-place SSOT write)', () => {
    const p = createGameProgress(1);
    expect(tickElapsed(p, 0.016)).toBe(p);
  });

  it('a zero dt frame does not advance the timer', () => {
    const p = createGameProgress(1);
    tickElapsed(p, 0);
    expect(p.elapsed).toBe(0);
  });
});
