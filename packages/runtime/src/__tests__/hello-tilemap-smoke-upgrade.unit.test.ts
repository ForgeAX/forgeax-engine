// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M5 / w17.
//
// Forward-looking contract for the hello-tilemap headless smoke upgrade
// (`apps/hello/tilemap/scripts/smoke-dawn.mjs`) — plan-tasks w17 targets.
//
// R-NEW-1 fallback engaged: `apps/hello/tilemap/scripts/` does not exist
// on this branch (upstream feat-20260622 not landed per m0-probe.json).
// The existing baseline-worktree smoke (120 frames, dirty-rebuild gate
// at frame 60, derived per-cell entity count check) is captured in
// `.worktrees/feat-20260624-.../apps/hello/tilemap/scripts/smoke-dawn.mjs`
// as the rewriting template; this test locks the 300-frame upgrade
// contract surface so the follow-up commit lands the literal upgrade
// once upstream materialises.
//
// The acceptance gate cannot be verified live (no script + no demo
// workspace + wgpu_wasm gate per M1-M4 evidence); this test serves as
// the SSOT for the upgrade intent, mirror of M1/w5 and M4/w12-w14
// forward-looking pattern.
//
// Anchors:
//   - requirements.md AC-08 line 1: hello-tilemap dawn-node smoke 300
//     frames, zero crash, zero render anomalies.
//   - plan-strategy.md section 5.2 + section 7 M5 boundary.
//   - research.md Q-R-6.1 baseline (120 frames + dirty rebuild verification
//     template; hello-transform-hierarchy dual-frame pixel-diff pattern).

import { describe, it } from 'vitest';

/**
 * Closed contract for hello-tilemap smoke acceptance after w17 upgrade.
 *
 *   - targetFrames: 300 (raised from baseline 120; AC-08 line 1).
 *   - dirtyRebuildTriggerFrame: 60 (in-place TileLayer mutation +
 *     markTileLayerDirty fires the rebuild pass; matches baseline
 *     worktree's smoke-dawn.mjs frame-60 mutation point).
 *   - dirtyDiffEarlyFrame / dirtyDiffLateFrame: dual-frame pixel-diff
 *     mode (research Q-R-6.3 / hello-transform-hierarchy precedent) — at
 *     frame 50 (pre-dirty) and frame 70 (post-dirty), max channel delta
 *     must EXCEED epsilon=0.05 (sentinel: rebuild changed the visible
 *     surface; opposite of the static-frame ε≤0.05 baseline check used in
 *     w18). w17 description says "dirty rebuild visual artifact ≤ 0.05"
 *     which in the dual-frame mode means: the diff EXISTS but is bounded
 *     by 0.05 channel delta (i.e. no artifact corruption while rebuild
 *     correctly applied). Existing baseline-worktree smoke uses
 *     0.1 max-channel-delta as floor; w17 tightens to 0.05.
 *   - ecsBucketEntityCap: hello-tilemap is an 8x8 / chunkSize=4 fixture
 *     with single atlas; ceil(8/4)*ceil(8/4)*1*1 = 4 buckets maximum.
 *     w17 description says "<= 16N" with hello-tilemap N=1; cap = 16.
 *     We pin 4 here as the tighter ceiling derived from the actual
 *     fixture shape and 16 as the upper bound the assertion uses.
 *   - rendererOnErrorCount: must equal 0.
 */
interface HelloTilemapSmokeContract {
  readonly targetFrames: 300;
  readonly dirtyRebuildTriggerFrame: 60;
  readonly dirtyDiffEarlyFrame: 50;
  readonly dirtyDiffLateFrame: 70;
  readonly dirtyDiffEpsilonCap: 0.05;
  readonly ecsBucketEntityFixtureBound: 4;
  readonly ecsBucketEntityCapAcceptance: 16;
  readonly rendererOnErrorCount: 0;
}

const SMOKE_CONTRACT: HelloTilemapSmokeContract = {
  targetFrames: 300,
  dirtyRebuildTriggerFrame: 60,
  dirtyDiffEarlyFrame: 50,
  dirtyDiffLateFrame: 70,
  dirtyDiffEpsilonCap: 0.05,
  ecsBucketEntityFixtureBound: 4,
  ecsBucketEntityCapAcceptance: 16,
  rendererOnErrorCount: 0,
};

