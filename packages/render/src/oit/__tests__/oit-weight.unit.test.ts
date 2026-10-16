import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  CameraError,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
  transparencyFromF32,
} from '../../components/camera';
import type { DispatchEntry } from '../../render-system-extract';
import {
  classifyOitDraw,
  OIT_ACCUMULATE_BLEND,
  OIT_INELIGIBLE_REASONS,
  oitAccumulateRenderState,
} from '../eligibility';
import { resolveTransparencyView } from '../view';
import * as weight from '../weight';

const OIT_WGSL = readFileSync(
  fileURLToPath(new URL('../../../../shader/src/oit.wgsl', import.meta.url)),
  'utf8',
);

const STRAIGHT_OVER: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

describe('OIT weight parity', () => {
  it('declares the CPU reference constants in oit.wgsl', () => {
    const declared = new Map<string, number>();
    for (const match of OIT_WGSL.matchAll(/const (OIT_\w+)\s*:\s*f32\s*=\s*([0-9.eE+-]+);/g))
      declared.set(match[1] as string, Number(match[2]));
    const reference: Record<string, number> = {
      OIT_WEIGHT_MIN: weight.OIT_WEIGHT_MIN,
      OIT_WEIGHT_MAX: weight.OIT_WEIGHT_MAX,
      OIT_WEIGHT_SCALE: weight.OIT_WEIGHT_SCALE,
      OIT_WEIGHT_NEAR: weight.OIT_WEIGHT_NEAR,
      OIT_WEIGHT_FAR: weight.OIT_WEIGHT_FAR,
      OIT_WEIGHT_BIAS: weight.OIT_WEIGHT_BIAS,
      OIT_MIN_ALPHA: weight.OIT_MIN_ALPHA,
    };
    expect(Object.fromEntries(declared)).toEqual(reference);
  });

  it('clamps the depth weight and decreases it with distance', () => {
    expect(weight.oitDepthWeight(0)).toBe(weight.OIT_WEIGHT_MAX);
    expect(weight.oitDepthWeight(1e6)).toBe(weight.OIT_WEIGHT_MIN);
    const near = weight.oitDepthWeight(4);
    const far = weight.oitDepthWeight(8);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeCloseTo(10 / (1e-5 + (4 / 5) ** 2 + (4 / 200) ** 6), 6);
  });

  it('accumulates order-independently and composites over the background', () => {
    const fragments: weight.OitFragment[] = [
      { color: [1, 0, 0], alpha: 0.6, viewDistance: 4.5 },
      { color: [0, 1, 0], alpha: 0.5, viewDistance: 5 },
      { color: [0, 0, 1], alpha: 0.4, viewDistance: 5.5 },
    ];
    const forward = weight.oitAccumulation(fragments);
    const reversed = weight.oitAccumulation([...fragments].reverse());
    expect(reversed.revealage).toBeCloseTo(forward.revealage, 12);
    expect(reversed.weight).toBeCloseTo(forward.weight, 12);
    expect(forward.revealage).toBeCloseTo(0.4 * 0.5 * 0.6, 12);
    const composed = weight.oitComposite(fragments, [0.25, 0.25, 0.25]);
    expect(weight.oitComposite([...fragments].reverse(), [0.25, 0.25, 0.25])).toEqual(composed);
    // One layer is exact; the approximation gap appears only with overlap.
    const single = fragments.slice(0, 1);
    const exact = weight.sortedComposite(single, [0.25, 0.25, 0.25]);
    weight.oitComposite(single, [0.25, 0.25, 0.25]).forEach((value, c) => {
      expect(value).toBeCloseTo(exact[c] ?? 0, 6);
    });
  });

  it('ignores fragments below the minimum alpha', () => {
    const accumulation = weight.oitAccumulation([
      { color: [1, 1, 1], alpha: weight.OIT_MIN_ALPHA / 2, viewDistance: 1 },
    ]);
    expect(accumulation).toEqual({ color: [0, 0, 0], revealage: 1, weight: 0 });
  });
});

