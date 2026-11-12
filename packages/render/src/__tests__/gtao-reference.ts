export type GtaoVec3 = readonly [number, number, number];
export type GtaoMat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Frozen before new GPU observations; output budgets are in RGBA8/R8 codes or linear units. */
export const GTAO_COMPARISON_BUDGET = Object.freeze({
  materialNormalX12Y12AngularRadians: 0.0011,
  rawVisibilityMaxByteError: 3,
  rawVisibilityRmsByteError: 1.25,
  rawNormalMaxByteError: 3,
  rawNormalRmsByteError: 1.25,
  filteredVisibilityMaxByteError: 3,
  filteredVisibilityRmsByteError: 1.25,
  linearLightingMaxAbsoluteError: 0.015,
  linearLightingMaxRelativeError: 0.02,
  linearLightingRelativeFloor: 0.05,
  linearLightingRmsAbsoluteError: 0.003,
});

export const GTAO_ORACLE_SLICE_QUADRATURE_STEPS = 512;
export const GTAO_INTEGRAL_QUADRATURE_STEPS = 16_384;

const PI = Math.PI;
const MAGIC_SQUARE = [
  9, 3, 22, 16, 15, 2, 21, 20, 14, 8, 25, 19, 13, 7, 1, 18, 12, 6, 5, 24, 11, 10, 4, 23, 17,
] as const;

export interface GtaoProjection {
  readonly kind: 'perspective' | 'orthographic';
  readonly matrix: GtaoMat4;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly fovY?: number;
  readonly bounds?: {
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly top: number;
  };
}

export interface GtaoSurfaceField {
  readonly width: number;
  readonly height: number;
  /** A missing position is background; otherwise position is camera view-space. */
  readonly positions: readonly (GtaoVec3 | undefined)[];
  readonly worldNormals: readonly (GtaoVec3 | undefined)[];
  readonly view: GtaoMat4;
  readonly projection: GtaoProjection;
}

export interface GtaoReferenceConfig {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly radius: number;
  readonly bias: number;
  readonly thickness: number;
  readonly distanceExponent: number;
  readonly distanceFallOff: number;
  readonly sampleBudget: number;
  readonly intensity: number;
}

export interface GtaoRawReference {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface GtaoErrorMetrics {
  readonly count: number;
  readonly maxAbsolute: number;
  readonly meanAbsolute: number;
  readonly rms: number;
}

export interface GtaoNormalFieldMetrics {
  readonly count: number;
  readonly maxAngularRadians: number;
  readonly rmsAngularRadians: number;
  readonly maxError?: {
    readonly x: number;
    readonly y: number;
    readonly expectedLow24: number;
    readonly actualLow24: number;
    readonly angularRadians: number;
  };
  readonly firstMismatch?: {
    readonly x: number;
    readonly y: number;
    readonly expected: number;
    readonly actual: number;
  };
}

const dot = (a: GtaoVec3, b: GtaoVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: GtaoVec3, b: GtaoVec3): GtaoVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v: GtaoVec3) => Math.sqrt(dot(v, v));
const normalize = (v: GtaoVec3): GtaoVec3 => {
  const magnitude = length(v);
  return magnitude > 0 ? [v[0] / magnitude, v[1] / magnitude, v[2] / magnitude] : [0, 0, 1];
};
const add = (a: GtaoVec3, b: GtaoVec3): GtaoVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: GtaoVec3, factor: number): GtaoVec3 => [
  v[0] * factor,
  v[1] * factor,
  v[2] * factor,
];
const subtract = (a: GtaoVec3, b: GtaoVec3): GtaoVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function direction(matrix: GtaoMat4, v: GtaoVec3): GtaoVec3 {
  return [
    matrix[0] * v[0] + matrix[4] * v[1] + matrix[8] * v[2],
    matrix[1] * v[0] + matrix[5] * v[1] + matrix[9] * v[2],
    matrix[2] * v[0] + matrix[6] * v[1] + matrix[10] * v[2],
  ];
}

function project(matrix: GtaoMat4, p: GtaoVec3): readonly [number, number, number] {
  const x = matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12];
  const y = matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13];
  const w = matrix[3] * p[0] + matrix[7] * p[1] + matrix[11] * p[2] + matrix[15];
  return [x, y, w];
}

/** Project an independently reconstructed view-space point to Reverse-Z device depth. */
export function reverseZDeviceDepth(projection: GtaoProjection, position: GtaoVec3): number {
  const matrix = projection.matrix;
  const clipZ =
    matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14];
  const clipW =
    matrix[3] * position[0] + matrix[7] * position[1] + matrix[11] * position[2] + matrix[15];
  if (clipW === 0) throw new Error('Reverse-Z projection produced a zero clip W');
  return clipZ / clipW;
}

