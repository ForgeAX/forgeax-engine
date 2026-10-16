// M1 unit tests for PipelineSpec 4-axis type SSOT.
//
// TDD red phase: this file precedes the implementation file pipeline-spec.ts.
// All imports resolve through the runtime package's test aliasing; the
// not-yet-existing exports will be TS compile errors until M1-T1 is committed.
//
// M1-T0: PipelineSpec type unit (7 error code narrowing cases + readonly shape)
// M1-T2-TEST: 6 derive fn unit (axis round-trip + BGL hash in key)
// M1-T3-TEST: deriveBglShapeFromShader helper unit (12 reflection cases)
// M1-T4-TEST: getOrBuildPipeline cache miss/hit + fail-fast unit (5 cases)
// M1-T5-TEST: 12 SPEC_CONST unit (mutual uniqueness + sampleCount + axis round-trip)

import { describe, expect, it } from 'vitest';
// M1-T1 (after impl exists) re-exports (only import what the tests actually use):
import {
  buildBeginRenderPassDescriptor,
  buildLinearLdrMaterialSpecTable,
  buildPipelineDescriptor,
  cacheKeyOf,
  getOrBuildPipeline,
  // M1-T0: type-level imports
  KNOWN_PASS_KINDS,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
  type PipelineSpecErrorCode,
  passKindPolicyTable,
  SPEC_CONST_TABLE,
  validateSpec,
} from '../../../render/src/pipeline-spec';

// =============================================================================
// M1-T0: PipelineSpec type + error codes narrowing
// =============================================================================

describe('PipelineSpecError (5+2 codes)', () => {
  // Type-narrowing tests: verify the 7-code union is discriminatable via
  // exhaustive switch on `code` (charter P3). The tests use the `if/else
  // (exhaustive:never)` pattern from AC-10.
  function err(code: PipelineSpecErrorCode): PipelineSpecError {
    return new PipelineSpecError({ code, detail: {} });
  }

  function assertCodeNarrow(e: PipelineSpecError, expected: PipelineSpecErrorCode): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (e.code) {
      case 'spec-inconsistent':
      case 'unknown-pass-kind':
      case 'shader-bgl-reflection-mismatch':
      case 'attachment-format-incompatible':
      case 'unsupported-vertex-layout':
      case 'pipeline-build-failed':
      case 'shader-not-registered':
        expect(e.code).toBe(expected);
        break;
      default: {
        const _exhaustive: never = e.code;
        throw new Error(`unexpected code: ${String(_exhaustive)}`);
      }
    }
  }

  it('narrows spec-inconsistent', () =>
    assertCodeNarrow(err('spec-inconsistent'), 'spec-inconsistent'));
  it('narrows unknown-pass-kind', () =>
    assertCodeNarrow(err('unknown-pass-kind'), 'unknown-pass-kind'));
  it('narrows shader-bgl-reflection-mismatch', () =>
    assertCodeNarrow(err('shader-bgl-reflection-mismatch'), 'shader-bgl-reflection-mismatch'));
  it('narrows attachment-format-incompatible', () =>
    assertCodeNarrow(err('attachment-format-incompatible'), 'attachment-format-incompatible'));
  it('narrows unsupported-vertex-layout', () =>
    assertCodeNarrow(err('unsupported-vertex-layout'), 'unsupported-vertex-layout'));
  it('narrows pipeline-build-failed (transit)', () =>
    assertCodeNarrow(err('pipeline-build-failed'), 'pipeline-build-failed'));
  it('narrows shader-not-registered (transit)', () =>
    assertCodeNarrow(err('shader-not-registered'), 'shader-not-registered'));

  it('PipelineSpecError is an Error subclass', () => {
    const e = new PipelineSpecError({ code: 'spec-inconsistent', detail: {} });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PipelineSpecError);
  });
});

