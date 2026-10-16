import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DepthOfFieldQualityValue,
  DepthOfFieldSideValue,
} from '../../../components/depth-of-field';
import { depthOfFieldTopology } from '../depth-of-field-feature';
import { projectDepthOfFieldInspection } from '../depth-of-field-inspection';
import {
  DEPTH_OF_FIELD_PARAMS_BYTE_SIZE,
  depthOfFieldQualityCode,
  depthOfFieldRequestFailure,
  depthOfFieldSideCode,
  depthOfFieldTapCount,
  packDepthOfFieldParams,
  resolveDepthOfFieldFrameParams,
  signedDepthOfFieldCoC,
  validateDepthOfFieldFrameParams,
  validateDepthOfFieldParams,
} from '../depth-of-field-params';

const camera = {
  projection: 'perspective' as const,
  fov: (40 * Math.PI) / 180,
  near: 0.1,
  far: 100,
};

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function halfResolutionSourceFactor(radiusPixels: number): number {
  return smoothstep(2, 3, radiusPixels);
}

function fullResolutionSourceFactor(radiusPixels: number): number {
  return smoothstep(0.5, 2, radiusPixels);
}

function radiusMix(radiusPixels: number): { readonly small: number; readonly half: number } {
  const half = halfResolutionSourceFactor(radiusPixels);
  return {
    small: fullResolutionSourceFactor(radiusPixels) * (1 - half),
    half,
  };
}

function circleKernelMean(sourceRadius: number, domainRadius: number): number {
  const sampleRadius = Math.max(domainRadius, 1e-5);
  const kernelRadius = Math.max(sourceRadius + 1, 1e-5);
  if (kernelRadius <= sampleRadius) {
    return Math.max((kernelRadius * kernelRadius) / (3 * sampleRadius * sampleRadius), 1e-5);
  }
  return Math.max(1 - (2 * sampleRadius) / (3 * kernelRadius), 1e-5);
}

function sourceKernelMean(sourceRadius: number, domainRadius = 16, tapCount = 64): number {
  const localCount = Math.max(1, Math.floor(tapCount * 0.25));
  const outerCount = Math.max(tapCount - localCount, 1);
  const localMean = circleKernelMean(sourceRadius, Math.min(domainRadius, 3));
  const outerMean = circleKernelMean(sourceRadius, domainRadius);
  return Math.max((localCount * localMean + outerCount * outerMean) / Math.max(tapCount, 1), 1e-5);
}

function diskOffsetRadius(index: number, count: number, radius: number): number {
  return Math.sqrt((index + 0.5) / Math.max(count, 1)) * radius;
}

function sourceDiskOffsetRadius(index: number, count: number, maxRadius: number): number {
  const localCount = Math.max(1, Math.floor(count * 0.25));
  if (index < localCount) {
    return diskOffsetRadius(index, localCount, Math.min(maxRadius, 3));
  }
  return diskOffsetRadius(index - localCount, Math.max(count - localCount, 1), maxRadius);
}

function gatherCoverageAlpha(
  supportWeights: readonly number[],
  sourceRadius: number,
  sourceCoverages: readonly number[] = supportWeights.map(() => 1),
  sampleAlphas: readonly number[] = supportWeights.map(() => 1),
  accepted: readonly boolean[] = supportWeights.map(() => true),
  domainRadius = 16,
): number {
  if (
    sourceCoverages.length !== supportWeights.length ||
    sampleAlphas.length !== supportWeights.length ||
    accepted.length !== supportWeights.length
  ) {
    throw new Error('coverage fixtures must have matching lengths');
  }
  const largeFactor = halfResolutionSourceFactor(sourceRadius);
  const kernelMean = sourceKernelMean(sourceRadius, domainRadius, supportWeights.length);
  let capacity = 0;
  let numerator = 0;
  for (let index = 0; index < supportWeights.length; index += 1) {
    const sourceCoverage = sourceCoverages[index] ?? 0;
    capacity += sourceCoverage;
    if (accepted[index] === true) {
      const normalizedSupport = (supportWeights[index] ?? 0) / kernelMean;
      numerator += normalizedSupport * largeFactor * sourceCoverage * (sampleAlphas[index] ?? 0);
    }
  }
  return Math.min(1, numerator / Math.max(capacity, 1e-5));
}

function backgroundConfidence(
  supportWeights: readonly number[],
  sourceRadius: number,
  sourceCoverages: readonly number[],
  nearSource: readonly boolean[],
  backgroundWeights: readonly number[],
  domainRadius = 16,
): number {
  if (
    sourceCoverages.length !== supportWeights.length ||
    nearSource.length !== supportWeights.length ||
    backgroundWeights.length !== supportWeights.length
  ) {
    throw new Error('background fixtures must have matching lengths');
  }
  const largeFactor = fullResolutionSourceFactor(sourceRadius);
  const kernelMean = sourceKernelMean(sourceRadius, domainRadius, supportWeights.length);
  let capacity = 0;
  let nearCoverage = 0;
  let backgroundWeight = 0;
  for (let index = 0; index < supportWeights.length; index += 1) {
    const sourceCoverage = sourceCoverages[index] ?? 0;
    capacity += sourceCoverage;
    if (nearSource[index] === true) {
      nearCoverage += ((supportWeights[index] ?? 0) / kernelMean) * largeFactor * sourceCoverage;
    }
    backgroundWeight += backgroundWeights[index] ?? 0;
  }
  const hasBackground = backgroundWeight > 0 && capacity > 0;
  return hasBackground ? Math.min(1, nearCoverage / Math.max(capacity, 1e-5)) : 0;
}

