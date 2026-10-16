export type SurfaceEdgeRgb = readonly [number, number, number];
export type SurfaceEdgePoint = Readonly<{ x: number; y: number }>;

export interface SurfaceMsaaReferenceSample {
  readonly depth: number;
  readonly color: SurfaceEdgeRgb;
}

export interface SurfaceMsaaReferenceResult {
  readonly sampleIndex: number;
  readonly depth: number;
  readonly color: SurfaceEdgeRgb;
}

/** Independent reference for the documented nearest-depth/same-sample policy. */
export function resolveSurfaceMsaaReference(
  samples: readonly SurfaceMsaaReferenceSample[],
): SurfaceMsaaReferenceResult {
  const firstSample = samples[0];
  if (firstSample === undefined) {
    throw new Error('surface-msaa-edge: reference samples must not be empty');
  }
  let sampleIndex = 0;
  let selected = firstSample;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) {
      throw new Error(`surface-msaa-edge: reference sample ${index} is unavailable`);
    }
    if (sample.depth < selected.depth) {
      sampleIndex = index;
      selected = sample;
    }
  }
  return Object.freeze({
    sampleIndex,
    depth: selected.depth,
    color: Object.freeze([selected.color[0], selected.color[1], selected.color[2]] as const),
  });
}

/** Deliberately wrong resolve used only as an executable falsifier. */
export function resolveAveragedColorWithNearestDepth(
  samples: readonly [
    SurfaceMsaaReferenceSample,
    SurfaceMsaaReferenceSample,
    SurfaceMsaaReferenceSample,
    SurfaceMsaaReferenceSample,
  ],
): SurfaceMsaaReferenceResult {
  const nearest = resolveSurfaceMsaaReference(samples);
  return Object.freeze({
    sampleIndex: nearest.sampleIndex,
    depth: nearest.depth,
    color: Object.freeze([
      samples.reduce((sum, sample) => sum + sample.color[0], 0) / samples.length,
      samples.reduce((sum, sample) => sum + sample.color[1], 0) / samples.length,
      samples.reduce((sum, sample) => sum + sample.color[2], 0) / samples.length,
    ] as const),
  });
}

export function surfaceRgbDistance(left: SurfaceEdgeRgb, right: SurfaceEdgeRgb): number {
  return Math.max(...left.map((value, channel) => Math.abs(value - (right[channel] ?? 0))));
}