/** Independent midpoint quadrature for cos(theta - normal) * |sin(theta)|. */
export function cosineWeightedSliceQuadrature(
  normal: number,
  lower: number,
  upper: number,
  steps = GTAO_INTEGRAL_QUADRATURE_STEPS,
): number {
  const delta = (upper - lower) / steps;
  let integral = 0;
  for (let index = 0; index < steps; index += 1) {
    const theta = lower + (index + 0.5) * delta;
    integral += Math.max(0, Math.cos(theta - normal)) * Math.abs(Math.sin(theta)) * delta;
  }
  return integral;
}

export function perspectiveProjection(
  width: number,
  height: number,
  fovY: number,
  near: number,
  far: number,
): GtaoProjection {
  const aspect = width / height;
  const f = 1 / Math.tan(fovY / 2);
  return {
    kind: 'perspective',
    fovY,
    aspect,
    near,
    far,
    matrix: [
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      near / (far - near),
      -1,
      0,
      0,
      (near * far) / (far - near),
      0,
    ],
  };
}

export function orthographicProjection(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): GtaoProjection {
  return {
    kind: 'orthographic',
    aspect: (right - left) / (top - bottom),
    near,
    far,
    bounds: { left, right, bottom, top },
    matrix: [
      2 / (right - left),
      0,
      0,
      0,
      0,
      2 / (top - bottom),
      0,
      0,
      0,
      0,
      1 / (far - near),
      0,
      -(right + left) / (right - left),
      -(top + bottom) / (top - bottom),
      far / (far - near),
      1,
    ],
  };
}

export function viewPositionAtPixel(
  x: number,
  y: number,
  width: number,
  height: number,
  negativeViewZ: number,
  projection: GtaoProjection,
): GtaoVec3 {
  const ndcX = ((x + 0.5) / width) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / height) * 2;
  if (projection.kind === 'orthographic') {
    const bounds = projection.bounds;
    if (bounds === undefined) throw new Error('orthographic projection requires bounds');
    return [
      bounds.left + ((x + 0.5) / width) * (bounds.right - bounds.left),
      bounds.top - ((y + 0.5) / height) * (bounds.top - bounds.bottom),
      negativeViewZ,
    ];
  }
  const f = 1 / Math.tan((projection.fovY ?? 0) / 2);
  return [
    (ndcX * -negativeViewZ * projection.aspect) / f,
    (ndcY * -negativeViewZ) / f,
    negativeViewZ,
  ];
}

/** X12/Y12 octahedral material normal codec from the current SceneData schema. */
export function encodeMaterialNormalX12Y12(normal: GtaoVec3): number {
  const n = normalize(normal);
  let x = n[0] / (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  let y = n[1] / (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  if (n[2] < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  const px = Math.round(Math.max(0, Math.min(1, x * 0.5 + 0.5)) * 4095);
  const py = Math.round(Math.max(0, Math.min(1, y * 0.5 + 0.5)) * 4095);
  return (px | (py << 12)) >>> 0;
}

export function decodeMaterialNormalX12Y12(packed: number): GtaoVec3 {
  const x = (packed & 4095) * (2 / 4095) - 1;
  const y = ((packed >>> 12) & 4095) * (2 / 4095) - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const fold = Math.max(-z, 0);
  const normal: GtaoVec3 = [x + (x >= 0 ? -fold : fold), y + (y >= 0 ? -fold : fold), z];
  return normalize(normal);
}

export function normalAngularError(left: GtaoVec3, right: GtaoVec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(left), normalize(right)))));
}

/** Decode normalized RGB sample data with the production RG plus reconstructed-positive-Z contract. */
export function decodeTangentNormalRgSample(sample: readonly [number, number, number]): GtaoVec3 {
  const x = sample[0] * 2 - 1;
  const y = sample[1] * 2 - 1;
  return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
}