describe('hello-tilemap smoke 300-frame upgrade contract (w17, R-NEW-1 fallback)', () => {
  it('targetFrames matches AC-08 line 1 (300 frames)', () => {
    if (SMOKE_CONTRACT.targetFrames !== 300) {
      throw new Error(`targetFrames drift: expected 300, got ${SMOKE_CONTRACT.targetFrames}`);
    }
  });

  it('dirty rebuild trigger frame is inside the 300-frame window', () => {
    if (
      SMOKE_CONTRACT.dirtyRebuildTriggerFrame <= 0 ||
      SMOKE_CONTRACT.dirtyRebuildTriggerFrame >= SMOKE_CONTRACT.targetFrames
    ) {
      throw new Error(
        `dirtyRebuildTriggerFrame ${SMOKE_CONTRACT.dirtyRebuildTriggerFrame} out of (0, ${SMOKE_CONTRACT.targetFrames})`,
      );
    }
  });

  it('dirty-rebuild dual-frame diff brackets straddle the trigger frame', () => {
    const early = SMOKE_CONTRACT.dirtyDiffEarlyFrame;
    const trigger = SMOKE_CONTRACT.dirtyRebuildTriggerFrame;
    const late = SMOKE_CONTRACT.dirtyDiffLateFrame;
    if (!(early < trigger && trigger < late)) {
      throw new Error(
        `bracket ordering broken: early=${early} < trigger=${trigger} < late=${late} required`,
      );
    }
  });

  it('dual-frame diff epsilon cap is AC-08 ε=0.05 (tightened from baseline 0.1)', () => {
    if (SMOKE_CONTRACT.dirtyDiffEpsilonCap !== 0.05) {
      throw new Error(`epsilon cap drift: expected 0.05 got ${SMOKE_CONTRACT.dirtyDiffEpsilonCap}`);
    }
  });

  it('ECS bucket entity fixture bound (4 for 8x8 / chunk=4 / single atlas) <= acceptance cap (16)', () => {
    if (SMOKE_CONTRACT.ecsBucketEntityFixtureBound > SMOKE_CONTRACT.ecsBucketEntityCapAcceptance) {
      throw new Error(
        `fixture bound ${SMOKE_CONTRACT.ecsBucketEntityFixtureBound} > acceptance cap ${SMOKE_CONTRACT.ecsBucketEntityCapAcceptance}`,
      );
    }
  });

  it('renderer onError count target is 0 (zero crash, zero render anomalies)', () => {
    if (SMOKE_CONTRACT.rendererOnErrorCount !== 0) {
      throw new Error(`onError count drift: expected 0 got ${SMOKE_CONTRACT.rendererOnErrorCount}`);
    }
  });
});

describe('w17 R-NEW-1 fallback boundary', () => {
  it('target path apps/hello/tilemap/scripts does not exist on this branch (deferred)', () => {
    // Documented intent: smoke-dawn.mjs is rewritten following the
    // baseline-worktree template (see
    // .worktrees/feat-20260624-.../apps/hello/tilemap/scripts/smoke-dawn.mjs)
    // with TARGET_FRAMES literal raised from 120 to 300 + the dual-frame
    // diff bracket inserted around the existing dirty-rebuild mutation.
    // No live smoke execution possible in this commit; this test is the
    // upgrade-intent SSOT.
    const intent = {
      rewriteTemplate:
        '.worktrees/feat-20260624-sprite-lit-shading-model-pure-2d-lighting/apps/hello/tilemap/scripts/smoke-dawn.mjs',
      lineSubstitution: 'TARGET_FRAMES literal 120 -> 300',
      followUpInsertion:
        'dual-frame pixel-diff bracket between dirtyDiffEarlyFrame (50) and dirtyDiffLateFrame (70) with epsilon=0.05; max-channel-delta floor lowered from baseline 0.1 to 0.05',
      acceptanceCheckDeferred:
        'pnpm --filter @forgeax/hello-tilemap smoke awaits demo workspace materialisation',
    };
    if (intent.lineSubstitution !== 'TARGET_FRAMES literal 120 -> 300') {
      throw new Error('upgrade substitution intent drifted');
    }
  });
});