export interface SurfaceMsaaEdgeGeometry {
  readonly center: readonly [number, number];
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface SurfaceMsaaEdgeProjection {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
  readonly cameraOffsetX: number;
}

export type SurfaceMsaaEdgeResolveExpectation = 'nearest-opaque-pair' | 'water-coverage-average';

export interface SurfaceMsaaEdgeMaskPixel {
  readonly pixel: readonly [number, number];
  readonly coveredSampleIndices: readonly number[];
}

export interface SurfaceMsaaEdgeMask {
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly pixels: readonly SurfaceMsaaEdgeMaskPixel[];
}

export interface SurfaceMsaaEdgeImage {
  readonly width: number;
  readonly height: number;
  read(x: number, y: number): SurfaceEdgeRgb;
}

export interface SurfaceMsaaEdgeErrorSample extends SurfaceMsaaEdgeMaskPixel {
  readonly expectedOneX: SurfaceEdgeRgb;
  readonly expectedFourX: SurfaceEdgeRgb;
  readonly actualOneX: SurfaceEdgeRgb;
  readonly actualFourX: SurfaceEdgeRgb;
  readonly oneXError: number;
  readonly fourXError: number;
  readonly maxError: number;
}

export interface SurfaceMsaaEdgeReport {
  readonly eligiblePixelCount: number;
  readonly failedPixelCount: number;
  readonly maxError: number;
  readonly worst: SurfaceMsaaEdgeErrorSample;
  readonly passed: boolean;
}

const finiteRgb = (color: SurfaceEdgeRgb): boolean => color.every(Number.isFinite);

function mixRgb(left: SurfaceEdgeRgb, right: SurfaceEdgeRgb, rightWeight: number): SurfaceEdgeRgb {
  return [
    left[0] * (1 - rightWeight) + right[0] * rightWeight,
    left[1] * (1 - rightWeight) + right[1] * rightWeight,
    left[2] * (1 - rightWeight) + right[2] * rightWeight,
  ];
}

function geometryCoverage(
  geometry: SurfaceMsaaEdgeGeometry,
  point: readonly [number, number],
  rasterizationClearance: number,
): boolean | undefined {
  const dx = point[0] - geometry.center[0];
  const dy = point[1] - geometry.center[1];
  const cosine = Math.cos(geometry.rotation);
  const sine = Math.sin(geometry.rotation);
  const localX = cosine * dx + sine * dy;
  const localY = -sine * dx + cosine * dy;
  const outsideX = Math.abs(localX) - geometry.width * 0.5;
  const outsideY = Math.abs(localY) - geometry.height * 0.5;
  const outsideDistance = Math.hypot(Math.max(outsideX, 0), Math.max(outsideY, 0));
  const signedDistance = outsideDistance + Math.min(Math.max(outsideX, outsideY), 0);
  if (Math.abs(signedDistance) <= rasterizationClearance) return undefined;
  return signedDistance < 0;
}

function worldToPixel(
  position: SurfaceEdgePoint,
  projection: SurfaceMsaaEdgeProjection,
): readonly [number, number] {
  return [
    Math.round(
      ((position.x - projection.cameraOffsetX - projection.left) /
        (projection.right - projection.left)) *
        projection.width -
        0.5,
    ),
    Math.round(
      ((projection.top - position.y) / (projection.top - projection.bottom)) * projection.height -
        0.5,
    ),
  ];
}

function pixelSampleToWorld(
  x: number,
  y: number,
  sample: readonly [number, number],
  projection: SurfaceMsaaEdgeProjection,
): readonly [number, number] {
  return [
    projection.left +
      ((x + sample[0]) / projection.width) * (projection.right - projection.left) +
      projection.cameraOffsetX,
    projection.top - ((y + sample[1]) / projection.height) * (projection.top - projection.bottom),
  ];
}

/**
 * Freeze the acceptance mask from authored geometry and camera facts only.
 * Actual image values are deliberately absent from this boundary.
 */
export function createSurfaceMsaaEdgeMask(input: {
  readonly projection: SurfaceMsaaEdgeProjection;
  readonly geometry: SurfaceMsaaEdgeGeometry;
  readonly excludedGeometries?: readonly SurfaceMsaaEdgeGeometry[];
  readonly min: SurfaceEdgePoint;
  readonly max: SurfaceEdgePoint;
  readonly samplePositions: readonly (readonly [number, number])[];
}): SurfaceMsaaEdgeMask {
  const { projection } = input;
  if (
    !Number.isSafeInteger(projection.width) ||
    projection.width <= 0 ||
    !Number.isSafeInteger(projection.height) ||
    projection.height <= 0 ||
    projection.right <= projection.left ||
    projection.top <= projection.bottom ||
    input.geometry.width <= 0 ||
    input.geometry.height <= 0 ||
    input.samplePositions.length === 0
  ) {
    throw new Error('surface-msaa-edge: invalid deterministic mask input');
  }
  const minPixel = worldToPixel(input.min, projection);
  const maxPixel = worldToPixel(input.max, projection);
  const left = Math.max(0, Math.min(minPixel[0], maxPixel[0]));
  const right = Math.min(projection.width - 1, Math.max(minPixel[0], maxPixel[0]));
  const top = Math.max(0, Math.min(minPixel[1], maxPixel[1]));
  const bottom = Math.min(projection.height - 1, Math.max(minPixel[1], maxPixel[1]));
  // WebGPU rasterization quantizes edge equations at implementation-defined
  // subpixel precision. The acceptance boundary uses the 4-bit subpixel
  // envelope: a modeled center, sample, or excluded geometry point within
  // 1/16 pixel of an authored edge is not a stable geometric fact and is
  // excluded before any actual image value is read.
  const rasterizationClearance =
    Math.max(
      (projection.right - projection.left) / projection.width,
      (projection.top - projection.bottom) / projection.height,
    ) / 16;
  const pixels: SurfaceMsaaEdgeMaskPixel[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const centerPoint = pixelSampleToWorld(x, y, [0.5, 0.5], projection);
      const samplePoints = input.samplePositions.map((sample) =>
        pixelSampleToWorld(x, y, sample, projection),
      );
      const centerCovered = geometryCoverage(input.geometry, centerPoint, rasterizationClearance);
      const sampleCoverage = samplePoints.map((point) =>
        geometryCoverage(input.geometry, point, rasterizationClearance),
      );
      const excludedCoverage = (input.excludedGeometries ?? []).flatMap((geometry) => [
        geometryCoverage(geometry, centerPoint, rasterizationClearance),
        ...samplePoints.map((point) => geometryCoverage(geometry, point, rasterizationClearance)),
      ]);
      const coveredSampleIndices = sampleCoverage.flatMap((covered, sampleIndex) =>
        covered ? [sampleIndex] : [],
      );
      if (
        centerCovered === undefined ||
        sampleCoverage.includes(undefined) ||
        excludedCoverage.some((covered) => covered !== false) ||
        centerCovered ||
        coveredSampleIndices.length === 0 ||
        coveredSampleIndices.length === input.samplePositions.length
      ) {
        continue;
      }
      pixels.push(
        Object.freeze({
          pixel: Object.freeze([x, y] as const),
          coveredSampleIndices: Object.freeze(coveredSampleIndices),
        }),
      );
    }
  }
  if (pixels.length === 0) {
    throw new Error('surface-msaa-edge: deterministic eligibility mask is empty');
  }
  return Object.freeze({
    width: projection.width,
    height: projection.height,
    sampleCount: input.samplePositions.length,
    pixels: Object.freeze(pixels),
  });
}