/** Compare the packed world-normal target to independently ray-hit/material-map normals. */
export function materialNormalFieldMetrics(
  field: GtaoSurfaceField,
  packedBytes: Uint8Array,
): GtaoNormalFieldMetrics {
  if (packedBytes.byteLength !== field.width * field.height * 4) {
    throw new Error('packed material normal target size does not match the reference field');
  }
  const view = new DataView(packedBytes.buffer, packedBytes.byteOffset, packedBytes.byteLength);
  let count = 0;
  let maxAngularRadians = 0;
  let squareSum = 0;
  let maxError: GtaoNormalFieldMetrics['maxError'];
  let firstMismatch: GtaoNormalFieldMetrics['firstMismatch'];
  for (let index = 0; index < field.worldNormals.length; index += 1) {
    const normal = field.worldNormals[index];
    if (normal === undefined) continue;
    const x = index % field.width;
    const y = Math.floor(index / field.width);
    const byteOffset = index * 4;
    const actual = view.getUint32(byteOffset, true);
    const expected = encodeMaterialNormalX12Y12(normal);
    const error = normalAngularError(normal, decodeMaterialNormalX12Y12(actual & 0x00ff_ffff));
    count += 1;
    if (error > maxAngularRadians || maxError === undefined) {
      maxAngularRadians = error;
      maxError = {
        x,
        y,
        expectedLow24: expected & 0x00ff_ffff,
        actualLow24: actual & 0x00ff_ffff,
        angularRadians: error,
      };
    }
    squareSum += error * error;
    const expectedLow24 = expected & 0x00ff_ffff;
    const actualLow24 = actual & 0x00ff_ffff;
    if (actualLow24 !== expectedLow24) {
      firstMismatch ??= { x, y, expected, actual };
    }
  }
  return {
    count,
    maxAngularRadians,
    rmsAngularRadians: Math.sqrt(squareSum / Math.max(count, 1)),
    ...(maxError === undefined ? {} : { maxError }),
    ...(firstMismatch === undefined ? {} : { firstMismatch }),
  };
}

