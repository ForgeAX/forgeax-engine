// m4-1 -- win-lose-arbiter pure verdict logic unit tests (TDD red before m4-6
// win-lose-arbiter.ts impl).
//
// The arbiter is the SOLE system that requests Win/Lose transitions, so the
// same-frame mutual-exclusion question (requirements boundary: Win and Lose must
// never both fire in one frame; F-08 setNextState defers a frame, so a single
// authoritative verdict per frame is the design) reduces to ONE pure function:
//
//   arbitrate({ health, score, total, playerOnActivePortal }) -> 'Win' | 'Lose' | null
//
// Priority is Win > Lose (documented in the impl): if the player collects the
// last Core and reaches the active Portal the same frame their health hits 0, the
// run is a Win, not a Lose -- the player completed the objective. arbitrate
// returns at most one verdict, guaranteeing the system calls setNextState once.
//
// These tests fail until apps/collectathon/src/systems/win-lose-arbiter.ts
// exports arbitrate.

import { describe, expect, it } from 'vitest';
import { arbitrate } from '../systems/win-lose-arbiter';

describe('arbitrate (single-verdict Win/Lose mutual exclusion)', () => {
  it('returns null while the run is ongoing (health>0, not all collected)', () => {
    expect(arbitrate({ health: 3, score: 1, total: 12, playerOnActivePortal: false })).toBe(null);
  });

  it('returns Lose when health reaches 0', () => {
    expect(arbitrate({ health: 0, score: 1, total: 12, playerOnActivePortal: false })).toBe('Lose');
  });

  it('treats negative health as Lose (clamped path safety)', () => {
    expect(arbitrate({ health: -1, score: 0, total: 5, playerOnActivePortal: false })).toBe('Lose');
  });

  it('returns Win when all Cores collected AND player on the active Portal', () => {
    expect(arbitrate({ health: 2, score: 12, total: 12, playerOnActivePortal: true })).toBe('Win');
  });

  it('does NOT win on the active Portal until every Core is collected', () => {
    expect(arbitrate({ health: 2, score: 11, total: 12, playerOnActivePortal: true })).toBe(null);
  });

  it('does NOT win when all collected but player not yet on the Portal', () => {
    expect(arbitrate({ health: 2, score: 12, total: 12, playerOnActivePortal: false })).toBe(null);
  });

  it('Win > Lose: completing the objective the same frame health hits 0 is a Win', () => {
    expect(arbitrate({ health: 0, score: 12, total: 12, playerOnActivePortal: true })).toBe('Win');
  });

  it('only Lose fires when objective incomplete and health hits 0 (no double verdict)', () => {
    // score < total so the Win branch is closed -> exactly one verdict (Lose).
    expect(arbitrate({ health: 0, score: 5, total: 12, playerOnActivePortal: true })).toBe('Lose');
  });

  it('degenerate zero-Core level wins on Portal arrival (total=0 always collected)', () => {
    expect(arbitrate({ health: 3, score: 0, total: 0, playerOnActivePortal: true })).toBe('Win');
  });
});
