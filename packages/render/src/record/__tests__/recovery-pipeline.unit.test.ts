import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { standardTextureMask } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { makeZeroCameraFallbackSnapshot, type ValidatedRenderable } from '../frame-snapshot';
import { prepareRecoveryPipelineReadiness } from '../recovery-pipeline';
import type { PipelineState, RenderSystemInternals } from '../render-context';

function probeRenderable(probe: boolean): ValidatedRenderable {
  const material = {
    baseColor: [1, 1, 1],
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-standard-pbr',
  } as never;
  return {
    source: {
      material,
      materials: [material],
      ...(probe ? { probeBlendRecord: {} } : {}),
    },
    mesh: {
      layoutProjection: deriveVertexLayoutProjection({
        position: new Float32Array(0),
        normal: new Float32Array(0),
        uv: new Float32Array(0),
        tangent: new Float32Array(0),
      }),
      indexFormat: 'uint32',
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
    },
  } as never;
}

function recoveryReadinessFor(
  renderable: ValidatedRenderable,
  reflectionFallbackAvailable = false,
  maxSampledTexturesPerShaderStage = 16,
) {
  const pipeline = {} as never;
  const internals = {
    device: {
      caps: { backendKind: 'webgpu', storageBuffer: true },
      limits: { maxSampledTexturesPerShaderStage },
    },
    getMaterialShaderPipelineEntry: (..._args: unknown[]) => ({
      pipeline,
      group2Contract: 'cluster' as const,
    }),
  } as unknown as RenderSystemInternals;
  const pipelineState = {
    colorAttachmentFormat: 'bgra8unorm',
  } as unknown as PipelineState;
  return prepareRecoveryPipelineReadiness({
    internals,
    pipelineState,
    camera: makeZeroCameraFallbackSnapshot(),
    standardLighting: { kind: 'no-local-lights' } as never,
    validated: [renderable],
    dispatch: [],
    shadowCastersActive: false,
    splitLdrSprite: false,
    reflectionFallbackAvailable,
  });
}

describe('recovery prepared pipeline cache', () => {
  it.each([
    { limit: 16, transmission: 1, conflict: false, admitted: true },
    { limit: 21, transmission: 1, conflict: true, admitted: true },
    { limit: 16, transmission: 1, conflict: true, admitted: false },
    { limit: 16, transmission: undefined, conflict: false, admitted: false },
    { limit: 16, transmission: 0, conflict: false, admitted: true },
  ])('prepares the admitted transmission lane: %j', ({
    limit,
    transmission,
    conflict,
    admitted,
  }) => {
    const renderable = probeRenderable(false);
    const material = {
      ...renderable.source.material,
      paramSnapshot: transmission === undefined ? {} : { transmission },
      standardTextureMask: standardTextureMask(
        conflict ? [{ name: 'metallicTexture', type: 'texture2d' }] : [],
      ),
    };
    const readiness = recoveryReadinessFor(
      { ...renderable, source: { ...renderable.source, material, materials: [material] } },
      false,
      limit,
    );
    expect(readiness.pipelineSpecs).toHaveLength(1);
    expect(
      readiness.pipelineSpecs[0]?.shader.variantSet?.includes('TRANSMISSION_AVAILABLE=true'),
    ).toBe(admitted);
  });

  it('prepares the probe-enabled Standard PBR variant used by the live record path', () => {
    const readiness = recoveryReadinessFor(probeRenderable(true));
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).toContain('PROBE_BLEND_AVAILABLE=true');
  });

  it('does not add the probe ABI to a Standard PBR renderable without a record', () => {
    const readiness = recoveryReadinessFor(probeRenderable(false));
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).not.toContain('PROBE_BLEND_AVAILABLE=true');
  });

  it('prepares the Standard PBR reflection fallback MRT variant', () => {
    const readiness = recoveryReadinessFor(probeRenderable(false), true);
    const standardPbr = readiness.pipelineSpecs.find(
      (spec) => spec.shader.id === 'forgeax::default-standard-pbr',
    );

    expect(standardPbr?.shader.variantSet).toContain('REFLECTION_FALLBACK_AVAILABLE=true');
    expect(standardPbr?.attachments.colorFormats).toEqual(['rgba16float', 'rgba16float']);
  });
});
