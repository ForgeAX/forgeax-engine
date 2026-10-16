export type SurfaceAppLifecyclePixel = readonly [number, number, number, number];

export interface SurfaceAppLifecycleReadback {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly format: string;
}

export interface SurfaceAppLifecycleMaskPosition {
  readonly x: number;
  readonly y: number;
}

export interface SurfaceAppLifecycleCoverageSurface {
  readonly id: string;
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number];
}

export interface SurfaceAppLifecycleCoverageCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly fov: number;
  readonly aspect: number;
}

export interface SurfaceAppLifecycleProjectedCoverage {
  readonly id: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface SurfaceAppLifecycleCoverageSample {
  readonly projections: readonly SurfaceAppLifecycleProjectedCoverage[];
  readonly coveredPixelCount: number;
  readonly coveredSurfaceIds: readonly string[];
}

export interface SurfaceAppLifecycleCoverageMask {
  readonly mask: readonly SurfaceAppLifecycleMaskPosition[];
  readonly baseline: SurfaceAppLifecycleCoverageSample;
  readonly moved: SurfaceAppLifecycleCoverageSample;
}

export interface SurfaceAppLifecycleRoi {
  /** Numeric/color domain of every pixel; comparisons reject mixed formats. */
  readonly format: string;
  readonly mask: readonly SurfaceAppLifecycleMaskPosition[];
  readonly pixels: readonly SurfaceAppLifecyclePixel[];
  readonly average: SurfaceAppLifecyclePixel;
}

export interface SurfaceAppLifecycleComparison {
  readonly pixelCount: number;
  readonly failedPixelCount: number;
  readonly maxError: number;
  readonly worstPosition: SurfaceAppLifecycleMaskPosition;
  readonly expected: SurfaceAppLifecyclePixel;
  readonly actual: SurfaceAppLifecyclePixel;
}

const ROI_RADIUS = 8;
export const SURFACE_APP_LIFECYCLE_MAX_ERROR = 0.05;

/** Freeze a geometry-derived ROI before reading rendered bytes. */
export function createSurfaceAppLifecycleMask(input: {
  readonly width: number;
  readonly height: number;
  readonly cellIndex: number;
  readonly cellCount: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  /** Optional half-width/half-height in pixels for a geometry-owned probe. */
  readonly radius?: number;
}): readonly SurfaceAppLifecycleMaskPosition[] {
  const { width, height, cellIndex, cellCount } = input;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(cellIndex) ||
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellIndex < 0 ||
    cellIndex >= cellCount
  ) {
    throw new Error('surface-app-lifecycle: invalid fixed ROI geometry');
  }
  const radius = Math.trunc(input.radius ?? ROI_RADIUS);
  if (!Number.isSafeInteger(radius) || radius <= 0) {
    throw new Error('surface-app-lifecycle: invalid fixed ROI radius');
  }
  const centerX =
    Math.floor(((cellIndex + 0.5) * width) / cellCount) + Math.trunc(input.offsetX ?? 0);
  const centerY = Math.floor(height / 2) + Math.trunc(input.offsetY ?? 0);
  const positions: SurfaceAppLifecycleMaskPosition[] = [];
  for (let y = centerY - radius; y < centerY + radius; y += 1) {
    for (let x = centerX - radius; x < centerX + radius; x += 1) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new Error('surface-app-lifecycle: fixed ROI leaves the completed frame');
      }
      positions.push(Object.freeze({ x, y }));
    }
  }
  return Object.freeze(positions);
}

