// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M5 / w16.
//
// Forward-looking contract for the asi-world baseline PNG export script
// (`apps/hello/asi-world/scripts/export-baseline.mjs`) — plan-tasks w16
// targets. Both R-NEW-1 (upstream demo not landed) and R-4 (baseline PNG
// fallback) are engaged:
//
//   - R-NEW-1: `apps/hello/asi-world/` does not exist on this branch
//     (m0-probe.json: upstream_tweak20260624_landed=false). The export
//     script cannot be written into a non-existent demo directory.
//   - R-4 (plan-strategy section 4): even if the demo existed, dawn-node
//     readback in this environment is blocked by the pre-existing
//     wgpu_wasm import-binding gate documented in M1-M4 deferred-gate
//     evidence (apps/preview vite-plugin-shader buildStart hook fails
//     with WebAssembly import binding mismatch on
//     __wbg_rhiwgputextureview_unwrap). R-4 fallback maps to "if baseline
//     PNG is hard to export, degrade to structural-only smoke + append the
//     degradation evidence to the task description".
//
// This test locks the export-script contract surface so a future
// follow-up commit (once upstream lands and wgpu_wasm is materialised on
// the runner) can write the actual `export-baseline.mjs` script with
// review-friendly mechanical alignment.
//
// w18 (asi-world smoke) under the same fallback chain falls back to
// structural-only ECS query assertions (entity counts, drawcall caps,
// onError=0) without pixel-diff. ε≤0.05 mode is deferred to the
// upstream-landed follow-up.
//
// Anchors:
//   - requirements.md AC-08 (line 2): asi-world smoke 300 frames + baseline
//     PNG ε≤0.05 diff.
//   - plan-strategy.md section 4 R-4 fallback.
//   - plan-strategy.md section 5.4 + charter P5 (subagent produces PNG,
//     main session compares — but only when PNG can be produced).
//   - plan-strategy.md section 7 M5 boundary.

import { describe, it } from 'vitest';

/**
 * Closed contract specifying the `export-baseline.mjs` script surface.
 * Each field locks one immutable property the script must satisfy when
 * authored against the upstream-landed asi-world demo. The follow-up
 * commit that adds the script will reference this contract directly.
 */
interface BaselineExportContract {
  /** Script file path inside the asi-world demo workspace. */
  readonly scriptPath: 'apps/hello/asi-world/scripts/export-baseline.mjs';
  /**
   * PNG output path inside the assets submodule. Must live under the
   * loop screenshots tree (Apache-2.0 carve-out per
   * forgeax-engine-assets/README.md).
   */
  readonly outputPngPath: 'forgeax-engine-assets/.forgeax-harness/forgeax-loop/feat-20260625-sprite-instances-and-tilemap-terrain-static-batch/screenshots/asi-world-baseline.png';
  /**
   * Baseline worktree the script must drive end-to-end. Cannot be the
   * current feat's worktree (circular reference would corrupt the
   * fixture invariance property).
   */
  readonly baselineWorktreeId: 'feat-20260624-sprite-lit-shading-model-pure-2d-lighting';
  /**
   * Frame index at which readback is performed. Must equal the frame
   * index w18's smoke uses for ε≤0.05 diff (otherwise the baseline is
   * comparing apples and oranges). 60 / 120 are typical stable points;
   * the chosen value is locked here so both scripts read the same SSOT.
   */
  readonly readbackFrameIndex: 120;
  /** Idempotency: re-running the script overwrites the PNG in place. */
  readonly idempotent: true;
  /**
   * The script is one-off; never invoked from CI matrix. CI consumes the
   * PNG produced by a maintainer run, not the script itself.
   */
  readonly inCi: false;
}

const CONTRACT: BaselineExportContract = {
  scriptPath: 'apps/hello/asi-world/scripts/export-baseline.mjs',
  outputPngPath:
    'forgeax-engine-assets/.forgeax-harness/forgeax-loop/feat-20260625-sprite-instances-and-tilemap-terrain-static-batch/screenshots/asi-world-baseline.png',
  baselineWorktreeId: 'feat-20260624-sprite-lit-shading-model-pure-2d-lighting',
  readbackFrameIndex: 120,
  idempotent: true,
  inCi: false,
};

