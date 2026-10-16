import { describe, expect, it } from 'vitest';
import {
  createSurfaceMsaaEdgeMask,
  evaluateSurfaceMsaaEdgeMask,
  resolveAveragedColorWithNearestDepth,
  resolveSurfaceMsaaReference,
  type SurfaceEdgeRgb,
  type SurfaceMsaaEdgeImage,
  type SurfaceMsaaEdgeMask,
  surfaceRgbDistance,
} from './surface-msaa-edge-oracle';

const SAMPLE_POSITIONS_4X = [
  [0.375, 0.125],
  [0.875, 0.375],
  [0.125, 0.625],
  [0.625, 0.875],
] as const;

function createSixteenPixelMask(): SurfaceMsaaEdgeMask {
  return createSurfaceMsaaEdgeMask({
    projection: {
      width: 4,
      height: 16,
      left: 0,
      right: 4,
      bottom: 0,
      top: 16,
      cameraOffsetX: 0,
    },
    geometry: { center: [2.1, 8], width: 0.3, height: 40, rotation: 0 },
    min: { x: 0, y: 0 },
    max: { x: 4, y: 16 },
    samplePositions: SAMPLE_POSITIONS_4X,
  });
}

const EXPECTATION = {
  outsideEndpoint: [0, 0, 0] as const,
  insideEndpoint: [1, 1, 1] as const,
  resolveExpectation: 'nearest-opaque-pair' as const,
};

function expected(lane: 'oneX' | 'fourX') {
  return lane === 'oneX' ? EXPECTATION.outsideEndpoint : EXPECTATION.insideEndpoint;
}

function legacySingleWitnessAccepts(
  mask: SurfaceMsaaEdgeMask,
  images: { readonly oneX: SurfaceMsaaEdgeImage; readonly fourX: SurfaceMsaaEdgeImage },
): boolean {
  return mask.pixels.some((pixel) => {
    const [x, y] = pixel.pixel;
    const oneXError = surfaceRgbDistance(images.oneX.read(x, y), EXPECTATION.outsideEndpoint);
    const fourXError = surfaceRgbDistance(images.fourX.read(x, y), EXPECTATION.insideEndpoint);
    return Math.max(oneXError, fourXError) <= 0.05;
  });
}

function laneImages(
  mask: SurfaceMsaaEdgeMask,
  select: (pixelIndex: number, lane: 'oneX' | 'fourX') => SurfaceEdgeRgb,
): { readonly oneX: SurfaceMsaaEdgeImage; readonly fourX: SurfaceMsaaEdgeImage } {
  const values = new Map(
    mask.pixels.map((pixel, pixelIndex) => [
      pixel.pixel.join(','),
      {
        oneX: select(pixelIndex, 'oneX'),
        fourX: select(pixelIndex, 'fourX'),
      },
    ]),
  );
  const image = (lane: 'oneX' | 'fourX'): SurfaceMsaaEdgeImage => ({
    width: mask.width,
    height: mask.height,
    read(x, y) {
      return values.get(`${x},${y}`)?.[lane] ?? [0, 0, 0];
    },
  });
  return { oneX: image('oneX'), fourX: image('fourX') };
}

