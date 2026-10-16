// smoke-counterexamples.test - TDD red-phase counter-example battery
// (w4 / plan-strategy section 4.1 + section 2 D-P4 pixelSamples shape
// convergence to ndcCenter/corner per hello-cube smoke alignment).
//
// Counter-examples (each MUST be verified FAIL in the TDD red phase):
//   (i)   force backend=webgl2 -> smoke must FAIL (AC-03 (a) strict criterion
//         backend === 'webgpu')
//   (ii)  clear-only with no draw (drawTriangle returns early, skipping
//         pass.draw) -> smoke must FAIL (AC-03 (c) NDC-center sample =
//         clearColor)
//   (iii) reproduce the fix-f8 silent return (webgpu-backend.ts:124-128:
//         deliberately add the catch return back + throw inside configure)
//         -> smoke must FAIL (core counter-example: silence is no longer
//         swallowed)
//   (iv)  pixelSamples.ndcCenter equals clearColor (criterion (c) FAIL,
//         mirrors hello-cube smoke criterion (c) NDC-center distance
//         threshold; D-P4 shape convergence)
//
// At w4 commit time smoke-criteria.mjs still consumes the OLD pixelSamples
// shape (triangleCenter / canvasCenter / triangleOutside); evaluating these
// fixtures with the NEW shape (ndcCenter / corner) -> criterion (c) reads
// pixelSamples.triangleCenter -> undefined -> NaN distance -> tests fail
// in red phase. After w5 updates smoke-criteria.mjs to consume the new
// shape -> tests turn green.
//
// Test shape: treat the `evaluateSmokeCriteria` function as a contract
// (Contract Test). The test file is the spec for w5.
//
// References: requirements AC-03 (c) counter-example battery (i)(ii)(iii) +
//             AC-04 (d) fix-f8 reproduction linkage; plan-strategy section
//             4.1 counter-example battery + section 2 D-P4 pixelSamples
//             shape convergence; research section F-S5 hello-cube smoke
//             shape SSOT precedent.

import { describe, expect, it } from 'vitest';

/**
 * Counter-example fixture shape (input contract for evaluateSmokeCriteria
 * after w5 updates smoke-criteria.mjs to consume the D-P4 ndcCenter/corner
 * shape):
 *
 * - `backendLine`: console-matched `[hello-triangle] backend=...` string
 *                  value ('webgpu' / 'webgl2' / null)
 * - `framesObserved`: raf frame count (default N=60, overridable via
 *                     ENV `SMOKE_MIN_FRAMES`)
 * - `pixelSamples`: RGB triplets at 2 sample sites (NDC center / a corner
 *                   point outside any drawn primitive); shape mirrors
 *                   hello-cube smoke (D-P4 SSOT convergence).
 *
 * Three-part criteria (smoke-criteria.mjs SSOT after w5):
 * (a) `backend === 'webgpu'`
 * (b) `framesObserved >= SMOKE_MIN_FRAMES`
 * (c) NDC-center RGB distance to clearColor [0.06, 0.06, 0.08]
 *     > SMOKE_PIXEL_THRESHOLD (0.05)
 */
interface SmokeCriteriaInput {
  backendLine: 'webgpu' | 'webgl2' | null;
  framesObserved: number;
  pixelSamples: {
    ndcCenter: readonly [number, number, number];
    corner: readonly [number, number, number];
  };
}

interface SmokeCriteriaResult {
  pass: boolean;
  reason: string;
}

/**
 * Counter-example (i): backend forced to webgl2 (AC-03 (a) strict criterion
 * backend === 'webgpu'). Triangle renders normally but the backend is not
 * WebGPU - smoke MUST FAIL (charter proposition 4 explicit failure).
 */
const COUNTEREXAMPLE_I: SmokeCriteriaInput = {
  backendLine: 'webgl2',
  framesObserved: 350,
  pixelSamples: {
    ndcCenter: [0.42, 0.31, 0.18], // assume triangle drawn (not clearColor)
    corner: [0.06, 0.06, 0.08],
  },
};

/**
 * Counter-example (ii): clear-only, no draw (drawTriangle returns early,
 * skipping pass.draw). The NDC-center sample == clearColor [0.06, 0.06,
 * 0.08] -> distance 0 < threshold 0.05 -> smoke FAILs.
 */
const COUNTEREXAMPLE_II: SmokeCriteriaInput = {
  backendLine: 'webgpu',
  framesObserved: 350,
  pixelSamples: {
    ndcCenter: [0.06, 0.06, 0.08], // all clearColor - triangle not drawn
    corner: [0.06, 0.06, 0.08],
  },
};

/**
 * Counter-example (iii): reproduce the fix-f8 silent return (webgpu-backend.ts:
 * 124-128 silent return + a throw inside configure). The configure catch's
 * silent return makes the whole frame write no pixels -> NDC-center sample
 * = clearColor -> smoke FAILs (same observable signature as counter-example
 * (ii) but with a different root cause).
 *
 * Core counter-example: this confirms that after the silent-skip fix (K-9
 * fan-out dual channel) silence is no longer swallowed.
 */
