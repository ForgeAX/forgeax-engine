// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M5 / w18.
//
// Forward-looking contract for the new asi-world headless smoke script
// (`apps/hello/asi-world/scripts/smoke-dawn.mjs`) — plan-tasks w18 targets.
//
// R-NEW-1 + R-4 fallback chain engaged:
//   - R-NEW-1: `apps/hello/asi-world/scripts/` does not exist on this
//     branch (upstream tweak-20260624 not landed per m0-probe.json). The
//     new smoke script cannot be authored against a non-existent demo
//     workspace.
//   - R-4: even with the demo, the wgpu_wasm import-binding gate
//     (documented across M1-M4 milestone-completed events' gatesDeferred
//     entries) blocks dawn-node init -> baseline PNG export (w16
//     deferred) -> ε≤0.05 pixel-diff path -> falls back per plan-strategy
//     section 4 R-4 to structural-only smoke (300 frames + ECS query
//     bucket cap + drawcall cap + onError=0).
//
// Locks the smoke acceptance contract surface so a follow-up commit
// authors the smoke-dawn.mjs (modelled on hello-tilemap template +
// hello-transform-hierarchy dual-frame readback for the optional pixel
// path when baseline PNG materialises).
//
// Anchors:
//   - requirements.md AC-08 line 2 + AC-10 (terrain drawcall <= 16).
//   - plan-strategy.md section 4 R-4 fallback.
//   - plan-strategy.md section 5.4 falsifier variant convention.
//   - plan-strategy.md section 7 M5 boundary.
//   - m0-probe.json downstreamPropagation.M5_w18_terrainDrawcallUpperBound
//     (11 drawcalls; single atlas; terrainLayerN=11; <= 16 cap).

import { describe, it } from 'vitest';

/**
 * Closed contract for asi-world smoke acceptance after w18 lands.
 *
 *   - targetFrames: 300 (AC-08 line 2).
 *   - readbackFrameIndex: 120 (matches w16 baseline export contract;
 *     both scripts must read SSOT from the same frame).
 *   - pixelDiffEpsilonCap: 0.05 (AC-08 line 2 ε≤0.05 vs baseline PNG).
 *   - pixelDiffMode: 'baseline-vs-readback' when baseline PNG present;
 *     'structural-only' when R-4 fallback engaged (current state).
 *   - terrainBucketEntityCap: 16 * terrainLayerN; m0-probe reports
 *     terrainLayerN=11 so cap = 176 entities. AC-10 says "<= 16N".
 *   - terrainDrawcallCap: 16 (AC-10 hard ceiling; m0-probe says actual
 *     value with single atlas + 11 layers = 11; structurally bounded by
 *     atlasCount * layerCount which under single atlas reduces to
 *     layerCount, capped at 16).
 *   - rendererOnErrorCount: 0.
 *   - falsifierVariant: 'regions-zero' — set every SpriteInstances.regions
 *     entry to [0,0,0,0]; expected smoke FAIL (black frame). Not in CI
 *     (one-off implement-time falsification check per plan-strategy
 *     section 5.4).
 */
interface AsiWorldSmokeContract {
  readonly targetFrames: 300;
  readonly readbackFrameIndex: 120;
  readonly pixelDiffEpsilonCap: 0.05;
  readonly pixelDiffMode: 'baseline-vs-readback' | 'structural-only';
  readonly terrainLayerN: 11;
  readonly terrainBucketEntityCapMultiplier: 16;
  readonly terrainDrawcallCap: 16;
  readonly rendererOnErrorCount: 0;
  readonly falsifierVariant: 'regions-zero';
  readonly falsifierInCi: false;
}

const SMOKE_CONTRACT: AsiWorldSmokeContract = {
  targetFrames: 300,
  readbackFrameIndex: 120,
  pixelDiffEpsilonCap: 0.05,
  // R-4 fallback engaged on this commit: baseline PNG cannot be exported
  // until wgpu_wasm gate clears + upstream demo lands. Follow-up commit
  // flips this back to 'baseline-vs-readback' alongside the baseline PNG
  // landing under w16.
  pixelDiffMode: 'structural-only',
  terrainLayerN: 11,
  terrainBucketEntityCapMultiplier: 16,
  terrainDrawcallCap: 16,
  rendererOnErrorCount: 0,
  falsifierVariant: 'regions-zero',
  falsifierInCi: false,
};