function projectCoverageSurface(
  surface: SurfaceAppLifecycleCoverageSurface,
  camera: SurfaceAppLifecycleCoverageCamera,
  width: number,
  height: number,
): SurfaceAppLifecycleProjectedCoverage {
  const depth = camera.z - surface.center[2];
  if (
    !Number.isFinite(depth) ||
    depth <= 0 ||
    !Number.isFinite(camera.fov) ||
    camera.fov <= 0 ||
    camera.fov >= Math.PI ||
    !Number.isFinite(camera.aspect) ||
    camera.aspect <= 0
  ) {
    throw new Error('surface-app-lifecycle: coverage projection camera is invalid');
  }
  const focal = 1 / Math.tan(camera.fov / 2);
  const halfWidth = surface.size[0] / 2;
  const halfHeight = surface.size[1] / 2;
  const corners: readonly (readonly [number, number])[] = [
    [surface.center[0] - halfWidth, surface.center[1] - halfHeight],
    [surface.center[0] - halfWidth, surface.center[1] + halfHeight],
    [surface.center[0] + halfWidth, surface.center[1] - halfHeight],
    [surface.center[0] + halfWidth, surface.center[1] + halfHeight],
  ];
  const project = ([x, y]: readonly [number, number]): readonly [number, number] => {
    const ndcX = ((x - camera.x) / depth) * (focal / camera.aspect);
    const ndcY = ((y - camera.y) / depth) * focal;
    return [(ndcX * 0.5 + 0.5) * width - 0.5, (0.5 - ndcY * 0.5) * height - 0.5];
  };
  const projected = corners.map(project);
  return Object.freeze({
    id: surface.id,
    minX: Math.min(...projected.map(([x]) => x)),
    maxX: Math.max(...projected.map(([x]) => x)),
    minY: Math.min(...projected.map(([, y]) => y)),
    maxY: Math.max(...projected.map(([, y]) => y)),
  });
}

function evaluateCoverageSample(
  mask: readonly SurfaceAppLifecycleMaskPosition[],
  projections: readonly SurfaceAppLifecycleProjectedCoverage[],
): SurfaceAppLifecycleCoverageSample {
  const coveredSurfaceIds = new Set<string>();
  let coveredPixelCount = 0;
  for (const position of mask) {
    const pixelX = position.x + 0.5;
    const pixelY = position.y + 0.5;
    const hits = projections.filter(
      (projection) =>
        pixelX >= projection.minX &&
        pixelX <= projection.maxX &&
        pixelY >= projection.minY &&
        pixelY <= projection.maxY,
    );
    if (hits.length === 0) continue;
    coveredPixelCount += 1;
    for (const hit of hits) coveredSurfaceIds.add(hit.id);
  }
  return Object.freeze({
    projections,
    coveredPixelCount,
    coveredSurfaceIds: Object.freeze([...coveredSurfaceIds]),
  });
}

/**
 * Derive a fixed ROI's geometric coverage from the authored plane rectangles
 * and the completed camera projections. This is an oracle-side fact: it does
 * not inspect rendered color or infer membership from a readback.
 */
export function createSurfaceAppLifecycleCoverageMask(input: {
  readonly width: number;
  readonly height: number;
  readonly cellIndex: number;
  readonly cellCount: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly radius?: number;
  readonly baselineCamera: SurfaceAppLifecycleCoverageCamera;
  readonly movedCamera: SurfaceAppLifecycleCoverageCamera;
  readonly surfaces: readonly SurfaceAppLifecycleCoverageSurface[];
}): SurfaceAppLifecycleCoverageMask {
  const mask = createSurfaceAppLifecycleMask(input);
  const baselineProjections = input.surfaces.map((surface) =>
    projectCoverageSurface(surface, input.baselineCamera, input.width, input.height),
  );
  const movedProjections = input.surfaces.map((surface) =>
    projectCoverageSurface(surface, input.movedCamera, input.width, input.height),
  );
  return Object.freeze({
    mask,
    baseline: evaluateCoverageSample(mask, baselineProjections),
    moved: evaluateCoverageSample(mask, movedProjections),
  });
}

function readPixel(
  readback: SurfaceAppLifecycleReadback,
  position: SurfaceAppLifecycleMaskPosition,
): SurfaceAppLifecyclePixel {
  const bytesPerPixel = readback.format === 'rgba16float' ? 8 : 4;
  if (
    readback.bytesPerRow < readback.width * bytesPerPixel ||
    readback.bytes.byteLength < readback.bytesPerRow * readback.height ||
    position.x < 0 ||
    position.x >= readback.width ||
    position.y < 0 ||
    position.y >= readback.height
  ) {
    throw new Error('surface-app-lifecycle: completed readback does not cover the fixed ROI');
  }
  const offset = position.y * readback.bytesPerRow + position.x * bytesPerPixel;
  if (readback.format === 'rgba16float') {
    const view = new DataView(
      readback.bytes.buffer,
      readback.bytes.byteOffset,
      readback.bytes.byteLength,
    );
    return [0, 2, 4, 6].map((channelOffset) => {
      const value = decodeFloat16(view.getUint16(offset + channelOffset, true));
      if (!Number.isFinite(value)) {
        throw new Error('surface-app-lifecycle: completed HDR pixel is non-finite');
      }
      return value;
    }) as unknown as SurfaceAppLifecyclePixel;
  }
  const raw = [
    readback.bytes[offset] ?? 0,
    readback.bytes[offset + 1] ?? 0,
    readback.bytes[offset + 2] ?? 0,
    readback.bytes[offset + 3] ?? 0,
  ] as const;
  const normalize = (value: number): number => value / 255;
  if (readback.format.startsWith('bgra8')) {
    return [normalize(raw[2]), normalize(raw[1]), normalize(raw[0]), normalize(raw[3])];
  }
  if (readback.format.startsWith('rgba8')) {
    return raw.map(normalize) as unknown as SurfaceAppLifecyclePixel;
  }
  throw new Error(`surface-app-lifecycle: unsupported observation format ${readback.format}`);
}