function octEncode8(normal: GtaoVec3): readonly [number, number] {
  const n = normalize(normal);
  let x = n[0] / (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  let y = n[1] / (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  if (n[2] < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  return [Math.round((x * 0.5 + 0.5) * 255), Math.round((y * 0.5 + 0.5) * 255)];
}

function octDecode8(xByte: number, yByte: number): GtaoVec3 {
  const x = (xByte / 255) * 2 - 1;
  const y = (yByte / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const fold = Math.max(-z, 0);
  return normalize([x + (x >= 0 ? -fold : fold), y + (y >= 0 ? -fold : fold), z]);
}

function quantizeUnorm8(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

function rotationForPixel(x: number, y: number, height: number): number {
  const index = ((height - 1 - y) % 5) * 5 + (x % 5);
  const angle = (2 * PI * (MAGIC_SQUARE[index] ?? 1)) / 25;
  const encodedX = Math.floor((Math.cos(angle) * 0.5 + 0.5) * 255);
  const encodedY = Math.floor((Math.sin(angle) * 0.5 + 0.5) * 255);
  return Math.atan2((encodedY * 2) / 255 - 1, (encodedX * 2) / 255 - 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function samplePixel(
  uvX: number,
  uvY: number,
  width: number,
  height: number,
): readonly [number, number] | undefined {
  if (uvX < 0 || uvY < 0 || uvX >= 1 || uvY >= 1) return undefined;
  return [Math.floor(uvX * width), Math.floor(uvY * height)];
}

interface GtaoHorizonContext {
  readonly field: GtaoSurfaceField;
  readonly config: GtaoReferenceConfig;
  readonly position: GtaoVec3;
  readonly normal: GtaoVec3;
  readonly viewDir: GtaoVec3;
  readonly directionOnScreen: GtaoVec3;
  readonly x: number;
  readonly y: number;
  readonly stepCount: number;
  readonly horizons: number[];
}

function accumulateHorizonSample(
  context: GtaoHorizonContext,
  stepIndex: number,
  side: number,
): void {
  const { field, config, position, normal, viewDir, directionOnScreen, x, y, horizons } = context;
  const t = ((stepIndex + 1) / context.stepCount) ** config.distanceExponent;
  const sign = side === 1 ? -1 : 1;
  const probe = add(position, scale(directionOnScreen, sign * config.radius * t));
  const [clipX, clipY, clipW] = project(field.projection.matrix, probe);
  if (clipW <= 0) return;
  const sampleUvX = (clipX / clipW) * 0.5 + 0.5;
  const sampleUvY = (clipY / clipW) * -0.5 + 0.5;
  const sample = samplePixel(sampleUvX, sampleUvY, field.width, field.height);
  if (sample === undefined || (sample[0] === x && sample[1] === y)) return;
  const samplePosition = field.positions[sample[1] * field.width + sample[0]];
  if (samplePosition === undefined) return;
  const delta = subtract(samplePosition, position);
  const distance = length(delta);
  const normalUncertainty = distance * (4.242641 / (4095 - 4.242641));
  if (
    distance <= 1e-5 ||
    dot(delta, normal) <= Math.max(config.bias, normalUncertainty) ||
    Math.abs(delta[2]) >= config.thickness
  )
    return;
  const falloff = 1 + (2 / (stepIndex + 2) - 1) * config.distanceFallOff;
  const cosine = dot(scale(delta, 1 / distance), viewDir);
  const current = horizons[side] ?? 0;
  horizons[side] = current + Math.max(0, (cosine - current) * falloff);
}

function updateSliceHorizons(context: GtaoHorizonContext): void {
  for (let stepIndex = 0; stepIndex < context.stepCount; stepIndex += 1) {
    for (let side = 0; side < 2; side += 1) {
      accumulateHorizonSample(context, stepIndex, side);
    }
  }
}

function integrateSliceOcclusion(
  phase: number,
  horizons: readonly number[],
  projectedLength: number,
) {
  const hNegative =
    phase + clamp(-Math.acos(clamp(horizons[1] ?? 0, -1, 1)) - phase, -PI / 2, PI / 2);
  const hPositive =
    phase + clamp(Math.acos(clamp(horizons[0] ?? 0, -1, 1)) - phase, -PI / 2, PI / 2);
  const open = cosineWeightedSliceQuadrature(
    phase,
    phase - PI / 2,
    phase + PI / 2,
    GTAO_ORACLE_SLICE_QUADRATURE_STEPS,
  );
  const blocked = cosineWeightedSliceQuadrature(
    phase,
    hNegative,
    hPositive,
    GTAO_ORACLE_SLICE_QUADRATURE_STEPS,
  );
  return projectedLength * Math.max(0, open - blocked);
}

function gtaoSliceOcclusion(
  field: GtaoSurfaceField,
  config: GtaoReferenceConfig,
  position: GtaoVec3,
  normal: GtaoVec3,
  viewDir: GtaoVec3,
  basisX: GtaoVec3,
  basisY: GtaoVec3,
  x: number,
  y: number,
  slice: number,
  sliceCount: number,
  stepCount: number,
  rotation: number,
): number {
  const angle = (slice * PI) / sliceCount + rotation;
  const tangent = add(scale(basisX, Math.cos(angle)), scale(basisY, Math.sin(angle)));
  const axis = cross(tangent, viewDir);
  const directionOnScreen = normalize(
    subtract(tangent, scale(viewDir, tangent[2] / Math.max(viewDir[2], 1e-5))),
  );
  const planeNormal = subtract(normal, scale(axis, dot(normal, axis)));
  const projectedLength = length(planeNormal);
  if (projectedLength < 1e-5) return 0;
  const phase = Math.atan2(dot(planeNormal, tangent), dot(planeNormal, viewDir));
  const horizons = [Math.cos(phase + PI / 2), Math.cos(phase - PI / 2)];
  updateSliceHorizons({
    field,
    config,
    position,
    normal,
    viewDir,
    directionOnScreen,
    x,
    y,
    stepCount,
    horizons,
  });
  return integrateSliceOcclusion(phase, horizons, projectedLength);
}

function gtaoAtPixel(
  field: GtaoSurfaceField,
  config: GtaoReferenceConfig,
  outputX: number,
  outputY: number,
): number {
  const uvX = (outputX + 0.5) / config.outputWidth;
  const uvY = (outputY + 0.5) / config.outputHeight;
  const centerPixel = samplePixel(uvX, uvY, field.width, field.height);
  if (centerPixel === undefined) return 1;
  const [x, y] = centerPixel;
  const index = y * field.width + x;
  const position = field.positions[index];
  const worldNormal = field.worldNormals[index];
  if (position === undefined || worldNormal === undefined) return 1;

  const normal = normalize(direction(field.view, worldNormal));
  const perspective = Math.abs(field.projection.matrix[15]) < 0.5;
  const viewDir: GtaoVec3 = perspective ? normalize(scale(position, -1)) : [0, 0, 1];
  const slices = config.sampleBudget >= 30 ? 5 : 3;
  const steps = Math.ceil(config.sampleBudget / slices);
  const rotation = rotationForPixel(x, y, field.height);
  const basisX = normalize(cross([0, 1, 0], viewDir));
  const basisY = cross(viewDir, basisX);
  let occlusion = 0;

  for (let slice = 0; slice < slices; slice += 1) {
    occlusion += gtaoSliceOcclusion(
      field,
      config,
      position,
      normal,
      viewDir,
      basisX,
      basisY,
      x,
      y,
      slice,
      slices,
      steps,
      rotation,
    );
  }

  const visibility = clamp(1 - occlusion / slices, 0, 1);
  const intensityApplied = config.intensity === 0 ? 1 : visibility ** config.intensity;
  return intensityApplied;
}

export function computeGtaoRawReference(
  field: GtaoSurfaceField,
  config: GtaoReferenceConfig,
): GtaoRawReference {
  const rgba = new Uint8Array(config.outputWidth * config.outputHeight * 4);
  for (let y = 0; y < config.outputHeight; y += 1) {
    for (let x = 0; x < config.outputWidth; x += 1) {
      const uvX = (x + 0.5) / config.outputWidth;
      const uvY = (y + 0.5) / config.outputHeight;
      const pixel = samplePixel(uvX, uvY, field.width, field.height);
      const index = pixel === undefined ? -1 : pixel[1] * field.width + pixel[0];
      const normal = index < 0 ? undefined : field.worldNormals[index];
      const encoded = octEncode8(normal ?? [0, 0, 1]);
      const offset = (y * config.outputWidth + x) * 4;
      rgba[offset] = quantizeUnorm8(gtaoAtPixel(field, config, x, y));
      rgba[offset + 1] = encoded[0];
      rgba[offset + 2] = encoded[1];
      rgba[offset + 3] = 255;
    }
  }
  return { width: config.outputWidth, height: config.outputHeight, rgba };
}

function viewZAtUv(field: GtaoSurfaceField, uvX: number, uvY: number): number | undefined {
  const pixel = samplePixel(uvX, uvY, field.width, field.height);
  if (pixel === undefined) return undefined;
  return field.positions[pixel[1] * field.width + pixel[0]]?.[2];
}

export function filterGtaoReference(
  field: GtaoSurfaceField,
  raw: GtaoRawReference,
  radius: number,
): Uint8Array {
  const result = new Uint8Array(raw.width * raw.height);
  const texelX = 1 / raw.width;
  const texelY = 1 / raw.height;
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      const uvX = (x + 0.5) / raw.width;
      const uvY = (y + 0.5) / raw.height;
      const z = viewZAtUv(field, uvX, uvY);
      if (z === undefined) {
        result[y * raw.width + x] = 255;
        continue;
      }
      const centerRawOffset = (y * raw.width + x) * 4;
      const centerNormal = octDecode8(
        raw.rgba[centerRawOffset + 1] ?? 128,
        raw.rgba[centerRawOffset + 2] ?? 128,
      );
      let total = 0;
      let weightSum = 0;
      for (let oy = -2; oy <= 2; oy += 1) {
        for (let ox = -2; ox <= 2; ox += 1) {
          const sampleUvX = uvX + ox * texelX;
          const sampleUvY = uvY + oy * texelY;
          if (sampleUvX < 0 || sampleUvY < 0 || sampleUvX > 1 || sampleUvY > 1) continue;
          const sampleZ = viewZAtUv(field, sampleUvX, sampleUvY);
          if (sampleZ === undefined) continue;
          const rawX = Math.min(raw.width - 1, Math.floor(sampleUvX * raw.width));
          const rawY = Math.min(raw.height - 1, Math.floor(sampleUvY * raw.height));
          const rawOffset = (rawY * raw.width + rawX) * 4;
          const sampleNormal = octDecode8(
            raw.rgba[rawOffset + 1] ?? 128,
            raw.rgba[rawOffset + 2] ?? 128,
          );
          const dz = Math.abs(sampleZ - z);
          const spatial = Math.exp(-(ox * ox + oy * oy) / 4);
          const depthWeight = Math.exp(-dz / Math.max(0.01, radius * 0.1));
          const normalWeight = Math.max(dot(sampleNormal, centerNormal), 0) ** 8;
          const weight = spatial * depthWeight * normalWeight;
          total += ((raw.rgba[rawOffset] ?? 255) / 255) * weight;
          weightSum += weight;
        }
      }
      result[y * raw.width + x] = quantizeUnorm8(total / Math.max(weightSum, 1e-5));
    }
  }
  return result;
}

export interface GtaoBilinearReferenceSample {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly tx: number;
  readonly ty: number;
  readonly texels: readonly [number, number, number, number];
  readonly weights: readonly [number, number, number, number];
  readonly value: number;
}

function finiteReferenceSample(values: ArrayLike<number>, index: number): number {
  const sample = values[index];
  if (typeof sample !== 'number' || !Number.isFinite(sample)) {
    throw new Error('bilinear GTAO reference samples must be finite');
  }
  return sample;
}

/** Independently sample normalized texel data with the production linear/clamp contract. */
export function sampleGtaoBilinearLinearClamp(
  values: ArrayLike<number>,
  width: number,
  height: number,
  u: number,
  v: number,
): GtaoBilinearReferenceSample {
  const expectedLength = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(expectedLength) ||
    values.length !== expectedLength ||
    !Number.isSafeInteger(values.length) ||
    !Number.isFinite(u) ||
    !Number.isFinite(v)
  ) {
    throw new Error('bilinear GTAO reference input has invalid dimensions or coordinates');
  }
  const sampleX = clamp(u * width - 0.5, 0, width - 1);
  const sampleY = clamp(v * height - 0.5, 0, height - 1);
  const x0 = Math.floor(sampleX);
  const x1 = Math.min(width - 1, x0 + 1);
  const y0 = Math.floor(sampleY);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = sampleX - x0;
  const ty = sampleY - y0;
  const texels = [
    finiteReferenceSample(values, y0 * width + x0),
    finiteReferenceSample(values, y0 * width + x1),
    finiteReferenceSample(values, y1 * width + x0),
    finiteReferenceSample(values, y1 * width + x1),
  ] as const;
  const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty] as const;
  return {
    x0,
    x1,
    y0,
    y1,
    tx,
    ty,
    texels,
    weights,
    value: texels.reduce((sum, texel, index) => sum + texel * (weights[index] ?? 0), 0),
  };
}

export function composeLinearLightingReference(input: {
  readonly indirect: GtaoVec3;
  readonly direct: GtaoVec3;
  readonly emissive: GtaoVec3;
  readonly screenVisibility: number;
  readonly materialOcclusion: number;
  readonly directLightingStrength: number;
}): GtaoVec3 {
  const directWeight = 1 + (input.screenVisibility - 1) * input.directLightingStrength;
  return [
    input.indirect[0] * input.materialOcclusion * input.screenVisibility +
      input.direct[0] * directWeight +
      input.emissive[0],
    input.indirect[1] * input.materialOcclusion * input.screenVisibility +
      input.direct[1] * directWeight +
      input.emissive[1],
    input.indirect[2] * input.materialOcclusion * input.screenVisibility +
      input.direct[2] * directWeight +
      input.emissive[2],
  ];
}

export function byteErrorMetrics(actual: Uint8Array, expected: Uint8Array): GtaoErrorMetrics {
  if (actual.length !== expected.length)
    throw new Error('GTAO byte arrays must have equal lengths');
  let maxAbsolute = 0;
  let absoluteSum = 0;
  let squareSum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    maxAbsolute = Math.max(maxAbsolute, delta);
    absoluteSum += delta;
    squareSum += delta * delta;
  }
  const count = actual.length;
  return {
    count,
    maxAbsolute,
    meanAbsolute: absoluteSum / Math.max(1, count),
    rms: Math.sqrt(squareSum / Math.max(1, count)),
  };
}

export function byteErrorsWithinBudget(
  actual: Uint8Array,
  expected: Uint8Array,
  budget: {
    readonly maximum: number;
    readonly rms: number;
  },
): boolean {
  const metrics = byteErrorMetrics(actual, expected);
  return metrics.maxAbsolute <= budget.maximum && metrics.rms <= budget.rms;
}

interface BoxSceneFieldInput {
  readonly width: number;
  readonly height: number;
  readonly fovY: number;
  readonly near: number;
  readonly far: number;
  readonly projection?:
    | { readonly kind: 'perspective'; readonly fovY: number }
    | {
        readonly kind: 'orthographic';
        readonly left: number;
        readonly right: number;
        readonly bottom: number;
        readonly top: number;
      };
  /** Normalized RGB texel sample; Standard tangent normals decode RG and reconstruct positive Z. */
  readonly normalTextureSample?: readonly [number, number, number];
  readonly boxes: readonly {
    readonly center: GtaoVec3;
    readonly size: GtaoVec3;
    readonly normalTextureSample?: readonly [number, number, number];
    readonly alphaMask?: {
      readonly width: number;
      readonly height: number;
      /** Normalized green-channel texels, sampled with the material's linear default sampler. */
      readonly green: readonly number[];
      readonly cutoff: number;
    };
  }[];
}

type BoxSceneProjection = NonNullable<BoxSceneFieldInput['projection']>;
type BoxScene = BoxSceneFieldInput['boxes'][number];

interface SceneRay {
  readonly origin: GtaoVec3;
  readonly direction: GtaoVec3;
}

interface RayBoxSlabs {
  near: number;
  far: number;
  nearAxis: number;
  nearSign: number;
}

interface RayBoxHit {
  readonly distance: number;
  readonly normal: GtaoVec3;
  readonly uv: readonly [number, number];
}

const BOX_FACE_UV = [
  { uAxis: 2, vAxis: 1, uSign: -1, vSign: 1 },
  { uAxis: 2, vAxis: 1, uSign: 1, vSign: 1 },
  { uAxis: 0, vAxis: 2, uSign: 1, vSign: 1 },
  { uAxis: 0, vAxis: 2, uSign: 1, vSign: -1 },
  { uAxis: 0, vAxis: 1, uSign: 1, vSign: 1 },
  { uAxis: 0, vAxis: 1, uSign: -1, vSign: 1 },
] as const;

function boxSceneProjection(
  input: BoxSceneFieldInput,
  request: BoxSceneProjection,
): GtaoProjection {
  return request.kind === 'orthographic'
    ? orthographicProjection(
        request.left,
        request.right,
        request.bottom,
        request.top,
        input.near,
        input.far,
      )
    : perspectiveProjection(input.width, input.height, request.fovY, input.near, input.far);
}

function rayForScenePixel(
  input: BoxSceneFieldInput,
  request: BoxSceneProjection,
  x: number,
  y: number,
): SceneRay {
  const ndcX = ((x + 0.5) / input.width) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / input.height) * 2;
  if (request.kind === 'orthographic') {
    return {
      origin: [
        request.left + ((x + 0.5) / input.width) * (request.right - request.left),
        request.top - ((y + 0.5) / input.height) * (request.top - request.bottom),
        0,
      ],
      direction: [0, 0, -1],
    };
  }
  return {
    origin: [0, 0, 0],
    direction: normalize([
      ((ndcX * input.width) / input.height) * Math.tan(input.fovY / 2),
      ndcY * Math.tan(input.fovY / 2),
      -1,
    ]),
  };
}

function updateRayBoxSlab(
  slabs: RayBoxSlabs,
  axis: number,
  origin: GtaoVec3,
  direction: GtaoVec3,
  minimum: GtaoVec3,
  maximum: GtaoVec3,
): boolean {
  const axisOrigin = origin[axis] ?? 0;
  const component = direction[axis] ?? 0;
  const low = minimum[axis] ?? 0;
  const high = maximum[axis] ?? 0;
  if (Math.abs(component) < 1e-8) {
    if (axisOrigin < low || axisOrigin > high) {
      slabs.near = Number.POSITIVE_INFINITY;
      return false;
    }
    return true;
  }
  const a = low / component;
  const b = high / component;
  const axisNear = Math.min(a, b);
  const axisFar = Math.max(a, b);
  if (axisNear > slabs.near) {
    slabs.near = axisNear;
    slabs.nearAxis = axis;
    slabs.nearSign = a < b ? -1 : 1;
  }
  slabs.far = Math.min(slabs.far, axisFar);
  return true;
}

function intersectRayBox(
  origin: GtaoVec3,
  direction: GtaoVec3,
  tangentNormal: GtaoVec3,
  box: BoxScene,
): RayBoxHit | undefined {
  const minimum: GtaoVec3 = [
    box.center[0] - box.size[0] / 2,
    box.center[1] - box.size[1] / 2,
    box.center[2] - box.size[2] / 2,
  ];
  const maximum: GtaoVec3 = [
    box.center[0] + box.size[0] / 2,
    box.center[1] + box.size[1] / 2,
    box.center[2] + box.size[2] / 2,
  ];
  const slabs: RayBoxSlabs = {
    near: Number.NEGATIVE_INFINITY,
    far: Number.POSITIVE_INFINITY,
    nearAxis: 2,
    nearSign: 1,
  };
  for (let axis = 0; axis < 3; axis += 1) {
    if (!updateRayBoxSlab(slabs, axis, origin, direction, minimum, maximum)) return undefined;
  }
  if (slabs.near > slabs.far || slabs.far <= 0) return undefined;
  const distance = slabs.near > 0 ? slabs.near : slabs.far;
  const face = faceBasis(slabs.nearAxis, slabs.nearSign);
  const point = add(origin, scale(direction, distance));
  const faceUv = BOX_FACE_UV[slabs.nearAxis * 2 + (slabs.nearSign < 0 ? 1 : 0)];
  if (faceUv === undefined) throw new Error('invalid ray-box UV face');
  const local = subtract(point, box.center);
  const uv: readonly [number, number] = [
    0.5 + (faceUv.uSign * (local[faceUv.uAxis] ?? 0)) / (box.size[faceUv.uAxis] ?? 1),
    0.5 + (faceUv.vSign * (local[faceUv.vAxis] ?? 0)) / (box.size[faceUv.vAxis] ?? 1),
  ];
  return { distance, normal: mappedBoxNormal(face, tangentNormal), uv };
}

function mappedBoxNormal(face: ReturnType<typeof faceBasis>, tangentNormal: GtaoVec3): GtaoVec3 {
  const normal = face.normal;
  return normalize([
    face.tangent[0] * tangentNormal[0] +
      face.bitangent[0] * tangentNormal[1] +
      normal[0] * tangentNormal[2],
    face.tangent[1] * tangentNormal[0] +
      face.bitangent[1] * tangentNormal[1] +
      normal[1] * tangentNormal[2],
    face.tangent[2] * tangentNormal[0] +
      face.bitangent[2] * tangentNormal[1] +
      normal[2] * tangentNormal[2],
  ]);
}

function closestBoxHit(
  origin: GtaoVec3,
  direction: GtaoVec3,
  defaultNormalTextureSample: readonly [number, number, number],
  boxes: readonly BoxScene[],
): RayBoxHit | undefined {
  let closest = Number.POSITIVE_INFINITY;
  let hit: RayBoxHit | undefined;
  for (const box of boxes) {
    const tangentNormal = decodeTangentNormalRgSample(
      box.normalTextureSample ?? defaultNormalTextureSample,
    );
    const candidate = intersectRayBox(origin, direction, tangentNormal, box);
    if (candidate === undefined || candidate.distance >= closest || alphaMasked(box, candidate.uv))
      continue;
    closest = candidate.distance;
    hit = candidate;
  }
  return hit;
}

function alphaMasked(box: BoxScene, uv: readonly [number, number]): boolean {
  const mask = box.alphaMask;
  if (mask === undefined) return false;
  if (
    !Number.isSafeInteger(mask.width) ||
    !Number.isSafeInteger(mask.height) ||
    mask.width <= 0 ||
    mask.height <= 0 ||
    mask.green.length !== mask.width * mask.height
  ) {
    throw new Error('alpha-mask reference dimensions do not match its green-channel texels');
  }
  const alpha = sampleLinearGreen(mask, uv[0], uv[1]);
  return alpha <= mask.cutoff;
}

function sampleLinearGreen(mask: NonNullable<BoxScene['alphaMask']>, u: number, v: number): number {
  const x = Math.max(0, Math.min(mask.width - 1, u * mask.width - 0.5));
  const y = Math.max(0, Math.min(mask.height - 1, v * mask.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const texel = (column: number, row: number) => mask.green[row * mask.width + column] ?? 0;
  const top = texel(x0, y0) * (1 - tx) + texel(x1, y0) * tx;
  const bottom = texel(x0, y1) * (1 - tx) + texel(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Build a deterministic ray-box field for the shared production browser fixture. */
export function boxSceneField(input: BoxSceneFieldInput): GtaoSurfaceField {
  const requestedProjection = input.projection ?? { kind: 'perspective', fovY: input.fovY };
  const projection = boxSceneProjection(input, requestedProjection);
  const positions: (GtaoVec3 | undefined)[] = [];
  const worldNormals: (GtaoVec3 | undefined)[] = [];
  const normalTextureSample = input.normalTextureSample ?? [0.5, 0.5, 1];
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const ray = rayForScenePixel(input, requestedProjection, x, y);
      const hit = closestBoxHit(ray.origin, ray.direction, normalTextureSample, input.boxes);
      if (hit === undefined) {
        positions.push(undefined);
        worldNormals.push(undefined);
      } else {
        positions.push(add(ray.origin, scale(ray.direction, hit.distance)));
        worldNormals.push(hit.normal);
      }
    }
  }
  const identity: GtaoMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    width: input.width,
    height: input.height,
    positions,
    worldNormals,
    view: identity,
    projection,
  };
}
function faceBasis(
  axis: number,
  sign: number,
): {
  normal: GtaoVec3;
  tangent: GtaoVec3;
  bitangent: GtaoVec3;
} {
  const specs = [
    { u: 2, v: 1, uSign: -1, vSign: 1, w: 0 },
    { u: 2, v: 1, uSign: 1, vSign: 1, w: 0 },
    { u: 0, v: 2, uSign: 1, vSign: 1, w: 1 },
    { u: 0, v: 2, uSign: 1, vSign: -1, w: 1 },
    { u: 0, v: 1, uSign: 1, vSign: 1, w: 2 },
    { u: 0, v: 1, uSign: -1, vSign: 1, w: 2 },
  ] as const;
  const faceIndex = axis * 2 + (sign < 0 ? 1 : 0);
  const spec = specs[faceIndex];
  if (spec === undefined) throw new Error('invalid ray-box face');
  const normal: [number, number, number] = [0, 0, 0];
  normal[spec.w] = sign;
  const tangent: [number, number, number] = [0, 0, 0];
  tangent[spec.u] = spec.uSign;
  const vDirection: [number, number, number] = [0, 0, 0];
  vDirection[spec.v] = spec.vSign;
  const crossNormalTangent = cross(normal, tangent);
  const handedness = dot(crossNormalTangent, vDirection) >= 0 ? 1 : -1;
  return {
    normal,
    tangent,
    bitangent: scale(crossNormalTangent, handedness),
  };
}