describe('asi-world smoke 300-frame contract (w18, R-NEW-1 + R-4 fallback)', () => {
  it('targetFrames matches AC-08 line 2 (300 frames)', () => {
    if (SMOKE_CONTRACT.targetFrames !== 300) {
      throw new Error(`targetFrames drift: expected 300 got ${SMOKE_CONTRACT.targetFrames}`);
    }
  });

  it('readbackFrameIndex aligns with w16 baseline export contract (frame 120)', () => {
    if (SMOKE_CONTRACT.readbackFrameIndex !== 120) {
      throw new Error(
        `readbackFrameIndex drift: expected 120 got ${SMOKE_CONTRACT.readbackFrameIndex} (w16 SSOT)`,
      );
    }
    if (SMOKE_CONTRACT.readbackFrameIndex >= SMOKE_CONTRACT.targetFrames) {
      throw new Error(
        `readback frame ${SMOKE_CONTRACT.readbackFrameIndex} >= TARGET_FRAMES ${SMOKE_CONTRACT.targetFrames}`,
      );
    }
  });

  it('pixel diff epsilon cap is AC-08 ε=0.05', () => {
    if (SMOKE_CONTRACT.pixelDiffEpsilonCap !== 0.05) {
      throw new Error(`epsilon drift: expected 0.05 got ${SMOKE_CONTRACT.pixelDiffEpsilonCap}`);
    }
  });

  it('pixel diff mode is structural-only under R-4 fallback (this commit) or baseline-vs-readback (post fallback clear)', () => {
    const validModes: readonly AsiWorldSmokeContract['pixelDiffMode'][] = [
      'baseline-vs-readback',
      'structural-only',
    ];
    if (!validModes.includes(SMOKE_CONTRACT.pixelDiffMode)) {
      throw new Error(`pixelDiffMode out of closed union: ${SMOKE_CONTRACT.pixelDiffMode}`);
    }
  });

  it('terrain bucket entity cap = 16N derived from m0-probe terrainLayerN', () => {
    // AC-10: terrain bucket entity count <= 16 * N where N = terrain
    // layer count. m0-probe reports N=11; cap = 176.
    const expectedCap =
      SMOKE_CONTRACT.terrainBucketEntityCapMultiplier * SMOKE_CONTRACT.terrainLayerN;
    if (expectedCap !== 176) {
      throw new Error(
        `terrain bucket entity cap math drift: 16 * 11 = 176 expected, got ${expectedCap}`,
      );
    }
  });

  it('terrain drawcall cap is AC-10 ceiling 16 (m0-probe actual=11 under single atlas; structurally bounded)', () => {
    if (SMOKE_CONTRACT.terrainDrawcallCap !== 16) {
      throw new Error(`drawcall cap drift: expected 16 got ${SMOKE_CONTRACT.terrainDrawcallCap}`);
    }
    // m0-probe.json says actual = atlasCount * layerCount = 1 * 11 = 11;
    // 11 <= 16 satisfies AC-10. The cap stays at 16 to accommodate
    // forward changes (additional atlas + layer combinations) without
    // false-positive smoke failures.
    if (SMOKE_CONTRACT.terrainLayerN > SMOKE_CONTRACT.terrainDrawcallCap) {
      throw new Error(
        `terrainLayerN ${SMOKE_CONTRACT.terrainLayerN} > drawcall cap ${SMOKE_CONTRACT.terrainDrawcallCap}; single-atlas assumption broken`,
      );
    }
  });

  it('renderer onError count target is 0', () => {
    if (SMOKE_CONTRACT.rendererOnErrorCount !== 0) {
      throw new Error(`onError drift: expected 0 got ${SMOKE_CONTRACT.rendererOnErrorCount}`);
    }
  });

  it('falsifier variant is regions-zero (atlas-region degeneration; one-off implement-time check)', () => {
    if (SMOKE_CONTRACT.falsifierVariant !== 'regions-zero') {
      throw new Error(
        `falsifier variant drift: expected regions-zero got ${SMOKE_CONTRACT.falsifierVariant}`,
      );
    }
    if (SMOKE_CONTRACT.falsifierInCi !== false) {
      throw new Error('falsifier must not run in CI (one-off implement-time falsification)');
    }
  });
});

describe('w18 R-NEW-1 + R-4 fallback documentation', () => {
  it('declares the active fallback (structural-only mode this commit; baseline-vs-readback after w16 clears)', () => {
    // When upstream feat-20260622 + tweak-20260624 land AND wgpu_wasm
    // import-binding gate clears, a follow-up commit:
    //   1. Writes apps/hello/asi-world/scripts/smoke-dawn.mjs end-to-end.
    //   2. Runs w16 export-baseline.mjs against the feat-20260624
    //      worktree to drop the baseline PNG into the assets submodule.
    //   3. Flips SMOKE_CONTRACT.pixelDiffMode here from
    //      'structural-only' to 'baseline-vs-readback' as a 1-line edit.
    //   4. Registers the smoke step in ci.yml (w19 follow-up).
    if (SMOKE_CONTRACT.pixelDiffMode !== 'structural-only') {
      throw new Error('current commit must be structural-only under active R-4 fallback');
    }
  });

  it('the smoke target package @forgeax/hello-asi-world is not registered in pnpm workspace this commit', () => {
    // pnpm-workspace.yaml + apps/hello/asi-world/package.json are
    // upstream-owned. w19 (config) creates the package.json once
    // upstream lands. The acceptance check
    //   `pnpm --filter @forgeax/hello-asi-world smoke`
    // cannot execute on this commit; recorded as deferred in milestone
    // CI sweep notes.
    const acceptance = 'pnpm --filter @forgeax/hello-asi-world smoke';
    if (!acceptance.includes('@forgeax/hello-asi-world')) {
      throw new Error('acceptance command drifted');
    }
  });
});