describe('classifyOitDraw', () => {
  const eligible = (renderState: MaterialRenderState | undefined) =>
    classifyOitDraw({
      materialShaderId: 'forgeax::default-unlit',
      skinned: false,
      renderState,
      fragmentEntry: 'fs_main',
    });

  it('accepts straight and premultiplied over on the built-in programs', () => {
    expect(eligible({ blend: STRAIGHT_OVER })).toEqual({ eligible: true, premultiplied: false });
    expect(eligible({ blend: PREMULTIPLIED_OVER })).toEqual({
      eligible: true,
      premultiplied: true,
    });
    expect(
      classifyOitDraw({
        materialShaderId: undefined,
        skinned: false,
        renderState: { blend: STRAIGHT_OVER },
        fragmentEntry: undefined,
      }),
    ).toEqual({ eligible: true, premultiplied: false });
  });

  it('names every closed ineligible reason', () => {
    const reasons = [
      eligible({ blend: ADDITIVE }),
      eligible(undefined),
      eligible({ blend: STRAIGHT_OVER, depthWriteEnabled: true }),
      classifyOitDraw({
        materialShaderId: 'game::custom',
        skinned: false,
        renderState: { blend: STRAIGHT_OVER },
        fragmentEntry: 'fs_main',
      }),
      classifyOitDraw({
        materialShaderId: 'forgeax::default-unlit',
        skinned: true,
        renderState: { blend: STRAIGHT_OVER },
        fragmentEntry: 'fs_main',
      }),
      classifyOitDraw({
        materialShaderId: 'forgeax::default-unlit',
        skinned: false,
        renderState: { blend: STRAIGHT_OVER },
        fragmentEntry: 'fs_custom',
      }),
    ].map((result) => (result.eligible ? 'eligible' : result.reason));
    expect(reasons).toEqual([
      'blend-not-eligible',
      'blend-not-eligible',
      'depth-write-enabled',
      'program-without-oit-output',
      'program-without-oit-output',
      'program-without-oit-output',
    ]);
    expect(new Set(reasons)).toEqual(new Set(OIT_INELIGIBLE_REASONS));
  });

  it('owns blend, write mask and depth write in the accumulate state', () => {
    const state = oitAccumulateRenderState({
      blend: STRAIGHT_OVER,
      colorWriteMask: 1,
      alphaToCoverageEnabled: true,
      cullMode: 'none',
      depthCompare: 'greater-equal',
    });
    expect(state).toEqual({
      blend: OIT_ACCUMULATE_BLEND,
      depthWriteEnabled: false,
      cullMode: 'none',
      depthCompare: 'greater-equal',
    });
  });
});

describe('resolveTransparencyView', () => {
  const transparent = { blend: STRAIGHT_OVER } as const;
  const material = (handle: number) =>
    ({ materialHandle: handle, passes: [], renderState: transparent }) as never;
  const rows = [0, 1, 2].map((index) => ({
    renderableIndex: index,
    source: { materials: [material(index + 1)], material: material(index + 1) },
  }));
  const entry = (index: number, renderState: MaterialRenderState): DispatchEntry =>
    ({
      renderableIndex: index,
      materialHandle: index + 1,
      tags: { LightMode: 'Forward' },
      renderState,
      materialShaderId: 'forgeax::default-unlit',
      fragmentEntry: 'fs_main',
    }) as unknown as DispatchEntry;

  it('falls back to sorted with the missing capability named', () => {
    const resolution = resolveTransparencyView({
      requested: 'weighted-blended',
      rgba16floatRenderable: false,
      rows,
      dispatch: [entry(0, transparent)],
    });
    expect(resolution.inspection).toEqual({
      requested: 'weighted-blended',
      resolved: 'sorted',
      reason: 'capability-absent',
      capability: 'rgba16floatRenderable',
      accumulatedDrawCount: 0,
      sortedDrawCount: expect.any(Number),
      ineligible: {
        'blend-not-eligible': 0,
        'depth-write-enabled': 0,
        'program-without-oit-output': 0,
      },
    });
    expect(resolution.topology).toBeUndefined();
  });

  it('has no reason and no topology under a sorted request or with no draws', () => {
    for (const requested of ['sorted', 'weighted-blended'] as const) {
      const resolution = resolveTransparencyView({
        requested,
        rgba16floatRenderable: true,
        rows,
        dispatch: [],
      });
      expect(resolution.inspection.reason).toBeUndefined();
      expect(resolution.inspection.resolved).toBe(requested);
      expect(resolution.inspection.accumulatedDrawCount).toBe(0);
      expect(resolution.topology).toBeUndefined();
    }
  });
});

describe('Camera.transparency encoding', () => {
  it('maps the two schema values and rejects any other value', () => {
    expect(transparencyFromF32(TRANSPARENCY_SORTED)).toBe('sorted');
    expect(transparencyFromF32(TRANSPARENCY_WEIGHTED_BLENDED)).toBe('weighted-blended');
    for (const invalid of [2, 0.5, -1, Number.NaN]) {
      let caught: unknown;
      try {
        transparencyFromF32(invalid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CameraError);
      expect(caught).toMatchObject({
        code: 'camera-transparency-invalid',
        detail: { field: 'transparency' },
      });
    }
  });
});