function backgroundResolveColor(
  currentColor: readonly number[],
  backgroundColor: readonly number[],
  nearCoverage: number,
  coverageCapacity: number,
  backgroundWeight: number,
): number[] {
  const hasBackground = backgroundWeight > 0 && coverageCapacity > 0;
  const confidence = hasBackground
    ? Math.min(1, nearCoverage / Math.max(coverageCapacity, 1e-5))
    : 0;
  return currentColor.map(
    (value, index) => value * (1 - confidence) + (backgroundColor[index] ?? 0) * confidence,
  );
}

function areaWeightedColor(
  samples: readonly { readonly color: readonly number[]; readonly alpha: number }[],
): number[] {
  const totalArea = samples.reduce((sum, sample) => sum + sample.alpha, 0);
  return (samples[0]?.color ?? []).map(
    (_, channel) =>
      samples.reduce((sum, sample) => sum + (sample.color[channel] ?? 0) * sample.alpha, 0) /
      Math.max(totalArea, 1e-5),
  );
}

function prefilterResolveColor(
  currentColor: readonly number[],
  samples: readonly { readonly color: readonly number[]; readonly alpha: number }[],
): number[] {
  const totalArea = samples.reduce((sum, sample) => sum + sample.alpha, 0);
  if (totalArea <= 0) return [...currentColor];
  return areaWeightedColor(samples);
}

function compositeNearColor(
  baseColor: readonly number[],
  nearColor: readonly number[],
  coverage: number,
): number[] {
  const weight = Math.max(0, Math.min(1, coverage));
  return baseColor.map((value, index) => value * (1 - weight) + (nearColor[index] ?? 0) * weight);
}

function smallKernelAcceptedCount(sourceRadius: number, tapCount = 8, radiusPixels = 2): number {
  return Array.from({ length: tapCount }, (_, index) =>
    diskOffsetRadius(index, tapCount, radiusPixels),
  ).filter((distance) => distance <= sourceRadius + 0.5).length;
}

function smallKernelColor(
  centerColor: readonly number[],
  sourceColor: readonly number[],
  sourceRadius: number,
  tapCount = 8,
): number[] {
  const accepted = smallKernelAcceptedCount(sourceRadius, tapCount);
  const weight = 1 + accepted;
  return centerColor.map((value, index) => (value + (sourceColor[index] ?? 0) * accepted) / weight);
}

function sourceCircleSupport(sourceRadius: number, distancePixels: number): number {
  return Math.max(
    0,
    Math.min(1, (sourceRadius + 1 - distancePixels) / Math.max(sourceRadius + 1, 1)),
  );
}

function smallKernelConfidence(sourceRadius: number, tapCount = 8, radiusPixels = 2): number {
  const accepted = smallKernelAcceptedCount(sourceRadius, tapCount, radiusPixels);
  const smallSourceFactor = 1 - halfResolutionSourceFactor(sourceRadius);
  const sourceWeight = accepted * smallSourceFactor;
  return Math.min(1, Math.max(0, sourceWeight / Math.max(1 + sourceWeight, 1)));
}

function focalNearColor(
  baseColor: readonly number[],
  nearGatherColor: readonly number[],
  smallColor: readonly number[],
  smallConfidence: number,
  nearCoverage: number,
): number[] {
  const blendedNearColor = nearGatherColor.map(
    (value, index) => value * (1 - smallConfidence) + (smallColor[index] ?? 0) * smallConfidence,
  );
  return compositeNearColor(baseColor, blendedNearColor, nearCoverage);
}

function singleSampleCoverage(depth: number): number {
  return Number.isFinite(depth) && depth > 0 ? 1 : 0;
}

function nearestLayerCoverage(depths: readonly (number | undefined)[]): {
  readonly depth: number;
  readonly coverage: number;
} {
  const valid = depths.filter(
    (depth): depth is number => depth !== undefined && Number.isFinite(depth) && depth > 0,
  );
  if (valid.length === 0) return { depth: 0, coverage: 0 };
  const depth = Math.min(...valid);
  const tolerance = Math.max(0.02, depth * 0.04);
  const nearestSamples = valid.filter((sample) => Math.abs(sample - depth) <= tolerance).length;
  return { depth, coverage: nearestSamples / 4 };
}