function decodeFloat16(word: number): number {
  const sign = (word & 0x8000) === 0 ? 1 : -1;
  const exponent = (word >>> 10) & 0x1f;
  const fraction = word & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Read every preselected pixel; rendered values never influence membership. */
export function readSurfaceAppLifecycleRoi(
  readback: SurfaceAppLifecycleReadback,
  mask: readonly SurfaceAppLifecycleMaskPosition[],
): SurfaceAppLifecycleRoi {
  if (mask.length === 0) throw new Error('surface-app-lifecycle: fixed ROI mask is empty');
  const pixels = mask.map((position) => readPixel(readback, position));
  const sum = pixels.reduce(
    (current, pixel) => [
      current[0] + pixel[0],
      current[1] + pixel[1],
      current[2] + pixel[2],
      current[3] + pixel[3],
    ],
    [0, 0, 0, 0],
  );
  return Object.freeze({
    format: readback.format,
    mask,
    pixels: Object.freeze(pixels),
    average: Object.freeze(
      sum.map((value) => value / pixels.length),
    ) as unknown as SurfaceAppLifecyclePixel,
  });
}

/** Compare every eligible pixel; one damaged legal pixel fails the report. */
export function compareSurfaceAppLifecycleRois(
  expected: SurfaceAppLifecycleRoi,
  actual: SurfaceAppLifecycleRoi,
): SurfaceAppLifecycleComparison {
  if (expected.format !== actual.format) {
    throw new Error('surface-app-lifecycle: ROI color domain changed after readback');
  }
  if (
    expected.mask.length === 0 ||
    expected.mask.length !== actual.mask.length ||
    expected.pixels.length !== expected.mask.length ||
    actual.pixels.length !== actual.mask.length
  ) {
    throw new Error('surface-app-lifecycle: ROI comparison shape is invalid');
  }
  let failedPixelCount = 0;
  let maxError = -1;
  let worstIndex = 0;
  for (let index = 0; index < expected.mask.length; index += 1) {
    const expectedPosition = expected.mask[index];
    const actualPosition = actual.mask[index];
    const expectedPixel = expected.pixels[index];
    const actualPixel = actual.pixels[index];
    if (
      expectedPosition === undefined ||
      actualPosition === undefined ||
      expectedPixel === undefined ||
      actualPixel === undefined ||
      expectedPosition.x !== actualPosition.x ||
      expectedPosition.y !== actualPosition.y
    ) {
      throw new Error('surface-app-lifecycle: ROI mask identity changed after readback');
    }
    const error = Math.max(
      Math.abs(expectedPixel[0] - actualPixel[0]),
      Math.abs(expectedPixel[1] - actualPixel[1]),
      Math.abs(expectedPixel[2] - actualPixel[2]),
    );
    if (!Number.isFinite(error)) throw new Error('surface-app-lifecycle: ROI error is non-finite');
    if (error > SURFACE_APP_LIFECYCLE_MAX_ERROR) failedPixelCount += 1;
    if (error > maxError) {
      maxError = error;
      worstIndex = index;
    }
  }
  return Object.freeze({
    pixelCount: expected.mask.length,
    failedPixelCount,
    maxError,
    worstPosition: expected.mask[worstIndex] as SurfaceAppLifecycleMaskPosition,
    expected: expected.pixels[worstIndex] as SurfaceAppLifecyclePixel,
    actual: actual.pixels[worstIndex] as SurfaceAppLifecyclePixel,
  });
}