describe('single-layer medium independent four-sample edge oracle', () => {
  it('rejects a partial pixel inside the legacy 1/64 clearance envelope', () => {
    expect(() =>
      createSurfaceMsaaEdgeMask({
        projection: {
          width: 4,
          height: 16,
          left: 0,
          right: 4,
          bottom: 0,
          top: 16,
          cameraOffsetX: 0,
        },
        // The left edge is 1/40 pixel from one modeled sample. A 1/64
        // clearance classified that sample as stable, while the required
        // 4-bit envelope (1/16 pixel) must leave the whole pixel ineligible.
        geometry: { center: [2.3, 8], width: 0.3, height: 40, rotation: 0 },
        min: { x: 0, y: 0 },
        max: { x: 4, y: 16 },
        samplePositions: SAMPLE_POSITIONS_4X,
      }),
    ).toThrow('eligibility mask is empty');
  });

  it('keeps the synthetic partial-coverage spacing deterministic outside the envelope', () => {
    const mask = createSixteenPixelMask();
    expect(mask.pixels).toHaveLength(16);
    expect(new Set(mask.pixels.map((pixel) => pixel.pixel[0]))).toEqual(new Set([2]));
    expect(mask.pixels.every((pixel) => pixel.coveredSampleIndices.join(',') === '2')).toBe(true);
  });

  it('keeps the color at the nearest depth sample instead of averaging coverage', () => {
    const samples = [
      { depth: 0.82, color: [0.04, 0.12, 0.9] },
      { depth: 0.21, color: [0.95, 0.08, 0.03] },
      { depth: 0.79, color: [0.04, 0.12, 0.9] },
      { depth: 0.8, color: [0.04, 0.12, 0.9] },
    ] as const;
    const paired = resolveSurfaceMsaaReference(samples);
    const averaged = resolveAveragedColorWithNearestDepth(samples);

    expect(paired).toEqual({ sampleIndex: 1, depth: 0.21, color: [0.95, 0.08, 0.03] });
    expect(averaged.color).toEqual([0.2675, 0.11, 0.6825]);
    expect(surfaceRgbDistance(averaged.color, paired.color)).toBeGreaterThan(0.05);
  });

  it('fails when fifteen of sixteen eligible pixels are corrupted', () => {
    const mask = createSixteenPixelMask();
    expect(mask.pixels).toHaveLength(16);
    const images = laneImages(mask, (pixelIndex, lane) => {
      const value = expected(lane);
      return pixelIndex === 15 ? value : [1 - value[0], 1 - value[1], 1 - value[2]];
    });
    const report = evaluateSurfaceMsaaEdgeMask({
      mask,
      ...images,
      ...EXPECTATION,
      epsilon: 0.05,
    });
    expect(legacySingleWitnessAccepts(mask, images)).toBe(true);
    expect(report).toMatchObject({ eligiblePixelCount: 16, failedPixelCount: 15, passed: false });
    expect(report.maxError).toBe(1);
  });

  it('fails when one otherwise unselected eligible pixel is corrupted without changing the mask', () => {
    const mask = createSixteenPixelMask();
    const frozenPixels = mask.pixels.map((pixel) => [pixel.pixel, pixel.coveredSampleIndices]);
    const images = laneImages(mask, (pixelIndex, lane) => {
      const value = expected(lane);
      return pixelIndex === 7 && lane === 'fourX' ? [0, 0, 0] : value;
    });
    const report = evaluateSurfaceMsaaEdgeMask({
      mask,
      ...images,
      ...EXPECTATION,
      epsilon: 0.05,
    });
    expect(legacySingleWitnessAccepts(mask, images)).toBe(true);
    expect(report).toMatchObject({ eligiblePixelCount: 16, failedPixelCount: 1, passed: false });
    expect(report.worst.pixel).toEqual(mask.pixels[7].pixel);
    expect(mask.pixels.map((pixel) => [pixel.pixel, pixel.coveredSampleIndices])).toEqual(
      frozenPixels,
    );
  });

  it('accepts all eligible pixels and retains deterministic worst diagnostics', () => {
    const mask = createSixteenPixelMask();
    const images = laneImages(mask, (_pixelIndex, lane) => expected(lane));
    const report = evaluateSurfaceMsaaEdgeMask({
      mask,
      ...images,
      ...EXPECTATION,
      epsilon: 0.05,
    });
    expect(report).toMatchObject({
      eligiblePixelCount: 16,
      failedPixelCount: 0,
      maxError: 0,
      passed: true,
    });
    expect(report.worst.pixel).toEqual(mask.pixels[0].pixel);
  });

  it('rejects empty masks, dimension mismatches, and non-finite RGB', () => {
    const mask = createSixteenPixelMask();
    const correct = laneImages(mask, (_pixelIndex, lane) => expected(lane));
    expect(() =>
      evaluateSurfaceMsaaEdgeMask({
        mask: { width: 4, height: 16, sampleCount: 4, pixels: [] },
        ...correct,
        ...EXPECTATION,
        epsilon: 0.05,
      }),
    ).toThrow('eligibility mask is empty');
    expect(() =>
      evaluateSurfaceMsaaEdgeMask({
        mask,
        oneX: { ...correct.oneX, width: 5 },
        fourX: correct.fourX,
        ...EXPECTATION,
        epsilon: 0.05,
      }),
    ).toThrow('dimensions do not match');
    const nonFinite = laneImages(mask, (pixelIndex, lane) =>
      pixelIndex === 3 && lane === 'fourX' ? [Number.NaN, 0, 0] : expected(lane),
    );
    expect(() =>
      evaluateSurfaceMsaaEdgeMask({
        mask,
        ...nonFinite,
        ...EXPECTATION,
        epsilon: 0.05,
      }),
    ).toThrow('non-finite RGB');
    expect(() =>
      createSurfaceMsaaEdgeMask({
        projection: {
          width: 4,
          height: 16,
          left: 0,
          right: 4,
          bottom: 0,
          top: 16,
          cameraOffsetX: 0,
        },
        geometry: { center: [20, 20], width: 1, height: 1, rotation: 0 },
        min: { x: 0, y: 0 },
        max: { x: 4, y: 16 },
        samplePositions: SAMPLE_POSITIONS_4X,
      }),
    ).toThrow('eligibility mask is empty');
  });
});