const COUNTEREXAMPLE_III: SmokeCriteriaInput = {
  backendLine: 'webgpu',
  framesObserved: 350,
  pixelSamples: {
    ndcCenter: [0.06, 0.06, 0.08], // silent skip -> all clearColor
    corner: [0.06, 0.06, 0.08],
  },
};

/**
 * Counter-example (iv): NDC-center sample equals clearColor (D-P4 shape
 * convergence; mirrors hello-cube smoke criterion (c) NDC-center distance
 * threshold). Distinguished from (ii)/(iii) by being a pure shape-coverage
 * fixture: it asserts the NEW pixelSamples key surface is consumed by
 * evaluateSmokeCriteria criterion (c).
 */
const COUNTEREXAMPLE_IV: SmokeCriteriaInput = {
  backendLine: 'webgpu',
  framesObserved: 350,
  pixelSamples: {
    ndcCenter: [0.06, 0.06, 0.08], // NDC center == clearColor exactly
    corner: [0.5, 0.5, 0.5],
  },
};

/**
 * Normal-path fixture: all three criteria PASS (backend webgpu + frames >= 60
 * + NDC-center distance to clearColor > threshold) - smoke MUST PASS
 * (reference stance).
 */
const NORMAL_PASS: SmokeCriteriaInput = {
  backendLine: 'webgpu',
  framesObserved: 350,
  pixelSamples: {
    ndcCenter: [0.95, 0.45, 0.25], // triangle drawn (far from clearColor)
    corner: [0.06, 0.06, 0.08], // canvas corner is clearColor
  },
};

/**
 * Today (at w4 commit time): smoke-criteria.mjs still consumes the OLD
 * pixelSamples shape (triangleCenter/canvasCenter/triangleOutside). Feeding
 * the NEW-shape fixtures into evaluate -> criterion (c) reads
 * `input.pixelSamples.triangleCenter` -> undefined -> rgbDistance returns
 * NaN -> `dist <= pixelThreshold` is false -> evaluate returns
 * { pass: true, ... } for fixtures that should be FAIL (counter-examples
 * (ii)(iii)(iv)) -> tests turn red. After w5 updates smoke-criteria.mjs
 * to consume the D-P4 shape (ndcCenter/corner) -> tests turn green.
 */
async function tryLoadSmokeCriteria(): Promise<
  ((input: SmokeCriteriaInput) => SmokeCriteriaResult) | null
> {
  try {
    const mod = (await import('../smoke-criteria.mjs')) as {
      evaluateSmokeCriteria?: (input: SmokeCriteriaInput) => SmokeCriteriaResult;
    };
    return typeof mod.evaluateSmokeCriteria === 'function' ? mod.evaluateSmokeCriteria : null;
  } catch {
    return null;
  }
}

describe('smoke counter-example battery (i)(ii)(iii)(iv) - D-P4 shape convergence', () => {
  it('(i) backend forced to webgl2 -> smoke must FAIL (AC-03 (a))', async () => {
    const evaluate = await tryLoadSmokeCriteria();
    expect(evaluate).not.toBeNull();
    if (evaluate) {
      const result = evaluate(COUNTEREXAMPLE_I);
      expect(result.pass).toBe(false);
      expect(result.reason).toMatch(/backend|webgpu/i);
    }
  });

  it('(ii) clear-only, no draw -> smoke must FAIL (AC-03 (c) NDC-center sample = clearColor)', async () => {
    const evaluate = await tryLoadSmokeCriteria();
    expect(evaluate).not.toBeNull();
    if (evaluate) {
      const result = evaluate(COUNTEREXAMPLE_II);
      expect(result.pass).toBe(false);
      expect(result.reason).toMatch(/pixel|clearColor|NDC|ndc/i);
    }
  });

  it('(iii) fix-f8 silent return reproduction -> smoke must FAIL (core counter-example)', async () => {
    const evaluate = await tryLoadSmokeCriteria();
    expect(evaluate).not.toBeNull();
    if (evaluate) {
      const result = evaluate(COUNTEREXAMPLE_III);
      expect(result.pass).toBe(false);
      // Core counter-example: silence is no longer swallowed - surfaces as
      // pixel readback FAIL (same observable signature as (ii)).
      expect(result.reason).toMatch(/pixel|clearColor|NDC|ndc/i);
    }
  });

  it('(iv) NDC-center == clearColor -> criterion (c) FAIL (D-P4 shape convergence)', async () => {
    const evaluate = await tryLoadSmokeCriteria();
    expect(evaluate).not.toBeNull();
    if (evaluate) {
      const result = evaluate(COUNTEREXAMPLE_IV);
      expect(result.pass).toBe(false);
      expect(result.reason).toMatch(/pixel|clearColor|NDC|ndc/i);
    }
  });

  it('normal path PASS -> smoke must PASS (reference stance)', async () => {
    const evaluate = await tryLoadSmokeCriteria();
    expect(evaluate).not.toBeNull();
    if (evaluate) {
      const result = evaluate(NORMAL_PASS);
      expect(result.pass).toBe(true);
    }
  });
});
