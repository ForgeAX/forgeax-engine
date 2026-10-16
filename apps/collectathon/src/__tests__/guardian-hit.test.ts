// m4-1 -- guardian-hit pure decision logic + Health SSOT single-writer unit tests
// (TDD red before m4-5 guardian-hit.ts impl).
//
// The guardian-hit system's per-frame body reads the player parent's
// CollidingEntities set (a runtime physics-tick output) -- that wiring is
// exercised by human/sandbox runtime. What IS unit-testable -- and what
// requirements AC-15 (Guardian hit -> Health--) + AC-18 (Health SSOT single
// writer) + the multi-Guardian-same-frame boundary demand a gate on -- is the
// pure decision logic the system delegates to:
//
//   - resolveHits(colliding, isAttackSensor): which colliding entities are
//     Guardian attack-sensor entities currently overlapping the player
//   - applyDamage(progress, n): health -= n, the SINGLE GameProgress.health
//     writer (AC-18). Clamped at 0 (never negative).
//   - admitHits(attackers, invul, nowElapsed): the invulnerability filter --
//     keeps each distinct attacker whose last hit is outside the per-attacker
//     cooldown window, so (a) two DIFFERENT Guardians hitting the same frame both
//     land (multi-Guardian boundary: no hit dropped), while (b) the SAME Guardian
//     re-contacting every frame within the window is suppressed (no per-frame
//     drain on continuous overlap).
//
// These tests fail until apps/collectathon/src/systems/guardian-hit.ts exports
// them.

import { describe, expect, it } from 'vitest';
import { createGameProgress } from '../resources';
import {
  admitHits,
  applyDamage,
  GUARDIAN_INVUL_SECONDS,
  resolveHits,
} from '../systems/guardian-hit';

describe('resolveHits (which colliding entities are Guardian attack sensors)', () => {
  // isAttackSensor is the caller-supplied predicate (real system:
  // world.get(e, GuardianAttack).ok). Mirrors core-collect.resolveCollisions.
  it('returns only the entities the attack-sensor predicate accepts', () => {
    const colliding = [10, 11, 12, 13];
    const sensors = new Set([11, 13]);
    expect(resolveHits(colliding, (e) => sensors.has(e))).toEqual([11, 13]);
  });

  it('returns empty when no colliding entity is a Guardian sensor (Core/other filtered)', () => {
    expect(resolveHits([20, 21], () => false)).toEqual([]);
  });

  it('returns empty for an empty colliding set', () => {
    expect(resolveHits([], () => true)).toEqual([]);
  });

  it('accepts a Uint32Array colliding set (CollidingEntities.entities runtime shape)', () => {
    const colliding = Uint32Array.of(5, 6, 7);
    const sensors = new Set([6, 7]);
    expect(resolveHits(colliding, (e) => sensors.has(e))).toEqual([6, 7]);
  });
});

describe('applyDamage (the SINGLE GameProgress.health writer, AC-18)', () => {
  it('subtracts n from health and returns the same progress object (in-place SSOT write)', () => {
    const p = createGameProgress(5); // health starts at 3
    const out = applyDamage(p, 1);
    expect(out.health).toBe(2);
    expect(out).toBe(p);
  });

  it('accumulates across calls (each hit decrements)', () => {
    const p = createGameProgress(5);
    applyDamage(p, 1);
    applyDamage(p, 1);
    expect(p.health).toBe(1);
  });

  it('clamps health at 0 (never negative even when over-damaged)', () => {
    const p = createGameProgress(5);
    applyDamage(p, 5);
    expect(p.health).toBe(0);
  });

  it('multiple hits in one call subtract the full count (multi-Guardian same-frame)', () => {
    const p = createGameProgress(5);
    applyDamage(p, 2); // two Guardians landed this frame
    expect(p.health).toBe(1);
  });

  it('never writes score / total / elapsed (only health is the hit output)', () => {
    const p = createGameProgress(5);
    applyDamage(p, 1);
    expect(p.score).toBe(0);
    expect(p.total).toBe(5);
    expect(p.elapsed).toBe(0);
  });
});

describe('admitHits (per-attacker invulnerability window, multi-Guardian boundary)', () => {
  it('admits a first-time attacker (no prior hit record)', () => {
    const invul = new Map<number, number>();
    const admitted = admitHits([100], invul, 0);
    expect(admitted).toEqual([100]);
    expect(invul.get(100)).toBe(0);
  });

  it('admits TWO different Guardians the same frame -- no hit dropped (boundary)', () => {
    const invul = new Map<number, number>();
    const admitted = admitHits([100, 200], invul, 1.0);
    expect(admitted.sort()).toEqual([100, 200]);
    expect(invul.get(100)).toBe(1.0);
    expect(invul.get(200)).toBe(1.0);
  });

  it('suppresses the SAME Guardian re-contacting within the invul window', () => {
    const invul = new Map<number, number>();
    admitHits([100], invul, 0); // first hit at t=0
    const second = admitHits([100], invul, GUARDIAN_INVUL_SECONDS / 2); // still inside window
    expect(second).toEqual([]);
    expect(invul.get(100)).toBe(0); // record unchanged (no re-stamp on suppression)
  });

  it('re-admits the same Guardian after the invul window elapses', () => {
    const invul = new Map<number, number>();
    admitHits([100], invul, 0);
    const later = admitHits([100], invul, GUARDIAN_INVUL_SECONDS + 0.01);
    expect(later).toEqual([100]);
    expect(invul.get(100)).toBe(GUARDIAN_INVUL_SECONDS + 0.01); // record re-stamped
  });

  it('within one frame: a fresh Guardian lands while a cooling one is suppressed', () => {
    const invul = new Map<number, number>([[100, 0]]); // 100 hit at t=0, still cooling
    const admitted = admitHits([100, 300], invul, GUARDIAN_INVUL_SECONDS / 2);
    expect(admitted).toEqual([300]); // 100 suppressed, 300 fresh
  });
});
