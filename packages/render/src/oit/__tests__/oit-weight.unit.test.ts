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
import { MaterialResource } from '../../material-resource';
import type { DispatchEntry } from '../../render-system-extract';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
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
      OIT_WEIGHT_NUMERATOR: weight.OIT_WEIGHT_NUMERATOR,
      OIT_WEIGHT_DEPTH_SCALE: weight.OIT_WEIGHT_DEPTH_SCALE,
      OIT_WEIGHT_BIAS: weight.OIT_WEIGHT_BIAS,
      OIT_STORAGE_SCALE: weight.OIT_STORAGE_SCALE,
    };
    expect(Object.fromEntries(declared)).toEqual(reference);
  });

  it('matches the three.js r187 depth weight and its clamp', () => {
    expect(weight.oitDepthWeight(0)).toBeCloseTo(weight.OIT_WEIGHT_MAX, 9);
    expect(weight.oitDepthWeight(1e6)).toBe(weight.OIT_WEIGHT_MIN);
    const near = weight.oitDepthWeight(40);
    const far = weight.oitDepthWeight(80);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeCloseTo(0.03 / ((40 / 200) ** 4 + 1e-5), 6);
  });

  it('accumulates order-independently and composites over the background', () => {
    const fragments: weight.OitFragment[] = [
      { color: [1, 0, 0], alpha: 0.6, viewDepth: 4.5 },
      { color: [0, 1, 0], alpha: 0.5, viewDepth: 5 },
      { color: [0, 0, 1], alpha: 0.4, viewDepth: 5.5 },
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

  it('matches the squared alpha contribution and keeps faint fragments', () => {
    const layer = { color: [1, 1, 1], alpha: 0.0005, viewDepth: 1 } as const;
    const accumulation = weight.oitAccumulation([layer]);
    expect(accumulation.revealage).toBe(1 - layer.alpha);
    const expectedWeight = (0.03 / ((1 / 200) ** 4 + 1e-5)) * (layer.alpha ** 2 / 8);
    expect(accumulation.weight).toBeCloseTo(expectedWeight, 12);
    expect(weight.oitAccumulation([{ ...layer, alpha: 0 }])).toEqual({
      color: [0, 0, 0],
      revealage: 1,
      weight: 0,
    });
    const dense = weight.oitAccumulation(Array(64).fill({ ...layer, color: [2, 2, 2], alpha: 1 }));
    expect(dense.color[0]).toBeLessThan(65504);
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
  let materialFrame = new MaterialFrame(undefined);
  const renderables = [0, 1, 2].map((index) => {
    const material = new MaterialResource({
      ...defaultMaterialSnapshot(index + 1),
      transparent: true,
      renderState: transparent,
    });
    materialFrame = materialFrame.with(material);
    return { materials: [material], material };
  });
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
      renderables,
      materialFrame,
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
        renderables,
        materialFrame,
        dispatch: [],
      });
      expect(resolution.inspection.reason).toBeUndefined();
      expect(resolution.inspection.resolved).toBe(requested);
      expect(resolution.inspection.accumulatedDrawCount).toBe(0);
      expect(resolution.topology).toBeUndefined();
    }
  });

  it('classifies sparse ordered validation rows with reversed, repeated and missing dispatch', () => {
    const sparse: typeof renderables = [];
    for (const index of [2, 7, 40]) {
      const resource = new MaterialResource({
        ...defaultMaterialSnapshot(index + 1),
        transparent: true,
        renderState: transparent,
      });
      materialFrame = materialFrame.with(resource);
      sparse[index] = { materials: [resource], material: resource };
    }
    const resolution = resolveTransparencyView({
      requested: 'weighted-blended',
      rgba16floatRenderable: true,
      renderables: sparse,
      materialFrame,
      dispatch: [
        entry(40, transparent),
        entry(41, transparent),
        entry(7, { blend: ADDITIVE }),
        entry(7, transparent),
        { ...entry(2, transparent), tags: { LightMode: 'ShadowCaster' } },
        entry(0, transparent),
        entry(2, transparent),
      ],
    });
    expect(resolution.inspection.accumulatedDrawCount).toBe(3);
    expect(resolution.inspection.sortedDrawCount).toBe(1);
    expect(resolution.inspection.ineligible['blend-not-eligible']).toBe(1);
    expect(resolution.topology).toEqual({ weightedBlended: true, residual: true });
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