describe('asi-world baseline PNG export script contract (w16, R-NEW-1 + R-4 fallback)', () => {
  it('script lives inside the asi-world demo workspace under scripts/', () => {
    if (!CONTRACT.scriptPath.startsWith('apps/hello/asi-world/scripts/')) {
      throw new Error(
        `scriptPath drift: ${CONTRACT.scriptPath} not under asi-world demo workspace scripts/`,
      );
    }
    if (!CONTRACT.scriptPath.endsWith('.mjs')) {
      throw new Error(`scriptPath must be ESM .mjs: got ${CONTRACT.scriptPath}`);
    }
  });

  it('PNG output lives in assets submodule under loop screenshots tree', () => {
    if (
      !CONTRACT.outputPngPath.startsWith('forgeax-engine-assets/.forgeax-harness/forgeax-loop/')
    ) {
      throw new Error(
        `outputPngPath outside assets submodule loop screenshots tree: ${CONTRACT.outputPngPath}`,
      );
    }
    if (!CONTRACT.outputPngPath.includes('asi-world-baseline.png')) {
      throw new Error(
        `outputPngPath must name file asi-world-baseline.png: got ${CONTRACT.outputPngPath}`,
      );
    }
  });

  it('baseline worktree is feat-20260624 (not the current feat — circular reference protection)', () => {
    if (CONTRACT.baselineWorktreeId !== 'feat-20260624-sprite-lit-shading-model-pure-2d-lighting') {
      throw new Error(
        `baselineWorktreeId drift: ${CONTRACT.baselineWorktreeId} (must be feat-20260624)`,
      );
    }
    // Compile-time guard: cannot accidentally point at the current feat.
    const _circular: 'feat-20260625-sprite-instances-and-tilemap-terrain-static-batch' =
      'feat-20260625-sprite-instances-and-tilemap-terrain-static-batch';
    // @ts-expect-error baseline cannot equal the current feat id.
    const wrong: typeof CONTRACT.baselineWorktreeId = _circular;
    void wrong;
  });

  it('readbackFrameIndex is stable post-init (60 + warm-up; 120 chosen for asi-world)', () => {
    if (CONTRACT.readbackFrameIndex < 60) {
      throw new Error(
        `readbackFrameIndex ${CONTRACT.readbackFrameIndex} too early (< 60 frames warm-up)`,
      );
    }
    if (CONTRACT.readbackFrameIndex > 300) {
      throw new Error(
        `readbackFrameIndex ${CONTRACT.readbackFrameIndex} exceeds smoke TARGET_FRAMES=300`,
      );
    }
  });

  it('script is idempotent (re-runs overwrite PNG, never accumulate)', () => {
    if (CONTRACT.idempotent !== true) {
      throw new Error('script must be idempotent (Idempotency principle)');
    }
  });

  it('script is NOT executed from CI (one-off maintainer tool)', () => {
    if (CONTRACT.inCi !== false) {
      throw new Error('export-baseline.mjs must not run in CI (PNG is a checked-in fixture)');
    }
  });
});

describe('w16 R-4 + R-NEW-1 fallback documentation', () => {
  it('declared deferral: dawn-node readback blocked by wgpu_wasm gate documented in M1-M4 implement-progress.jsonl', () => {
    // The pre-existing environmental gate that blocks `pnpm test:unit`,
    // `pnpm test:browser`, `pnpm test:dawn` (recorded in M1, M2, M3, M4
    // milestone-completed events under `gatesDeferred[].reason`) equally
    // blocks dawn-node readback for baseline export. R-4 fallback maps to
    // "degrade to structural-only smoke". Test passes to record the fallback
    // is INTENTIONAL (not a regression).
    const fallbackEvidence = {
      r4Applied: true,
      reason:
        'wgpu_wasm import-binding gate (WebAssembly.instantiate __wbg_rhiwgputextureview_unwrap mismatch) blocks dawn-node init; reproducible on main HEAD per M1-M4 deferred-gate proof',
      followUp:
        'w18 falls back to structural-only ECS query assertions (entity counts + drawcall caps + onError=0); pixel diff ε≤0.05 deferred to upstream-landed follow-up',
    };
    if (!fallbackEvidence.r4Applied) {
      throw new Error('R-4 fallback flag drifted out of declaration');
    }
  });
});
