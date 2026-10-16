import { standardTextureMask } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from '../../assembly/device-feature-admission';
import type { DispatchEntry } from '../../render-system-extract';
import {
  authoredTransparentDepthWrite,
  geometryRenderStateForPass,
  sameOpaqueTemporalDraw,
  variantSetForCoveragePass,
} from '../main-pass-geometry';
import { geometryRenderStateForTopology } from '../main-pass-material';

describe('geometry pass render state', () => {
  it('keeps the main depth authority while admitting equal temporal depth', () => {
    const base = {
      cullMode: 'back' as const,
      depthCompare: 'less' as const,
      depthWriteEnabled: true,
    };

    expect(geometryRenderStateForPass(base, 'temporal')).toMatchObject({
      cullMode: 'back',
      depthCompare: 'less-equal',
      depthWriteEnabled: false,
    });
  });

  it('does not force depth writes for alpha smoke while allowing authored water depth', () => {
    expect(
      authoredTransparentDepthWrite(true, {
        blend: {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
          },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }),
    ).toBe(false);
    expect(
      authoredTransparentDepthWrite(true, {
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
        blend: {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
          },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }),
    ).toBe(true);
  });

  it('does not rewrite the base state for colour passes', () => {
    const base = {
      cullMode: 'none' as const,
      depthCompare: 'less-equal' as const,
      depthWriteEnabled: false,
    };

    expect(geometryRenderStateForPass(base, 'forward')).toBe(base);
  });

  it('keeps expanded lines depth-read-only while accepting their shared plane', () => {
    expect(geometryRenderStateForTopology('line-list', { cullMode: 'none' })).toMatchObject({
      cullMode: 'none',
      depthCompare: 'less-equal',
      depthWriteEnabled: false,
    });
  });

  it.each([
    ['far then near', [0.8, 0.2]],
    ['near then far', [0.2, 0.8]],
  ] as const)('keeps the near fragment visible for %s temporal overlap', (_order, depths) => {
    const state = geometryRenderStateForPass(
      { cullMode: 'back', depthCompare: 'less', depthWriteEnabled: true },
      'temporal',
    );
    if (state === undefined) throw new Error('temporal render state is required');
    const visibleDepth = 0.2;
    const accepted = depths.filter((depth) => {
      if (state.depthCompare === 'less-equal') return depth <= visibleDepth;
      return depth < visibleDepth;
    });

    expect(state.depthWriteEnabled).toBe(false);
    expect(accepted).toEqual([visibleDepth]);
  });
});