describe('Depth of Field parameter and shader contract', () => {
  it('derives the thin-lens focal length and signed CoC oracle', () => {
    const resolved = validateDepthOfFieldParams({}, camera);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { value } = resolved;
    expect(value.focalLength).toBeCloseTo(0.032969729, 7);
    expect(signedDepthOfFieldCoC(value, 8, 1080)).toBeCloseTo(0, 7);
    expect(signedDepthOfFieldCoC(value, 4, 1080)).toBeCloseTo(-1.0963741, 5);
    expect(signedDepthOfFieldCoC(value, 16, 1080)).toBeCloseTo(0.548187, 5);

    const clamped = validateDepthOfFieldParams({ maxRadiusPixels: 0.5 }, camera);
    expect(clamped.ok).toBe(true);
    if (clamped.ok) {
      expect(signedDepthOfFieldCoC(clamped.value, 4, 1080)).toBe(-0.5);
      expect(signedDepthOfFieldCoC(clamped.value, 16, 1080)).toBe(0.5);
    }
  });

  it('keeps wide but representable f32 optics finite with the stable CoC ratio', () => {
    const wideCamera = {
      projection: 'perspective' as const,
      fov: 1,
      near: 1,
      far: 2e30,
    };
    const resolved = validateDepthOfFieldParams(
      { focusDistance: 1e30, sensorHeight: 1e20 },
      wideCamera,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const frame = validateDepthOfFieldFrameParams(resolved.value, {
      outputHeight: 1080,
      near: wideCamera.near,
      far: wideCamera.far,
      useTemporalDepth: false,
    });
    expect(frame.ok).toBe(true);
    const bytes = packDepthOfFieldParams(resolved.value, {
      outputHeight: 1080,
      near: wideCamera.near,
      far: wideCamera.far,
      useTemporalDepth: false,
    });
    expect(Array.from(new Float32Array(bytes.buffer)).every(Number.isFinite)).toBe(true);
    expect(signedDepthOfFieldCoC(resolved.value, 1e30, 1080)).toBeCloseTo(0, 5);
  });

  it('accepts the authored f32 f-stop boundaries after quantization', () => {
    const minimum = validateDepthOfFieldParams({ fStop: 0.7 }, camera);
    const maximum = validateDepthOfFieldParams({ fStop: 32 }, camera);
    expect(minimum.ok).toBe(true);
    expect(maximum.ok).toBe(true);
    if (minimum.ok) expect(minimum.value.fStop).toBe(Math.fround(0.7));
    if (maximum.ok) expect(maximum.value.fStop).toBe(Math.fround(32));
  });

  it('rejects values that become zero or infinity at the f32 boundary', () => {
    const cases = [
      [{ focusDistance: Number.MIN_VALUE }, camera, 'focusDistance'],
      [{ sensorHeight: Number.MIN_VALUE }, camera, 'sensorHeight'],
      [{ fStop: Number.MAX_VALUE }, camera, 'fStop'],
      [{ focusDistance: 8 }, { ...camera, near: Number.MIN_VALUE }, 'near/far'],
      [{ focusDistance: 8 }, { ...camera, far: Number.MAX_VALUE }, 'near/far'],
    ] as const;
    for (const [input, inputCamera, field] of cases) {
      const result = validateDepthOfFieldParams(input, inputCamera);
      expect(result.ok, field).toBe(false);
      if (!result.ok && 'field' in result.error.detail) {
        expect(result.error.detail.field).toBe(field);
      }
    }
  });

  it('rejects a focus distance whose f32 value equals the derived focal length', () => {
    const focal = Math.fround(camera.fov === 0 ? 0 : 0.024 / (2 * Math.tan(camera.fov / 2)));
    const result = validateDepthOfFieldParams({ focusDistance: focal }, { ...camera, near: 0.001 });
    expect(result.ok).toBe(false);
    if (!result.ok && 'field' in result.error.detail) {
      expect(result.error.detail.field).toBe('focusDistance');
      expect(result.error.expected).toContain('focalLength in f32');
    }
  });

  it('rejects an unrepresentable packed CoC endpoint before creating the UBO', () => {
    const resolved = validateDepthOfFieldParams(
      { focusDistance: 1, sensorHeight: 0.1 },
      { projection: 'perspective', fov: 1, near: 1e-38, far: 10 },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const frame = validateDepthOfFieldFrameParams(resolved.value, {
      outputHeight: 1080,
      near: 1e-38,
      far: 10,
      useTemporalDepth: false,
    });
    expect(frame.ok).toBe(false);
    let thrown: unknown;
    try {
      packDepthOfFieldParams(resolved.value, {
        outputHeight: 1080,
        near: 1e-38,
        far: 10,
        useTemporalDepth: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { readonly detail?: { readonly field?: string } }).detail?.field).toBe(
      'coc.near',
    );
  });

  it('rejects a near/far ratio that collapses to zero at the f32 depth seam', () => {
    const resolved = validateDepthOfFieldParams({}, camera);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const frame = validateDepthOfFieldFrameParams(resolved.value, {
      outputHeight: 1080,
      near: Math.fround(2 ** -149),
      far: Math.fround(3.402823e38),
      useTemporalDepth: false,
    });
    expect(frame.ok).toBe(false);
    if (!frame.ok && 'field' in frame.error.detail) {
      expect(frame.error.detail.field).toBe('near/far ratio');
    }
  });

  it('preserves CoC under equal world-length scaling', () => {
    const base = validateDepthOfFieldParams({}, camera);
    const scaled = validateDepthOfFieldParams(
      { focusDistance: 80, sensorHeight: 0.24 },
      { ...camera, near: 1, far: 1000 },
    );
    expect(base.ok).toBe(true);
    expect(scaled.ok).toBe(true);
    if (base.ok && scaled.ok) {
      for (const depth of [2, 4, 8, 16, 20]) {
        expect(signedDepthOfFieldCoC(scaled.value, depth * 10, 1080)).toBeCloseTo(
          signedDepthOfFieldCoC(base.value, depth, 1080),
          5,
        );
      }
    }
  });

  it('packs the stable 4xvec4 layout consumed by both WGSL variants', () => {
    const resolved = validateDepthOfFieldParams({ quality: DepthOfFieldQualityValue.high }, camera);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const bytes = packDepthOfFieldParams(resolved.value, {
      outputHeight: 1080,
      near: camera.near,
      far: camera.far,
      useTemporalDepth: true,
    });
    expect(bytes.byteLength).toBe(DEPTH_OF_FIELD_PARAMS_BYTE_SIZE);
    const payload = Array.from(new Float32Array(bytes.buffer));
    const expected = [
      8,
      2.8,
      0.024,
      resolved.value.focalLength,
      1080,
      16,
      0,
      2,
      0.1,
      100,
      1,
      0,
      1.0963743,
      0,
      0,
      0,
    ];
    expect(payload).toHaveLength(expected.length);
    payload.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? 0, 6);
    });
    // The WGSL consumer reads reserved.x (row3.x, float index 12). Keep the
    // row2.w reserved lane zero so the CPU pack and both shader variants share
    // one 64-byte binding contract.
    expect(payload[11]).toBeCloseTo(0, 6);
    expect(payload[12]).toBeCloseTo(1.0963743, 6);
    expect(signedDepthOfFieldCoC(resolved.value, camera.near, 1080)).toBeLessThan(0);
    expect(signedDepthOfFieldCoC(resolved.value, resolved.value.focusDistance, 1080)).toBeCloseTo(
      0,
      6,
    );
    expect(signedDepthOfFieldCoC(resolved.value, camera.far, 1080)).toBeGreaterThan(0);
    expect(depthOfFieldQualityCode('low')).toBe(DepthOfFieldQualityValue.low);
    expect(depthOfFieldSideCode('near')).toBe(DepthOfFieldSideValue.near);
    expect(depthOfFieldTapCount('low')).toBe(16);
    expect(depthOfFieldTapCount('medium')).toBe(32);
    expect(depthOfFieldTapCount('high')).toBe(64);
  });

  it('keeps topology changes separate from optical values and rejects invalid projection', () => {
    const both = validateDepthOfFieldParams({}, camera);
    const near = validateDepthOfFieldParams({ blurSide: DepthOfFieldSideValue.near }, camera);
    const far = validateDepthOfFieldParams({ blurSide: DepthOfFieldSideValue.far }, camera);
    expect(both.ok && depthOfFieldTopology(both.value)).toEqual({
      blurSide: 'both',
      useNear: true,
      useFar: true,
    });
    expect(near.ok && depthOfFieldTopology(near.value)).toEqual({
      blurSide: 'near',
      useNear: true,
      useFar: false,
    });
    expect(far.ok && depthOfFieldTopology(far.value)).toEqual({
      blurSide: 'far',
      useNear: false,
      useFar: true,
    });
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(depthOfFieldTopology({ ...both.value, maxRadiusPixels: 0 })).toBeUndefined();
    }

    const orthographic = validateDepthOfFieldParams({}, { ...camera, projection: 'orthographic' });
    expect(orthographic.ok).toBe(false);
    if (!orthographic.ok)
      expect(orthographic.error.code).toBe('depth-of-field-orthographic-unsupported');
    for (const input of [
      { fStop: 0.69 },
      { sensorHeight: 0 },
      { maxRadiusPixels: 33 },
      { quality: 3 },
      { blurSide: 3 },
    ]) {
      const invalid = validateDepthOfFieldParams(input, camera);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.code).toBe('depth-of-field-invalid-params');
    }
  });

  it('uses the same row/field mapping in single-sample and MSAA WGSL', () => {
    const paths = [
      new URL('../../../../../shader/src/depth-of-field.wgsl', import.meta.url),
      new URL('../../../../../shader/src/depth-of-field-msaa.wgsl', import.meta.url),
    ];
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('let focus = params.optics.x;');
      expect(source).toContain('let outputHeight = params.image.x;');
      expect(source).toContain('let near = params.camera.x;');
      expect(source).toContain('let far = params.camera.y;');
      expect(source).toContain('let depthRatio = near / far;');
      expect(source).toContain('let denominator = raw + (1.0 - raw) * depthRatio;');
      expect(source).toContain('let cocCoefficient = params.reserved.x;');
      expect(source).toContain('let focusOverDepth = focus / depth;');
      expect(source).toContain('let depthFactor = 1.0 - focusOverDepth;');
      expect(source).toContain('let radius = cocCoefficient * depthFactor;');
      expect(source).not.toContain('let cocScale =');
      expect(source).not.toContain('(f * f) / (aperture * (focus - f))');
      expect(source).not.toContain('(near * far) /');
    }
  });

  it('uses side-specific entry points instead of rewriting the shared DoF UBO', () => {
    const feature = readFileSync(
      new URL('../depth-of-field-feature.ts', import.meta.url),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(feature).toContain(
      "fragmentEntryPoint: side === 'near' ? 'fs_prefilter_near' : 'fs_prefilter_far'",
    );
    expect(feature).toContain(
      "fragmentEntryPoint: side === 'near' ? 'fs_prefilter_metadata_near' : 'fs_prefilter_metadata_far'",
    );
    expect(feature).not.toContain('paramsTransform: sideParamsTransform');
    for (const path of [
      new URL('../../../../../shader/src/depth-of-field.wgsl', import.meta.url),
      new URL('../../../../../shader/src/depth-of-field-msaa.wgsl', import.meta.url),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('fn fs_prefilter_near');
      expect(source).toContain('fn fs_prefilter_far');
      expect(source).toContain('fn fs_prefilter_metadata_near');
      expect(source).toContain('fn fs_prefilter_metadata_far');
    }
  });

  it('carries source coverage through the DoF resolve contract', () => {
    const msaaPath = new URL('../../../../../shader/src/depth-of-field-msaa.wgsl', import.meta.url);
    const paths = [
      new URL('../../../../../shader/src/depth-of-field.wgsl', import.meta.url),
      msaaPath,
    ];
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('fn depthAndCoverageAt');
      expect(source).toContain('fn cocCoverageAtExtra1');
      expect(source).toContain('depthSample.coverage');
      expect(source).toContain('let largeSourceFactor = smoothstep(2.0, 3.0, sourceRadius);');
      expect(source).toContain('let nearSourceFactor = smoothstep(0.5, 2.0, sourceRadius);');
      expect(source).toContain('fn sourceKernelMean(sourceRadius : f32, tapCount : f32) -> f32');
      expect(source).toContain('supportWeight / sourceKernelMean(sourceRadius, tapLimit())');
      expect(source).toContain(
        'fn circleKernelMean(sourceRadius : f32, domainRadius : f32) -> f32',
      );
      expect(source).toContain('(localCount * localMean + outerCount * outerMean)');
      expect(source).toContain('fn sourceDiskOffset(index : u32, count : f32) -> vec2<f32>');
      expect(source).toContain('let localCount = max(1.0, floor(count * 0.25));');
      expect(source).toContain('min(params.image.y, 3.0)');
      expect(source).toContain('let sampleAreaWeight = cocCoverage * sample.a;');
      expect(source).toContain('supportWeight * largeSourceFactor * sampleAreaWeight');
      expect(source).toContain('let sourceCoverageFactor = largeSourceFactor;');
      expect(source).toContain('normalizedSupport * sourceCoverageFactor * sampleAreaWeight');
      expect(source).toContain('coverage += coverageWeight;');
      expect(source).toContain(
        'let resolvedColor = select(fallbackColor, color / positiveWeight, weight > 0.0);',
      );
      expect(source).toContain('return vec4<f32>(color, alpha);');
      expect(source).toContain('var coverageCapacity = 0.0;');
      expect(source).toContain('coverageCapacity += cocCoverage;');
      expect(source).toContain(
        'let alpha = clamp(accumulator.coverage / max(capacity, 1e-5), 0.0, 1.0);',
      );
      expect(source).toContain(
        'let hasBackground = backgroundWeight > 0.0 && coverageCapacity > 0.0;',
      );
      expect(source).toContain('clamp(backgroundCoverage / max(coverageCapacity, 1e-5), 0.0, 1.0)');
      expect(source).toContain(
        'vec4<f32>(backgroundColor / max(backgroundWeight, 1e-5), confidence)',
      );
      expect(source).toContain('let nearCoverage = clamp(background.a, 0.0, 1.0);');
      expect(source).toContain('let nearWeight = clamp(nearBlur.a, 0.0, 1.0);');
      expect(source).toContain('let focalDestination = absoluteCoc < 0.5;');
      expect(source).toContain('if (hasSmallDestination && coc < -0.001)');
      expect(source).toContain('color = mix(nearBase, small.rgb, smallFactor);');
      expect(source).toContain('color = mix(color, nearBlur.rgb, nearWeight);');
      expect(source.indexOf('if (hasSmallDestination && coc < -0.001)')).toBeLessThan(
        source.indexOf('let nearWeight = clamp(nearBlur.a, 0.0, 1.0);'),
      );
      expect(source).toContain('if (focalDestination && (nearWeight > 0.0 || nearCoverage > 0.0))');
      expect(source).toContain(
        'fn smallBlur(uv : vec2<f32>, nearSide : bool, radiusPixels : f32) -> vec4<f32>',
      );
      expect(source).toContain(
        'let smallSourceFactor = 1.0 - smoothstep(2.0, 3.0, abs(sourceCoc));',
      );
      expect(source).toContain(
        'let sampleWeight = select(0.0, sourceCoverage * smallSourceFactor, accepted);',
      );
      expect(source).toContain(
        'let fallbackColor = textureSampleLevel(currentColor, linearSampler, in.uv, 0.0).rgb;',
      );
      expect(source).toContain(
        'let resolvedColor = select(fallbackColor, color / positiveWeight, weight > 0.0);',
      );
      expect(source).toContain(
        'let confidence = clamp((weight - 1.0) / max(weight, 1.0), 0.0, 1.0);',
      );
      expect(source).toContain('let small = smallBlur(in.uv, true, 2.0);');
      expect(source).toContain('let supports = distancePixels <= abs(sourceCoc) + 0.5;');
      expect(source).toContain('let largeFactor = smoothstep(2.0, 3.0, absoluteCoc);');
      expect(source).toContain('let smallFactor = smoothstep(0.5, 2.0, absoluteCoc)');
    }
    const msaa = readFileSync(msaaPath, 'utf8');
    expect(msaa).toContain('var nearestSamples = 0u;');
    expect(msaa).toContain('abs(sampleDepth - depth) <= layerTolerance');
    expect(msaa).toContain('f32(nearestSamples) / 4.0');
  });

  it('keeps single-sample coverage binary and MSAA coverage on the nearest layer', () => {
    expect(singleSampleCoverage(2)).toBe(1);
    expect(singleSampleCoverage(0)).toBe(0);
    expect(nearestLayerCoverage([2, 8, 8, 8])).toEqual({ depth: 2, coverage: 0.25 });
    expect(nearestLayerCoverage([8, 8.2, 8.1, undefined]).coverage).toBeCloseTo(0.75, 6);
    expect(nearestLayerCoverage([undefined, 0, Number.NaN, 8])).toEqual({
      depth: 8,
      coverage: 0.25,
    });
  });

  it('weights gathered RGB by the same prefiltered sample area as coverage', () => {
    const resolved = areaWeightedColor([
      { color: [1, 0, 0], alpha: 0.25 },
      { color: [0, 0, 1], alpha: 1 },
    ]);
    expect(resolved).toEqual([0.2, 0, 0.8]);
    expect(resolved[0]).toBeLessThan(0.25);
    expect(resolved[2]).toBeGreaterThan(0.75);
  });

  it('allows near gather coverage and color to reach a focal destination', () => {
    const focal = compositeNearColor([1, 1, 1], [5, 1, 0], 0.4);
    expect(focal).toEqual([2.6, 1, 0.6]);
    expect(compositeNearColor([1, 1, 1], [5, 1, 0], 0)).toEqual([1, 1, 1]);
    expect(compositeNearColor([1, 1, 1], [5, 1, 0], 1)).toEqual([5, 1, 0]);
  });

  it('diffuses a 1.5px red near source into a blue focal destination', () => {
    const sourceRadius = 1.5;
    const sourceCoverage = fullResolutionSourceFactor(sourceRadius);
    const accepted = smallKernelAcceptedCount(sourceRadius);
    const nearColor = smallKernelColor([0, 0, 1], [1, 0, 0], sourceRadius);
    const focal = focalNearColor(
      [0, 0, 1],
      [0, 0, 1],
      nearColor,
      smallKernelConfidence(sourceRadius),
      sourceCoverage,
    );
    expect(halfResolutionSourceFactor(sourceRadius)).toBe(0);
    expect(accepted).toBe(8);
    expect(nearColor).toEqual([8 / 9, 0, 1 / 9]);
    expect(sourceCoverage).toBeCloseTo(0.7407407407, 6);
    expect(smallKernelConfidence(sourceRadius)).toBeCloseTo(8 / 9, 6);
    expect(focal[0]).toBeCloseTo(0.5852766347, 6);
    expect(focal[2]).toBeCloseTo(0.4147233653, 6);
    expect(focal[0]).toBeGreaterThan(0);
    expect(focal[2]).toBeLessThan(1);
  });

  it('retains a large near gather contribution at a focal destination', () => {
    const sourceRadius = 6;
    const sourceDistance = 3;
    const nearGatherColor = [1, 0, 0];
    const focalBase = [0, 0, 1];
    const smallColor = [0, 0, 1];
    const support = sourceCircleSupport(sourceRadius, sourceDistance);
    const smallConfidence = smallKernelConfidence(sourceRadius);
    const focal = focalNearColor(focalBase, nearGatherColor, smallColor, smallConfidence, support);
    expect(support).toBeCloseTo(4 / 7, 6);
    expect(smallConfidence).toBe(0);
    expect(focal[0]).toBeCloseTo(4 / 7, 6);
    expect(focal[1]).toBe(0);
    expect(focal[2]).toBeCloseTo(3 / 7, 6);
    expect(focal[0]).toBeGreaterThan(0);
  });

  it('preserves constant color when near coverage has no selected prefilter samples', () => {
    const white = [1, 1, 1];
    const nearGatherColor = prefilterResolveColor(white, []);
    const sourceRadius = 1.5;
    const smallColor = smallKernelColor(white, white, sourceRadius);
    const focal = focalNearColor(
      white,
      nearGatherColor,
      smallColor,
      smallKernelConfidence(sourceRadius),
      fullResolutionSourceFactor(sourceRadius),
    );
    expect(nearGatherColor).toEqual(white);
    expect(focal).toEqual(white);
  });

  it('keeps small near blur full-resolution through 2px and cross-fades at 2-3px', () => {
    expect(radiusMix(0.49)).toEqual({ small: 0, half: 0 });
    expect(radiusMix(0.5)).toEqual({ small: 0, half: 0 });
    expect(radiusMix(1).small).toBeGreaterThan(0);
    expect(radiusMix(1).half).toBe(0);
    expect(radiusMix(2)).toEqual({ small: 1, half: 0 });
    expect(radiusMix(2.5).small).toBeCloseTo(0.5, 6);
    expect(radiusMix(2.5).half).toBeCloseTo(0.5, 6);
    expect(radiusMix(3)).toEqual({ small: 0, half: 1 });
  });

  it('keeps fractional source coverage for sparse focal destinations', () => {
    const candidateCount = 16;
    const sourceCoverages = Array.from({ length: candidateCount }, () => 1);
    const sparseSupports = (nearTapCount: number) =>
      Array.from({ length: candidateCount }, (_, index) =>
        index < nearTapCount ? ([0.05, 0.07, 0.09, 0.11][index] ?? 0) : 0,
      );
    const alphaFor = (nearTapCount: number) => {
      const supports = sparseSupports(nearTapCount);
      return gatherCoverageAlpha(
        supports,
        6,
        sourceCoverages,
        sourceCoverages,
        supports.map((support) => support > 0),
      );
    };
    const oneTap = alphaFor(1);
    const twoTaps = alphaFor(2);
    const fourTaps = alphaFor(4);
    expect(oneTap).toBeGreaterThan(0);
    expect(oneTap).toBeLessThan(1);
    expect(twoTaps).toBeGreaterThan(oneTap);
    expect(twoTaps).toBeLessThan(1);
    expect(fourTaps).toBeGreaterThan(twoTaps);
    expect(fourTaps).toBeLessThan(1);
  });

  it('keeps focal background confidence fractional for one, two, and four near taps', () => {
    const candidateCount = 16;
    const sourceCoverages = Array.from({ length: candidateCount }, () => 1);
    const backgroundWeights = sourceCoverages.map((_, index) => (index === 15 ? 1 : 0));
    const sparseSupports = (nearTapCount: number) =>
      Array.from({ length: candidateCount }, (_, index) =>
        index < nearTapCount ? ([0.05, 0.07, 0.09, 0.11][index] ?? 0) : 0,
      );
    const confidenceFor = (nearTapCount: number) => {
      const supports = sparseSupports(nearTapCount);
      return backgroundConfidence(
        supports,
        6,
        sourceCoverages,
        supports.map((support) => support > 0),
        backgroundWeights,
      );
    };
    const oneTap = confidenceFor(1);
    const twoTaps = confidenceFor(2);
    const fourTaps = confidenceFor(4);
    expect(oneTap).toBeGreaterThan(0);
    expect(oneTap).toBeLessThan(1);
    expect(twoTaps).toBeGreaterThan(oneTap);
    expect(twoTaps).toBeLessThan(1);
    expect(fourTaps).toBeGreaterThan(twoTaps);
    expect(fourTaps).toBeLessThan(1);
    const smallNearSupports = [0.05, 0.07, 0.09, 0.11, ...Array.from({ length: 12 }, () => 0)];
    expect(
      backgroundConfidence(
        smallNearSupports,
        1,
        sourceCoverages,
        smallNearSupports.map((support) => support > 0),
        [0, 0, 0, 0, ...Array.from({ length: 12 }, () => 1)],
      ),
    ).toBeGreaterThan(0);
  });

  it('reserves local disk taps for small focal circles at every quality', () => {
    for (const tapCount of [16, 32, 64]) {
      const localCount = Math.max(1, Math.floor(tapCount * 0.25));
      const localRadii = Array.from({ length: localCount }, (_, index) =>
        sourceDiskOffsetRadius(index, tapCount, 16),
      );
      const outerRadii = Array.from({ length: tapCount - localCount }, (_, index) =>
        sourceDiskOffsetRadius(index + localCount, tapCount, 16),
      );
      expect(Math.min(...localRadii)).toBeLessThanOrEqual(1.5);
      expect(Math.max(...localRadii)).toBeLessThanOrEqual(3);
      expect(localRadii.some((distance) => distance <= 1.5)).toBe(true);
      expect(Math.max(...outerRadii)).toBeGreaterThan(10);
    }
  });

  it('normalizes actual mixed-domain support during the half-resolution handoff', () => {
    const maxRadius = 16;
    const expected = new Map([
      [2.25, [0.1389748905, 0.1535840091, 0.1552009122]],
      [2.5, [0.4616459554, 0.4922781345, 0.4965728943]],
      [2.75, [0.7989213548, 0.8295083064, 0.8383427443]],
    ]);
    for (const [sourceRadius, expectedByQuality] of expected) {
      const actual = [16, 32, 64].map((tapCount) => {
        const supports = Array.from({ length: tapCount }, (_, index) =>
          Math.max(
            0,
            Math.min(
              1,
              (sourceRadius + 1 - sourceDiskOffsetRadius(index, tapCount, maxRadius)) /
                (sourceRadius + 1),
            ),
          ),
        );
        return gatherCoverageAlpha(
          supports,
          sourceRadius,
          Array.from({ length: tapCount }, () => 1),
          Array.from({ length: tapCount }, () => 1),
          supports.map((support) => support > 0),
          maxRadius,
        );
      });
      actual.forEach((value, index) => {
        expect(value).toBeCloseTo(expectedByQuality[index] ?? 0, 5);
        expect(value).toBeLessThan(1);
      });
      expect(actual[1]).toBeGreaterThan(actual[0] ?? 0);
      expect(actual[2]).toBeGreaterThan(actual[1] ?? 0);
    }
  });

  it('keeps a uniform plane quality invariant while transitioning radius smoothly', () => {
    const radius = 1.25;
    const lowDensity = Array.from({ length: 16 }, () => sourceKernelMean(radius, 16, 16));
    const highDensity = Array.from({ length: 64 }, () => sourceKernelMean(radius, 16, 64));
    expect(gatherCoverageAlpha(lowDensity, radius)).toBeCloseTo(
      halfResolutionSourceFactor(radius),
      6,
    );
    expect(gatherCoverageAlpha(lowDensity, radius)).toBeCloseTo(
      gatherCoverageAlpha(highDensity, radius),
      6,
    );

    const radii = [0.25, 0.5, 1, 1.5, 2, 2.5, 3];
    const alphas = radii.map((radius) => {
      const mean = sourceKernelMean(radius, 16, 32);
      return gatherCoverageAlpha(
        Array.from({ length: 32 }, () => mean),
        radius,
      );
    });
    expect(alphas[0]).toBe(0);
    expect(alphas[1]).toBe(0);
    expect(alphas[2]).toBe(0);
    expect(alphas[3]).toBe(0);
    expect(alphas[4]).toBe(0);
    expect(alphas[5]).toBeCloseTo(0.5, 6);
    expect(alphas[6]).toBeCloseTo(1, 6);
  });

  it('preserves a uniform near plane when no valid background exists at any quality', () => {
    const nearColor = [4, 2, 1];
    const blackBackground = [0, 0, 0];
    for (const tapCount of [16, 32, 64]) {
      const capacity = tapCount * 0.75;
      expect(backgroundResolveColor(nearColor, blackBackground, capacity, capacity, 0)).toEqual(
        nearColor,
      );
    }
  });

  it('keeps off, invalid, and unsupported requests structurally inspectable', () => {
    const off = projectDepthOfFieldInspection({ deviceGeneration: 1 });
    expect(off).toMatchObject({
      enabled: false,
      status: 'off',
      fallbackReason: 'zero-radius',
      passCount: 0,
      lastKnownGood: false,
    });

    const unsupported = validateDepthOfFieldParams({}, { ...camera, projection: 'orthographic' });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      const inspection = projectDepthOfFieldInspection({
        deviceGeneration: 1,
        error: depthOfFieldRequestFailure(unsupported.error),
      });
      expect(inspection).toMatchObject({
        enabled: true,
        status: 'unsupported',
        fallbackReason: 'orthographic-unsupported',
        lastKnownGood: false,
        error: { code: 'depth-of-field-orthographic-unsupported' },
      });
    }

    const invalid = validateDepthOfFieldParams({ fStop: 0.69 }, camera);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      const inspection = projectDepthOfFieldInspection({
        deviceGeneration: 1,
        error: depthOfFieldRequestFailure(invalid.error),
      });
      expect(inspection).toMatchObject({
        enabled: true,
        status: 'invalid',
        fallbackReason: 'invalid-params',
        error: { code: 'depth-of-field-invalid-params' },
      });
    }
  });

  it('keeps accepted params as the frame fallback for rejected requests', () => {
    const accepted = validateDepthOfFieldParams({}, camera);
    const invalid = validateDepthOfFieldParams({ fStop: 0.69 }, camera);
    expect(accepted.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (accepted.ok && !invalid.ok) {
      const failure = depthOfFieldRequestFailure(invalid.error);
      expect(resolveDepthOfFieldFrameParams(undefined, failure, accepted.value)).toBe(
        accepted.value,
      );
      expect(resolveDepthOfFieldFrameParams(undefined, undefined, accepted.value)).toBeUndefined();
      expect(resolveDepthOfFieldFrameParams(accepted.value, failure, undefined)).toBe(
        accepted.value,
      );
    }
    const unsupported = validateDepthOfFieldParams({}, { ...camera, projection: 'orthographic' });
    expect(unsupported.ok).toBe(false);
    if (accepted.ok && !unsupported.ok) {
      expect(
        resolveDepthOfFieldFrameParams(
          undefined,
          depthOfFieldRequestFailure(unsupported.error),
          accepted.value,
        ),
      ).toBeUndefined();
    }
  });
});
