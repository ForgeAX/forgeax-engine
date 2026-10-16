// m3-2 -- portal-activate condition unit tests (TDD red before m3-6 spawn-portal
// + m3-8 portal-activate.ts impl).
//
// The portal-activate system per-frame: (1) flips the Portal's active flag once
// every Core is collected, (2) when active AND the player overlaps the Portal
// sensor, requests setNextState(GameState, 'Win'). The setNextState call + the
// CollidingEntities read are runtime seams (human/sandbox). The pure decision
// logic -- and what AC-16 (win path) + the boundary case "inactive Portal has no
// response" demand a gate on -- is:
//
//   - shouldActivatePortal(progress): score === total gate (same allCollected
//     fact, surfaced as the portal's own decision name for grep locality)
//   - shouldWin(portalActive, playerOnPortal): Win iff active AND arrived
//
// These tests fail until apps/collectathon/src/systems/portal-activate.ts
// exports them.

import { describe, expect, it } from 'vitest';

import { createGameProgress } from '../resources';
import { shouldActivatePortal, shouldWin } from '../systems/portal-activate';

describe('shouldActivatePortal (activate iff every Core collected)', () => {
  it('stays inactive while score < total', () => {
    const p = createGameProgress(3);
    p.score = 2;
    expect(shouldActivatePortal(p)).toBe(false);
  });

  it('activates exactly when score reaches total', () => {
    const p = createGameProgress(3);
    p.score = 3;
    expect(shouldActivatePortal(p)).toBe(true);
  });

  it('a zero-Core level activates the Portal immediately (total=0)', () => {
    expect(shouldActivatePortal(createGameProgress(0))).toBe(true);
  });
});

describe('shouldWin (Win iff Portal active AND player has arrived)', () => {
  it('Win when the Portal is active and the player overlaps it', () => {
    expect(shouldWin(true, true)).toBe(true);
  });

  it('no Win when the player reaches an INACTIVE Portal (boundary case)', () => {
    expect(shouldWin(false, true)).toBe(false);
  });

  it('no Win when the Portal is active but the player has not arrived', () => {
    expect(shouldWin(true, false)).toBe(false);
  });

  it('no Win when neither active nor arrived', () => {
    expect(shouldWin(false, false)).toBe(false);
  });
});
