import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../motion-blur.wgsl'), 'utf8');

describe('motion-blur.wgsl', () => {
  it('declares the portable raster gather contract', () => {
    expect(source).toContain('@fragment');
    expect(source).toContain('symmetric');
    expect(source).toContain('maxRadiusPixels');
    expect(source).toContain('shutterAngle');
    expect(source).toContain('sampleCount');
    expect(source).toContain('textureSample');
  });

  it('samples scene temporal depth through the portable color path', () => {
    expect(source).toContain('@group(1) @binding(3) var sceneTemporal : texture_2d<f32>');
    expect(source).toContain('textureLoad(sceneTemporal, samplePixel, 0)');
    expect(source).not.toContain('texture_depth_2d');
    expect(source).not.toContain('sceneDepth');
    expect(source).not.toContain('depthSampler');
  });

  it('keeps depth, reactive, reset, and alpha guards in the shader owner', () => {
    expect(source).toContain('reactive');
    expect(source).toContain('invalidDepth');
    expect(source).toContain('depthReject');
    expect(source).toContain('reset');
    expect(source).toContain('centerColor.a');
    expect(source).toContain('#import forgeax_scene_temporal::{unpackSceneTemporalV1}');
    expect(source).toContain('let uncovered = max(f32(supportCount) - weight, 0.0)');
    expect(source).toContain('const EDGE_FILL_FACTOR : f32 = 0.99;');
    expect(source).toContain('let acceptedColor');
    expect(source).toContain('let acceptedAlpha');
    expect(source).toContain('let emptyReceiver');
    expect(source).toContain('let sourceScale');
    expect(source).toContain('let sourceContribution');
    expect(source).toContain('let trailScale');
    expect(source).toContain('let outputAlpha');
    expect(source).toContain(
      '(sourceContribution + centerColor.rgb + trailContribution) / max(f32(count), 1.0)',
    );
    expect(source).not.toContain('centerReactive >= 1.0');
    expect(source).not.toContain('1.0 - reactive');
    expect(source).toContain('for (var index = 0u; index < 16u; index += 1u)');
    expect(source).not.toContain('positiveUv');
    expect(source).not.toContain('negativeUv');
  });

  it('keeps the symmetric support exact and the color budget bounded', () => {
    expect(source).toContain('2.0 * (f32(index) + 0.5) / denominator - 1.0');
    expect(source).toContain('RASTER_CANDIDATE_COUNT');
    expect(source).toContain('rasterCandidateOffset');
    expect(source).not.toContain('CANDIDATE_OFFSETS');
    expect(source).not.toContain('maxRadiusPixels * 0.25');
    expect(source).not.toContain('signedIndex');
    expect(source).not.toContain('let centerIndex = params.sampleCount / 2u');
    expect(source).not.toContain('if (index == centerIndex)');
    expect(source).toContain('!candidate.motionValid');
    expect(source).toContain('sampleTemporal.motionValid');
    expect(source).toContain(
      'sampleTemporal.motionUv * vec2<f32>(colorDimensions) * params.exposureScale',
    );
    expect(source).toContain('let supportCount = max(count - 1u, 1u)');
    expect(source).toContain(
      'let primaryCount = select(supportCount, max(supportCount / 2u, 1u), hasSecondary)',
    );
    expect(source).toContain('let secondaryCount = max(supportCount - primaryCount, 1u)');
  });

  it('does not introduce compute, storage, or temporal history writes', () => {
    expect(source).not.toContain('@compute');
    expect(source).not.toContain('var<storage');
    expect(source).not.toContain('history');
    expect(source).not.toContain('atomic');
  });
});