/** Evaluate every eligible pixel; no actual value can add or remove mask rows. */
export function evaluateSurfaceMsaaEdgeMask(input: {
  readonly mask: SurfaceMsaaEdgeMask;
  readonly oneX: SurfaceMsaaEdgeImage;
  readonly fourX: SurfaceMsaaEdgeImage;
  readonly outsideEndpoint: SurfaceEdgeRgb;
  readonly insideEndpoint: SurfaceEdgeRgb;
  readonly resolveExpectation: SurfaceMsaaEdgeResolveExpectation;
  readonly epsilon: number;
}): SurfaceMsaaEdgeReport {
  if (
    input.mask.pixels.length === 0 ||
    !Number.isSafeInteger(input.mask.sampleCount) ||
    input.mask.sampleCount <= 0
  ) {
    throw new Error('surface-msaa-edge: deterministic eligibility mask is empty');
  }
  if (
    input.oneX.width !== input.mask.width ||
    input.oneX.height !== input.mask.height ||
    input.fourX.width !== input.mask.width ||
    input.fourX.height !== input.mask.height
  ) {
    throw new Error('surface-msaa-edge: observation dimensions do not match eligibility mask');
  }
  if (!Number.isFinite(input.epsilon) || input.epsilon < 0) {
    throw new Error('surface-msaa-edge: invalid acceptance epsilon');
  }
  if (!finiteRgb(input.outsideEndpoint) || !finiteRgb(input.insideEndpoint)) {
    throw new Error('surface-msaa-edge: non-finite RGB endpoint');
  }
  let failedPixelCount = 0;
  let worst: SurfaceMsaaEdgeErrorSample | undefined;
  for (const eligible of input.mask.pixels) {
    const [x, y] = eligible.pixel;
    const coverage = eligible.coveredSampleIndices.length / input.mask.sampleCount;
    const expectedOneX = input.outsideEndpoint;
    const expectedFourX =
      input.resolveExpectation === 'nearest-opaque-pair'
        ? input.insideEndpoint
        : mixRgb(input.outsideEndpoint, input.insideEndpoint, coverage);
    const actualOneX = input.oneX.read(x, y);
    const actualFourX = input.fourX.read(x, y);
    if (
      !finiteRgb(expectedOneX) ||
      !finiteRgb(expectedFourX) ||
      !finiteRgb(actualOneX) ||
      !finiteRgb(actualFourX)
    ) {
      throw new Error(`surface-msaa-edge: non-finite RGB at ${x},${y}`);
    }
    const oneXError = surfaceRgbDistance(actualOneX, expectedOneX);
    const fourXError = surfaceRgbDistance(actualFourX, expectedFourX);
    const maxError = Math.max(oneXError, fourXError);
    const sample = Object.freeze({
      ...eligible,
      expectedOneX,
      expectedFourX,
      actualOneX,
      actualFourX,
      oneXError,
      fourXError,
      maxError,
    });
    if (maxError > input.epsilon) failedPixelCount += 1;
    if (worst === undefined || maxError > worst.maxError) worst = sample;
  }
  if (worst === undefined) {
    throw new Error('surface-msaa-edge: deterministic eligibility mask is empty');
  }
  return Object.freeze({
    eligiblePixelCount: input.mask.pixels.length,
    failedPixelCount,
    maxError: worst.maxError,
    worst,
    passed: failedPixelCount === 0,
  });
}
