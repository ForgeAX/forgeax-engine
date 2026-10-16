// M2-T2-TEST + M2-T2: cache key functional equivalence suite.
//
// verifies cacheKeyOf(spec) produces deterministic, collision-free keys across
// 5 representative input tuples covering the call-site diversity in
// createRenderer.ts (standard PBR / unlit / sprite / shadow-caster / strip
// topology with variantSet).
//
// The old materialShaderPipelineCacheKey function is deleted in M2-T2.
// Byte-equiv guarantee is at the PSO descriptor level (M2-T4-TEST, plan D-5),
// not the cache-key string level.

import type {
  MaterialRenderState,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cacheKeyOf, type PipelineSpec } from '../../../render/src/pipeline-spec';

const PROCEDURAL_ATTR_LAYOUT: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

function makeSpec(
  id: string,
  isHdr: boolean,
  renderState?: MaterialRenderState,
  topology?: PrimitiveTopology,
  indexFormat?: 'uint16' | 'uint32',
  variantSet?: string,
  passKind = 'forward',
  sampleCount: 1 | 4 = 1,
): PipelineSpec {
  const colorFormat: GPUTextureFormat = isHdr
    ? ('rgba16float' as unknown as GPUTextureFormat)
    : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
  const depthFormat: GPUTextureFormat = 'depth24plus-stencil8' as unknown as GPUTextureFormat;

  return {
    shader: { id, passKind, variantSet },
    attachments: {
      colorFormats: [colorFormat],
      depthFormat,
      sampleCount,
    },
    geometry: {
      topology: topology ?? 'triangle-list',
      stripIndexFormat: indexFormat,
      vertexLayout: PROCEDURAL_ATTR_LAYOUT,
    },
    renderState,
  };
}

describe('cacheKeyOf 5-input functional equivalence (M2-T2-TEST)', () => {
  it('Case 1: standard PBR LDR forward (sampleCount=1)', () => {
    const spec = makeSpec('forgeax::default-standard-pbr', false, undefined, 'triangle-list');
    const key = cacheKeyOf(spec);

    expect(key).toBeTypeOf('string');
    expect(key.length).toBeGreaterThan(0);

    // Idempotent.
    expect(cacheKeyOf(spec)).toBe(key);

    // HDR variant must differ.
    const specHdr = makeSpec('forgeax::default-standard-pbr', true);
    expect(cacheKeyOf(specHdr)).not.toBe(key);

    // Different shader id must differ.
    const specUnlit = makeSpec('forgeax::default-unlit', false);
    expect(cacheKeyOf(specUnlit)).not.toBe(key);
  });

  it('Case 2: unlit HDR forward MSAA (sampleCount=4)', () => {
    const spec = makeSpec(
      'forgeax::default-unlit',
      true,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'forward',
      4,
    );
    const key = cacheKeyOf(spec);

    expect(key).toBeTypeOf('string');
    expect(key.length).toBeGreaterThan(0);
    expect(cacheKeyOf(spec)).toBe(key);

    // MSAA vs non-MSAA must differ.
    const specNoMsaa = makeSpec(
      'forgeax::default-unlit',
      true,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'forward',
      1,
    );
    expect(cacheKeyOf(specNoMsaa)).not.toBe(key);
  });

  it('Case 3: sprite LDR forward with blend renderState', () => {
    const blendState: MaterialRenderState = {
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      cullMode: 'none',
    };

    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w10:
    // sprite PSO id is now the single `forgeax::sprite` (the double-id
    // `forgeax::default-sprite` boot-time pre-warm path is gone in
    // AC-12 / w14). makeSpec is shader-id-agnostic; the cache-key test
    // still exercises blend / cullMode / msaa axes around the same
    // generic cache key formula.
    const spec = makeSpec('forgeax::sprite', false, blendState, 'triangle-list');
    const key = cacheKeyOf(spec);

    expect(key).toBeTypeOf('string');
    expect(key.length).toBeGreaterThan(0);
    expect(cacheKeyOf(spec)).toBe(key);

    // Different renderState -> different key.
    const specNoBlend = makeSpec('forgeax::sprite', false);
    expect(cacheKeyOf(specNoBlend)).not.toBe(key);

    // Different cullMode -> different key.
    const specBackCull: PipelineSpec = {
      ...makeSpec('forgeax::sprite', false),
      renderState: { cullMode: 'back' },
    };
    expect(cacheKeyOf(specBackCull)).not.toBe(key);
  });

  it('Case 4: shadow-caster pass (depth32float, empty colorFormats)', () => {
    const spec: PipelineSpec = {
      shader: { id: 'forgeax::shadow-caster', passKind: 'shadow-caster', variantSet: undefined },
      attachments: {
        colorFormats: [],
        depthFormat: 'depth32float' as unknown as GPUTextureFormat,
        sampleCount: 1,
      },
      geometry: {
        topology: 'triangle-list',
        vertexLayout: PROCEDURAL_ATTR_LAYOUT,
      },
      renderState: undefined,
    };
    const key = cacheKeyOf(spec);

    expect(key).toBeTypeOf('string');
    expect(key.length).toBeGreaterThan(0);
    expect(cacheKeyOf(spec)).toBe(key);

    // Shadow-caster vs forward with same shader id must differ.
    const fwdSpec: PipelineSpec = {
      ...spec,
      shader: { ...spec.shader, passKind: 'forward' },
      attachments: {
        colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
        depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
        sampleCount: 1,
      },
    };
    expect(cacheKeyOf(fwdSpec)).not.toBe(key);

    // Different depthFormat must differ.
    const altDepthSpec: PipelineSpec = {
      ...spec,
      attachments: {
        ...spec.attachments,
        depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
      },
    };
    expect(cacheKeyOf(altDepthSpec)).not.toBe(key);
  });

  it('Case 5: strip topology with uint32 indexFormat + variantSet', () => {
    const spec = makeSpec(
      'forgeax::default-standard-pbr',
      false,
      undefined,
      'triangle-strip',
      'uint32',
      'SKIN_AVAILABLE=1',
    );
    const key = cacheKeyOf(spec);

    expect(key).toBeTypeOf('string');
    expect(key.length).toBeGreaterThan(0);
    expect(cacheKeyOf(spec)).toBe(key);

    // Different variantSet → different key.
    const specNoVariant = makeSpec(
      'forgeax::default-standard-pbr',
      false,
      undefined,
      'triangle-strip',
      'uint32',
    );
    expect(cacheKeyOf(specNoVariant)).not.toBe(key);

    // Different topology → different key.
    const specTriangleList = makeSpec(
      'forgeax::default-standard-pbr',
      false,
      undefined,
      'triangle-list',
    );
    expect(cacheKeyOf(specTriangleList)).not.toBe(key);

    // Different indexFormat → different key.
    const specU16 = makeSpec(
      'forgeax::default-standard-pbr',
      false,
      undefined,
      'triangle-strip',
      'uint16',
      'SKIN_AVAILABLE=1',
    );
    expect(cacheKeyOf(specU16)).not.toBe(key);
  });
});