describe('Standard transmission sampled-texture admission', () => {
  const mask = (...names: string[]): number =>
    standardTextureMask(names.map((name) => ({ name, type: 'texture2d' as const })));

  it('uses authored transmission presence instead of the canonical reserved schema', () => {
    expect(
      standardTransmissionAdmission(
        { materialShaderId: 'forgeax::default-standard-pbr', paramSnapshot: { alphaCutoff: 0.25 } },
        undefined,
      ),
    ).toBeUndefined();
    expect(
      standardTransmissionAdmission(
        { materialShaderId: 'forgeax::default-standard-pbr', paramSnapshot: { transmission: 0 } },
        undefined,
      ),
    ).toEqual({ kind: 'dedicated' });
    expect(
      standardTransmissionAdmission(
        { materialShaderId: 'custom::standard', paramSnapshot: { transmission: 1 } },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('shares the split scalar-map pairs below the dedicated budget', () => {
    const material = {
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: { transmission: 1 },
      standardTextureMask: mask(
        'baseColorTexture',
        'metallicRoughnessTexture',
        'normalTexture',
        'transmissionTexture',
        'thicknessTexture',
      ),
    } as const;
    expect(standardTransmissionAdmission(material, STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES)).toEqual(
      { kind: 'dedicated' },
    );
    expect(standardTransmissionAdmission(material, 16)).toEqual({ kind: 'shared' });
  });

  it('names every authored map that occupies a shared pair', () => {
    expect(
      standardTransmissionAdmission(
        {
          materialShaderId: 'forgeax::default-standard-pbr',
          paramSnapshot: { transmission: 1 },
          standardTextureMask: mask('metallicTexture', 'alphaTexture', 'transmissionTexture'),
        },
        16,
      ),
    ).toEqual({ kind: 'exceeded', conflicts: ['metallicTexture', 'alphaTexture'] });
  });
});

describe('temporal projection of multipass materials', () => {
  const forward: DispatchEntry = {
    entityIndex: 0,
    materialHandle: 1,
    renderableIndex: 0,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'Forward' },
    renderState: { cullMode: 'back' },
    defines: undefined,
    vertexEntry: 'vs_main',
    fragmentEntry: 'fs_forward',
    materialShaderId: 'forgeax::default-standard-pbr',
    paramSnapshot: undefined,
  };
  const deferred = {
    ...forward,
    passIndex: 1,
    tags: { LightMode: 'Deferred' },
    fragmentEntry: 'fs_gbuffer',
  };
  it('projects identical opaque Forward and Deferred geometry only once', () => {
    expect(sameOpaqueTemporalDraw(forward, deferred)).toBe(true);
    const surface = {
      ...forward,
      materialShaderId: 'generated::surface',
      tags: {
        LightMode: 'Forward',
        SurfaceKind: 'standard',
        SurfaceModule: 'author::surface',
      },
    };
    expect(
      sameOpaqueTemporalDraw(surface, {
        ...surface,
        tags: { ...surface.tags, LightMode: 'Deferred' },
      }),
    ).toBe(true);
    expect(
      sameOpaqueTemporalDraw(surface, {
        ...surface,
        materialShaderId: 'generated::deferred-artifact',
        tags: { ...surface.tags, LightMode: 'Deferred' },
      }),
    ).toBe(true);
    expect(
      sameOpaqueTemporalDraw(surface, {
        ...surface,
        tags: { ...surface.tags, SurfaceModule: 'author::different-coverage' },
      }),
    ).toBe(false);
    const fullCustom = { ...forward, materialShaderId: 'custom::full' };
    expect(sameOpaqueTemporalDraw(fullCustom, fullCustom)).toBe(false);
  });
  it('preserves different shader, culling, stencil and blending semantics', () => {
    expect(sameOpaqueTemporalDraw(forward, { ...deferred, materialShaderId: 'other' })).toBe(false);
    expect(
      sameOpaqueTemporalDraw(forward, { ...deferred, renderState: { cullMode: 'front' } }),
    ).toBe(false);
    expect(sameOpaqueTemporalDraw(forward, { ...deferred, stencilReference: 1 })).toBe(false);
    const blended = {
      ...forward,
      renderState: {
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
    } as const;
    expect(sameOpaqueTemporalDraw(blended, blended)).toBe(false);
    const stencil = {
      ...forward,
      renderState: { stencil: { passOp: 'increment-clamp' } },
    } as const;
    expect(sameOpaqueTemporalDraw(stencil, stencil)).toBe(false);
  });
});

describe('coverage pass variant', () => {
  it('flips a published full definesKey to the coverage variant in place', () => {
    expect(
      variantSetForCoveragePass(
        'CLUSTER_FORWARD_AVAILABLE=false+COVERAGE_ONLY=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true',
        true,
      ),
    ).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+COVERAGE_ONLY=true+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true',
    );
  });

  it('adds the coverage axis to a composed request and leaves color passes alone', () => {
    expect(variantSetForCoveragePass(undefined, true)).toBe('COVERAGE_ONLY=true');
    expect(variantSetForCoveragePass('A=false', true)).toBe('A=false+COVERAGE_ONLY=true');
    expect(variantSetForCoveragePass('COVERAGE_ONLY=true', true)).toBe('COVERAGE_ONLY=true');
    expect(variantSetForCoveragePass('COVERAGE_ONLY=false', false)).toBe('COVERAGE_ONLY=false');
  });
});