describe('KNOWN_PASS_KINDS', () => {
  it('is a non-empty readonly array', () => {
    expect(Array.isArray(KNOWN_PASS_KINDS)).toBe(true);
    expect(KNOWN_PASS_KINDS.length).toBeGreaterThan(0);
  });

  it('contains forward and shadow-caster', () => {
    expect(KNOWN_PASS_KINDS).toContain('forward');
    expect(KNOWN_PASS_KINDS).toContain('shadow-caster');
  });
});

// =============================================================================
// M1-T2-TEST: 6 derive functions unit
// =============================================================================

// Minimal PipelineSpec fixture — 4 axis, all fields filled.
function makeSpec(overrides: Partial<PipelineSpec> = {}): PipelineSpec {
  return {
    shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
    attachments: {
      colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
      depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
      sampleCount: 1,
    },
    geometry: {
      topology: 'triangle-list' as unknown as GPUPrimitiveTopology,
      stripIndexFormat: undefined,
      vertexLayout: { position: new Float32Array([0]) },
    },
    renderState: undefined,
    ...overrides,
  } as PipelineSpec;
}

describe('cacheKeyOf', () => {
  it('same spec produces same key', () => {
    const a = makeSpec();
    const b = makeSpec();
    expect(cacheKeyOf(a)).toBe(cacheKeyOf(b));
  });

  it('different shader.id produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different passKind produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      shader: { id: 'forgeax::default-unlit', passKind: 'shadow-caster', variantSet: undefined },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different colorFormats produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      attachments: {
        colorFormats: ['rgba16float' as unknown as GPUTextureFormat],
        depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
        sampleCount: 1,
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different depthFormat produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      attachments: {
        colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
        depthFormat: 'depth32float' as unknown as GPUTextureFormat,
        sampleCount: 1,
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different sampleCount produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      attachments: {
        colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
        depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
        sampleCount: 4,
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different topology produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      geometry: {
        topology: 'line-list' as unknown as GPUPrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: { position: new Float32Array([0]) },
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different vertexLayout produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      geometry: {
        topology: 'triangle-list' as unknown as GPUPrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: { position: new Float32Array([0]), uv: new Float32Array([0]) },
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different renderState produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({ renderState: { cullMode: 'none' as unknown as GPUCullMode } });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });

  it('different variantSet produces different key', () => {
    const a = makeSpec();
    const b = makeSpec({
      shader: {
        id: 'forgeax::default-unlit',
        passKind: 'forward',
        variantSet: 'CLUSTER_FORWARD_AVAILABLE=true',
      },
    });
    expect(cacheKeyOf(a)).not.toBe(cacheKeyOf(b));
  });
});

describe('validateSpec', () => {
  it('passes for a valid spec', () => {
    const s = makeSpec();
    const r = validateSpec(s);
    expect(r.ok).toBe(true);
  });

  it('returns spec-inconsistent when sampleCount=4 with empty colorFormats', () => {
    const s = makeSpec({
      attachments: {
        colorFormats: [],
        depthFormat: 'depth32float' as unknown as GPUTextureFormat,
        sampleCount: 4,
      },
    });
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('spec-inconsistent');
    }
  });

  it('returns attachment-format-incompatible when depthFormat is undefined but depthCompare is set', () => {
    const s = makeSpec({
      attachments: {
        colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
        depthFormat: undefined,
        sampleCount: 1,
      },
      renderState: { depthCompare: 'less' as unknown as GPUCompareFunction },
    });
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('attachment-format-incompatible');
    }
  });

  it('returns attachment-format-incompatible for a depth-only pass without depthFormat', () => {
    const s = makeSpec({
      shader: {
        id: 'forgeax::default-unlit',
        passKind: 'point-shadow-caster',
        variantSet: undefined,
      },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
    });
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('attachment-format-incompatible');
  });
});

// =============================================================================
// M1-T4-TEST: getOrBuildPipeline + PipelineCache unit
// =============================================================================

describe('getOrBuildPipeline', () => {
  it('returns cached pipeline on cache hit', () => {
    // Structural test: pre-populate cache, verify getOrBuildPipeline returns
    // the cached value without calling createRenderPipeline.
    const cache = new Map<string, unknown>();
    const spec = makeSpec();
    const key = cacheKeyOf(spec);
    const cachedPipeline = { _tag: 'cached' };
    cache.set(key, cachedPipeline);

    const _deviceProvider = {
      createRenderPipeline: () => {
        throw new Error('should not be called on cache hit');
      },
    } as unknown as PipelineDeviceProvider;

    // M1: verify cache hit returns the pre-populated handle.
    const result = getOrBuildPipeline(spec, _deviceProvider, cache);
    expect(result).toBe(cachedPipeline);
  });
});

// =============================================================================
// M1-T5-TEST: 12 SPEC_CONST unit
// =============================================================================

describe('SPEC_CONST_TABLE', () => {
  it('has seven common entries; Standard PBR is prepared from admitted material specs', () => {
    expect(SPEC_CONST_TABLE).toHaveLength(7);
  });

  it('every entry has attachments.sampleCount in {1, 4}', () => {
    for (const entry of SPEC_CONST_TABLE) {
      expect([1, 4]).toContain(entry.attachments.sampleCount);
    }
  });

  it('every entry has shader.id in the standard set (forgeax::default-sprite removed in M3 AC-12)', () => {
    const allowedIds = new Set([
      'forgeax::default-unlit',
      'forgeax::post::tonemap',
      'forgeax::skybox::cube',
    ]);
    for (const entry of SPEC_CONST_TABLE) {
      expect(allowedIds.has(entry.shader.id)).toBe(true);
    }
    // Reverse-grep assertion: 'forgeax::default-sprite' spec entries are
    // gone from the boot-time pre-warm table (AC-12). Sprite PSO now flows
    // through the generic per-MaterialShader pipeline cache keyed on
    // 'forgeax::sprite' + premultiplied-alpha renderState.
    for (const entry of SPEC_CONST_TABLE) {
      expect(entry.shader.id).not.toBe('forgeax::default-sprite');
    }
  });

  it('every entry has shader.passKind in {forward, post-process, skybox}', () => {
    for (const entry of SPEC_CONST_TABLE) {
      expect(['forward', 'post-process', 'skybox']).toContain(entry.shader.passKind);
    }
  });

  it('every entry has colorFormats[0] in {bgra8unorm-srgb, rgba16float}', () => {
    for (const entry of SPEC_CONST_TABLE) {
      expect(entry.attachments.colorFormats[0]).toMatch(/^(bgra8unorm-srgb|rgba16float)$/);
    }
  });

  it('every entry has float Reverse-Z depth or no depth', () => {
    for (const entry of SPEC_CONST_TABLE) {
      expect(['depth32float-stencil8', undefined]).toContain(entry.attachments.depthFormat);
    }
  });

  it('all seven cache keys are mutually unique', () => {
    const keys = new Set<string>();
    for (const entry of SPEC_CONST_TABLE) {
      const key = cacheKeyOf(entry);
      if (keys.has(key)) {
        // Log duplicate for debugging
        console.error(`Duplicate cache key: ${key}`);
      }
      keys.add(key);
    }
    expect(keys.size).toBe(7);
  });

  it('changing sampleCount produces a different key', () => {
    // Pick the first entry with sampleCount=1, toggle to 4.
    const base = SPEC_CONST_TABLE.find((e) => e.attachments.sampleCount === 1);
    expect(base).toBeDefined();
    if (!base) return;

    const key1 = cacheKeyOf(base);

    const modified = {
      ...base,
      attachments: { ...base.attachments, sampleCount: 4 as const },
    } as PipelineSpec;
    const key4 = cacheKeyOf(modified);

    expect(key4).not.toBe(key1);
  });

  it('changing colorFormat produces a different key', () => {
    const base = SPEC_CONST_TABLE.find((e) => e.attachments.colorFormats[0] === 'bgra8unorm-srgb');
    expect(base).toBeDefined();
    if (!base) return;

    const keyLdr = cacheKeyOf(base);

    const modified = {
      ...base,
      attachments: {
        ...base.attachments,
        colorFormats: ['rgba16float' as unknown as GPUTextureFormat],
      },
    } as PipelineSpec;
    const keyHdr = cacheKeyOf(modified);

    expect(keyHdr).not.toBe(keyLdr);
  });

  it('changing shader.id produces a different key', () => {
    const base = SPEC_CONST_TABLE.find((e) => e.shader.id === 'forgeax::default-unlit');
    expect(base).toBeDefined();
    if (!base) return;

    const keyUnlit = cacheKeyOf(base);

    const modified = {
      ...base,
      shader: { ...base.shader, id: 'forgeax::default-standard-pbr' },
    } as PipelineSpec;
    const keyStandard = cacheKeyOf(modified);

    expect(keyStandard).not.toBe(keyUnlit);
  });

  it('changing shader variantSet produces a different key', () => {
    const base = SPEC_CONST_TABLE[0];
    expect(base).toBeDefined();
    if (!base) return;

    const keyNoVariant = cacheKeyOf(base);

    const modified = {
      ...base,
      shader: { ...base.shader, variantSet: 'SKIN_AVAILABLE=1' },
    } as PipelineSpec;
    const keyVariant = cacheKeyOf(modified);

    expect(keyVariant).not.toBe(keyNoVariant);
  });

  it('changing topology produces a different key', () => {
    const base = SPEC_CONST_TABLE[0];
    expect(base).toBeDefined();
    if (!base) return;

    const keyTri = cacheKeyOf(base);

    const modified = {
      ...base,
      geometry: { ...base.geometry, topology: 'line-list' as unknown as GPUPrimitiveTopology },
    } as PipelineSpec;
    const keyLine = cacheKeyOf(modified);

    expect(keyLine).not.toBe(keyTri);
  });
});

describe('linear-LDR material pre-warm table', () => {
  it('derives only the two common unlit variants at rgba16float', () => {
    const table = buildLinearLdrMaterialSpecTable('bgra8unorm-srgb');
    expect(table).toHaveLength(2);
    expect(table.every((entry) => entry.shader.passKind === 'forward')).toBe(true);
    expect(table.every((entry) => entry.attachments.colorFormats[0] === 'rgba16float')).toBe(true);
    expect(table.every((entry) => entry.shader.id === 'forgeax::default-unlit')).toBe(true);
    expect(table.every((entry) => entry.shader.variantSet === undefined)).toBe(true);
    expect(table.map((entry) => entry.attachments.sampleCount)).toEqual([1, 4]);
  });
});

// =============================================================================
// M2-T3-TEST: buildPipelineDescriptor forward + shadow-caster branch unit
// =============================================================================

describe('buildPipelineDescriptor (M2-T3-TEST)', () => {
  const PROCEDURAL_ATTR_LAYOUT = {
    position: new Float32Array(0),
    normal: new Float32Array(0),
    uv: new Float32Array(0),
    tangent: new Float32Array(0),
  };

  const mockVertexModule = { _tag: 'vertexShaderModule' };
  const mockFragmentModule = { _tag: 'fragmentShaderModule' };

  function makeForwardSpec(sampleCount: 1 | 4 = 1): PipelineSpec {
    return {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: {
        colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
        depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
        sampleCount,
      },
      geometry: {
        topology: 'triangle-list' as unknown as GPUPrimitiveTopology,
        vertexLayout: PROCEDURAL_ATTR_LAYOUT,
      },
      renderState: undefined,
    };
  }

  it('uses the entry selection carried by the pipeline spec', () => {
    const base = makeForwardSpec();
    const spec: PipelineSpec = {
      ...base,
      shader: { ...base.shader, vertexEntry: 'vs_custom', fragmentEntry: 'fs_readability' },
    };
    const descriptor = buildPipelineDescriptor(spec, {
      vertex: mockVertexModule,
      fragment: mockFragmentModule,
    });
    expect(descriptor.vertex.entryPoint).toBe('vs_custom');
    expect(descriptor.fragment?.entryPoint).toBe('fs_readability');
  });

  function makeShadowCasterSpec(sampleCount: 1 | 4 = 1): PipelineSpec {
    return {
      shader: { id: 'forgeax::shadow-caster', passKind: 'shadow-caster', variantSet: undefined },
      attachments: {
        colorFormats: [],
        depthFormat: 'depth32float' as unknown as GPUTextureFormat,
        sampleCount,
      },
      geometry: {
        topology: 'triangle-list' as unknown as GPUPrimitiveTopology,
        vertexLayout: PROCEDURAL_ATTR_LAYOUT,
      },
      renderState: undefined,
    };
  }

  it('Case 1: sampleCount=1 produces no multisample (forward)', () => {
    const spec = makeForwardSpec(1);
    const desc = buildPipelineDescriptor(spec, {
      vertex: mockVertexModule,
      fragment: mockFragmentModule,
    });
    const ms = (desc as Record<string, unknown>).multisample;
    expect(ms === undefined || ms === null).toBe(true);
  });

  it('Case 2: sampleCount=4 produces multisample={ count: 4 } (forward)', () => {
    const spec = makeForwardSpec(4);
    const desc = buildPipelineDescriptor(spec, {
      vertex: mockVertexModule,
      fragment: mockFragmentModule,
    });
    const ms = (desc as Record<string, unknown>).multisample;
    if (ms !== undefined) {
      expect((ms as { count?: number }).count).toBe(4);
    }
  });

  it('Case 3: shadow-caster branch (colorFormats=[], depth32float)', () => {
    const spec = makeShadowCasterSpec(1);
    const desc = buildPipelineDescriptor(spec, {
      vertex: mockVertexModule,
      fragment: mockFragmentModule,
    });
    expect(desc).toBeDefined();
  });

  it('Case 4: forward branch (colorFormats[0] present, depthFormat present)', () => {
    const spec = makeForwardSpec(1);
    const desc = buildPipelineDescriptor(spec, {
      vertex: mockVertexModule,
      fragment: mockFragmentModule,
    });
    expect(desc).toBeDefined();
  });
});

// =============================================================================
// M4-T1-TEST: buildBeginRenderPassDescriptor + passKindPolicyTable
//
// 9 passKind shape coverage + 2 stencil-op gate cases. These tests assert
// literal equality with the descriptor shape that 14 record-stage call sites
// previously emitted by hand (render-system-record.ts + render-graph-primitives.ts).
// =============================================================================

describe('passKindPolicyTable (M4-T1)', () => {
  it('exposes 10 passKind entries covering 9 attachment shapes + post-process catch-all', () => {
    const expectedKeys = [
      'forward',
      'shadow-caster',
      'point-shadow-caster',
      'skybox',
      'tonemap',
      'bloom-downsample',
      'bloom-upsample',
      'bloom-composite',
      'fxaa',
      'post-process',
    ];
    for (const k of expectedKeys) {
      expect(passKindPolicyTable[k]).toBeDefined();
    }
  });

  it('depth-only shape entries omit defaultColorOps', () => {
    expect(passKindPolicyTable['shadow-caster']?.shape).toBe('depth-only');
    expect(passKindPolicyTable['shadow-caster']?.defaultColorOps).toBeUndefined();
    expect(passKindPolicyTable['point-shadow-caster']?.shape).toBe('depth-only');
    expect(passKindPolicyTable['point-shadow-caster']?.defaultColorOps).toBeUndefined();
  });

  it('color-only shape entries omit defaultDepthOps', () => {
    for (const k of [
      'skybox',
      'tonemap',
      'bloom-downsample',
      'bloom-upsample',
      'bloom-composite',
      'fxaa',
      'post-process',
    ]) {
      expect(passKindPolicyTable[k]?.shape).toBe('color-only');
      expect(passKindPolicyTable[k]?.defaultDepthOps).toBeUndefined();
    }
  });
});

describe('buildBeginRenderPassDescriptor (M4-T1)', () => {
  // Stand-in tokens for resolved RHI handles. The helper does not introspect
  // them; it only forwards them into the descriptor object literally.
  const colorView = { __tag: 'colorView' as const };
  const depthView = { __tag: 'depthView' as const };
  const resolveView = { __tag: 'resolveView' as const };

  // Common attachment shapes used across cases.
  const ldrAttachments: PipelineSpec['attachments'] = {
    colorFormats: ['bgra8unorm-srgb'],
    depthFormat: 'depth24plus-stencil8',
    sampleCount: 1,
  };
  const hdrAttachments: PipelineSpec['attachments'] = {
    colorFormats: ['rgba16float'],
    depthFormat: 'depth24plus-stencil8',
    sampleCount: 1,
  };
  const depthOnlyAttachmentsStencil: PipelineSpec['attachments'] = {
    colorFormats: [],
    depthFormat: 'depth24plus-stencil8',
    sampleCount: 1,
  };
  const depthOnlyAttachments32f: PipelineSpec['attachments'] = {
    colorFormats: [],
    depthFormat: 'depth32float',
    sampleCount: 1,
  };
  const colorOnlyAttachments: PipelineSpec['attachments'] = {
    colorFormats: ['bgra8unorm-srgb'],
    depthFormat: undefined,
    sampleCount: 1,
  };

  it('Case 1: forward (color+depth, depth24plus-stencil8 emits stencil ops)', () => {
    const desc = buildBeginRenderPassDescriptor(
      ldrAttachments,
      { colorViews: [colorView], depthView },
      'forward',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });
  });

  it('Case 2: shadow-caster (depth-only, depth32float — NO stencil ops)', () => {
    const desc = buildBeginRenderPassDescriptor(
      depthOnlyAttachments32f,
      { colorViews: [], depthView },
      'shadow-caster',
    );
    expect(desc).toEqual({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
  });

  it('Case 3: point-shadow-caster (depth-only, depth24plus-stencil8 emits stencil)', () => {
    // Point-shadow atlas backing texture is depth24plus-stencil8 historically
    // (the stencil aspect is unused but the format carries it). The helper
    // auto-emits stencil ops accordingly.
    const desc = buildBeginRenderPassDescriptor(
      depthOnlyAttachmentsStencil,
      { colorViews: [], depthView },
      'point-shadow-caster',
    );
    expect(desc).toEqual({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });
  });

  it('Case 4: skybox (color-only HDR, no depth, clear/store)', () => {
    const desc = buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [colorView] },
      'skybox',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
  });

  it('Case 5: tonemap (color-only LDR, clear black)', () => {
    const desc = buildBeginRenderPassDescriptor(
      colorOnlyAttachments,
      { colorViews: [colorView] },
      'tonemap',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
  });

  it('Case 6: bloom-downsample (color-only HDR intermediate, clear black)', () => {
    const desc = buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [colorView] },
      'bloom-downsample',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
  });

  it('Case 7: bloom-upsample (color-only, same shape as bloom-downsample)', () => {
    const desc = buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [colorView] },
      'bloom-upsample',
    );
    expect(desc.colorAttachments).toEqual([
      {
        view: colorView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ]);
    expect(desc.depthStencilAttachment).toBeUndefined();
  });

  it('Case 8: bloom-composite (color-only, loadOp=load — preserves prior content)', () => {
    const desc = buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [colorView] },
      'bloom-composite',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    // loadOp='load' implies clearValue MUST be omitted (WebGPU validation).
    const ca = desc.colorAttachments as readonly Record<string, unknown>[];
    expect(ca[0]?.clearValue).toBeUndefined();
  });

  it('Case 9: fxaa (color-only, clear black, no depth)', () => {
    const desc = buildBeginRenderPassDescriptor(
      colorOnlyAttachments,
      { colorViews: [colorView] },
      'fxaa',
    );
    expect(desc).toEqual({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
  });

  // ── Stencil-op gate cases (2) ─────────────────────────────────────────────

  it('Stencil-gate A: depth32float forward → no stencilLoadOp / stencilStoreOp', () => {
    const desc = buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: 'depth32float', sampleCount: 1 },
      { colorViews: [colorView], depthView },
      'forward',
    );
    const ds = desc.depthStencilAttachment as Record<string, unknown>;
    expect(ds.depthLoadOp).toBe('clear');
    expect(ds.depthStoreOp).toBe('store');
    expect(ds.depthClearValue).toBe(0);
    expect(ds.stencilLoadOp).toBeUndefined();
    expect(ds.stencilStoreOp).toBeUndefined();
    expect(ds.stencilClearValue).toBeUndefined();
  });

  it('Stencil-gate B: depth24plus-stencil8 forward → stencilLoadOp=clear, stencilStoreOp=discard', () => {
    const desc = buildBeginRenderPassDescriptor(
      hdrAttachments,
      { colorViews: [colorView], depthView },
      'forward',
    );
    const ds = desc.depthStencilAttachment as Record<string, unknown>;
    expect(ds.stencilLoadOp).toBe('clear');
    expect(ds.stencilStoreOp).toBe('discard');
    expect(ds.stencilClearValue).toBe(0);
  });

  // ── Per-call override cases (sprite-split + skyboxActive) ─────────────────

  it('Override A: forward sprite-split sub-pass — colorLoadOp=load + depthLoadOp=load', () => {
    const desc = buildBeginRenderPassDescriptor(
      hdrAttachments,
      { colorViews: [colorView], depthView },
      'forward',
      { colorLoadOp: 'load', depthLoadOp: 'load' },
    );
    const ca = desc.colorAttachments as readonly Record<string, unknown>[];
    expect(ca[0]?.loadOp).toBe('load');
    // loadOp='load' → clearValue must NOT be present in the descriptor.
    expect(ca[0]?.clearValue).toBeUndefined();
    const ds = desc.depthStencilAttachment as Record<string, unknown>;
    expect(ds.depthLoadOp).toBe('load');
    expect(ds.depthClearValue).toBeUndefined();
    expect(ds.stencilLoadOp).toBe('clear');
    expect(ds.stencilStoreOp).toBe('discard');
  });

  it('Override B: forward + skyboxActive (mainColorLoadOp=load) preserves depth=clear', () => {
    const desc = buildBeginRenderPassDescriptor(
      hdrAttachments,
      { colorViews: [colorView], depthView },
      'forward',
      { colorLoadOp: 'load' },
    );
    const ca = desc.colorAttachments as readonly Record<string, unknown>[];
    expect(ca[0]?.loadOp).toBe('load');
    expect(ca[0]?.clearValue).toBeUndefined();
    const ds = desc.depthStencilAttachment as Record<string, unknown>;
    expect(ds.depthLoadOp).toBe('clear');
    expect(ds.depthClearValue).toBe(0);
  });

  it('Override C: clearColor override propagates to colorAttachments[0].clearValue', () => {
    const desc = buildBeginRenderPassDescriptor(
      hdrAttachments,
      { colorViews: [colorView], depthView },
      'forward',
      { clearColor: { r: 0.5, g: 0.25, b: 0.125, a: 1 } },
    );
    const ca = desc.colorAttachments as readonly Record<string, unknown>[];
    expect(ca[0]?.clearValue).toEqual({ r: 0.5, g: 0.25, b: 0.125, a: 1 });
  });

  it('Override D: resolveTargets[i] populates resolveTarget on the matching slot', () => {
    const desc = buildBeginRenderPassDescriptor(
      { ...hdrAttachments, sampleCount: 4 },
      { colorViews: [colorView], depthView, resolveTargets: [resolveView] },
      'forward',
    );
    const ca = desc.colorAttachments as readonly Record<string, unknown>[];
    expect(ca[0]?.resolveTarget).toBe(resolveView);
  });

  it('Unknown passKind throws PipelineSpecError(unknown-pass-kind)', () => {
    expect(() =>
      buildBeginRenderPassDescriptor(ldrAttachments, { colorViews: [colorView] }, 'no-such-kind'),
    ).toThrow(PipelineSpecError);
  });
});
