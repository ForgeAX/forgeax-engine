import {
  canonicalJson,
  err,
  ok,
  type Result,
  WATER_BODY_DEFAULT_FIXED_WATER_DEPTH_M,
} from '@forgeax/engine-types';
import { resolveWaterSplinePoints } from './body-spline.js';
import type {
  Vec2,
  Vec3,
  WaterBakedQueryGrid,
  WaterBakedQueryLineage,
  WaterBodySnapshot,
  WaterDependencySnapshot,
  WaterError,
  WaterWaveSetAsset,
  WaterWaveSource,
} from './contracts.js';
import { snapshotWaterBakedQueryGrid } from './contracts.js';
import { requireWaterValue } from './required-value.js';
export const WATER_WAVE_GRAVITY_M_PER_SEC2 = 9.8;
export const WATER_WAVE_EDGE_BLEND_WIDTH_M = 4;
export const WATER_WAVE_LWC_TILE_LENGTH_M = 20971.52;
export const WATER_WAVE_UPLOAD_CAPACITY = 4096;
export const WATER_BODY_DATA_STRIDE_BYTES = 128;
export const WATER_GERSTNER_WAVE_STRIDE_BYTES = 48;
export const WATER_BAKED_DESCRIPTOR_STRIDE_BYTES = 48;
const WATER_BAKED_DESCRIPTOR_VALID_OFFSET_BYTES = 44;

export function isWaterBakedSourceAvailable(descriptors: Uint8Array, bodyIndex: number): boolean {
  const offset = bodyIndex * WATER_BAKED_DESCRIPTOR_STRIDE_BYTES;
  return (
    Number.isSafeInteger(bodyIndex) &&
    bodyIndex >= 0 &&
    offset + WATER_BAKED_DESCRIPTOR_STRIDE_BYTES <= descriptors.byteLength &&
    new DataView(descriptors.buffer, descriptors.byteOffset, descriptors.byteLength).getUint32(
      offset + WATER_BAKED_DESCRIPTOR_VALID_OFFSET_BYTES,
      true,
    ) === 1
  );
}
/** Submitted source access; material static choices independently select sampled fields. */
export type WaterBodyHeightSourceMode =
  | Readonly<{
      kind: 'fixed';
    }>
  | Readonly<{
      kind: 'water-info';
      zoneIndex: number;
      slice: number;
    }>
  | Readonly<{
      kind: 'baked';
      zoneIndex: number;
      slice: number;
    }>;
export type WaterBodyHeightSource = WaterBodyHeightSourceMode &
  Readonly<{
    /** Body constants retained independently of the selected texture-backed sample source. */
    fixedHeightM: number;
    fixedDepthM: number;
    fixedVelocityXZ: Vec2;
  }>;
export function waterBodyOwnerKey(
  worldIdentity: string,
  bodyGuid: string,
  bodyGeneration: number,
  zoneGeneration: number,
): string {
  if (
    typeof worldIdentity !== 'string' ||
    !worldIdentity ||
    !bodyGuid ||
    !Number.isSafeInteger(bodyGeneration) ||
    bodyGeneration < 0 ||
    bodyGeneration > 4294967295 ||
    !Number.isSafeInteger(zoneGeneration) ||
    zoneGeneration < 0 ||
    zoneGeneration > 4294967295
  )
    throw new RangeError(
      'Water body owner keys require stable World identity and unsigned body/Zone generations',
    );
  return JSON.stringify([worldIdentity, bodyGuid, bodyGeneration, zoneGeneration]);
}
export type CookedGerstnerWave = Readonly<{
  directionXZ: Vec2;
  amplitudeM: number;
  wavelengthM: number;
  steepness: number;
  kPerM: number;
  omegaPerSec: number;
  gpuQ: number;
  cpuQM: number;
  maxHeightM: number;
}>;
export type CookedGerstnerWaveSet = Readonly<{
  inputDigest: string;
  waves: readonly CookedGerstnerWave[];
  depthMaskM: number;
  maxWaveHeightM: number;
  timeSource: WaterWaveSetAsset['timeSource'];
}>;
export type WaterBodyData = Readonly<{
  firstWave: number;
  waveCount: number;
  bodyGeneration: number;
  flags: number;
  timeSeconds: number;
  previousTimeSeconds: number;
  depthMaskM: number;
  maxWaveHeightM: number;
  tileOriginHighXZ: Vec2;
  tileOriginLowXZ: Vec2;
  tileLengthM: number;
  edgeBlendWidthM: number;
  baseHeightM: number;
  heightSource: WaterBodyHeightSource;
  dynamicBoundsCenterExtentXZ?: readonly [number, number, number, number];
}>;
/** Split phase origin shared by CPU wave evaluation and WaterMesh tile uploads. */
export function waterBodyWaveOriginXZ(snapshot: WaterBodySnapshot): Vec2 {
  const localY =
    snapshot.asset.baseHeightM +
    (snapshot.asset.type === 'ocean' ? (snapshot.asset.heightOffsetM ?? 0) : 0);
  return [
    requireWaterValue(snapshot.worldMatrixM[4]) * localY +
      requireWaterValue(snapshot.worldMatrixM[12]),
    requireWaterValue(snapshot.worldMatrixM[6]) * localY +
      requireWaterValue(snapshot.worldMatrixM[14]),
  ];
}
export type WaterWaveUploadBody = Readonly<{
  worldId: number;
  worldIdentity: string;
  bodyGuid: string;
  waveSetGuid?: string;
  bodyGeneration: number;
  zoneGeneration: number;
  waveSet: CookedGerstnerWaveSet;
  timeSeconds: number;
  previousTimeSeconds: number;
  baseHeightM: number;
  tileOriginWorldXZ: Vec2;
  tileLengthM: number;
  heightSource: WaterBodyHeightSource;
  /** Actual bound Zone/view center and full extent; absence disables bounds clipping. */
  dynamicBoundsCenterExtentXZ?: readonly [number, number, number, number];
  supportsWaves: boolean;
  usesFlatSurfaceHeight: boolean;
  meshEdgeOverlayEnabled: boolean;
  bakedGrid?: WaterBakedQueryGrid;
}>;
export type WaterWaveUploadPlan = Readonly<{
  bodyData: readonly WaterBodyData[];
  waves: readonly CookedGerstnerWave[];
  bodyBuffer: Uint8Array;
  waveBuffer: Uint8Array;
  bodyIndices: ReadonlyMap<string, number>;
  bodyZoneGenerations: ReadonlyMap<string, number>;
  bakedDescriptorBuffer: Uint8Array;
  bakedSamplesBuffer: Uint8Array;
  /** Source identity and byte ranges for the exact packed Baked rows. */
  bakedSources: readonly WaterBakedUploadSource[];
}>;
export type WaterBakedUploadSource = Readonly<{
  readonly bodyIndex: number;
  readonly worldIdentity: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly zoneGeneration: number;
  /** Half-open byte range in the per-body descriptor buffer. */
  readonly descriptorRange: readonly [number, number];
  /** Half-open byte range in the RGBA32F sample buffer. */
  readonly sampleRange: readonly [number, number];
  readonly lineage?: WaterBakedQueryLineage;
}>;
export type WaterWaveUploadSnapshotContext = Readonly<{
  worldId: number;
  worldIdentity: string;
  timeSeconds: number;
  previousTimeSeconds: number;
  heightSource: WaterBodyHeightSourceMode;
  dynamicBoundsCenterExtentXZ?: readonly [number, number, number, number];
  meshEdgeOverlayEnabled?: boolean;
  bakedGrid?: WaterBakedQueryGrid;
  tileOriginWorldXZ?: Vec2;
}>;
function waterError(expected: string, hint: string, detail?: unknown): WaterError {
  return { code: 'invalid-source', expected, hint, ...(detail === undefined ? {} : { detail }) };
}
function validDynamicBounds(value: WaterWaveUploadBody['dynamicBoundsCenterExtentXZ']): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length === 4 &&
      [...value].every(
        (entry) => typeof entry === 'number' && Number.isFinite(Math.fround(entry)),
      ) &&
      Math.fround(value[2]) > 0 &&
      Math.fround(value[3]) > 0)
  );
}
function validHeightSource(source: WaterBodyHeightSource): boolean {
  if (
    !Array.isArray(source.fixedVelocityXZ) ||
    source.fixedVelocityXZ.length !== 2 ||
    ![source.fixedHeightM, source.fixedDepthM, ...source.fixedVelocityXZ].every(Number.isFinite) ||
    source.fixedDepthM < 0
  )
    return false;
  if (source.kind === 'fixed') return true;
  return (
    (source.kind === 'water-info' || source.kind === 'baked') &&
    [source.zoneIndex, source.slice].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295,
    )
  );
}
function fixedBodyHeightSource(
  snapshot: WaterBodySnapshot,
  mode: WaterBodyHeightSourceMode,
): WaterBodyHeightSource {
  const { asset, worldMatrixM: matrix } = snapshot;
  const first = resolveWaterSplinePoints(asset.spline)[0];
  const nonflat = asset.type === 'river' || asset.type === 'custom';
  const position = nonflat && first ? first.positionM : [0, asset.baseHeightM, 0];
  const heightOffsetM = asset.type === 'ocean' ? (asset.heightOffsetM ?? 0) : 0;
  const fixedHeightM =
    requireWaterValue(matrix[1]) * requireWaterValue(position[0]) +
    requireWaterValue(matrix[5]) * (requireWaterValue(position[1]) + heightOffsetM) +
    requireWaterValue(matrix[9]) * requireWaterValue(position[2]) +
    requireWaterValue(matrix[13]);
  let fixedVelocityXZ: Vec2 = [0, 0];
  if (first) {
    const tangent = first.leaveTangentM;
    const x =
      requireWaterValue(matrix[0]) * tangent[0] +
      requireWaterValue(matrix[4]) * tangent[1] +
      requireWaterValue(matrix[8]) * tangent[2];
    const y =
      requireWaterValue(matrix[1]) * tangent[0] +
      requireWaterValue(matrix[5]) * tangent[1] +
      requireWaterValue(matrix[9]) * tangent[2];
    const z =
      requireWaterValue(matrix[2]) * tangent[0] +
      requireWaterValue(matrix[6]) * tangent[1] +
      requireWaterValue(matrix[10]) * tangent[2];
    const length = Math.hypot(x, y, z);
    if (length > 1e-6)
      fixedVelocityXZ = [
        (x / length) * first.velocityMPerSec,
        (z / length) * first.velocityMPerSec,
      ];
  }
  return Object.freeze({
    ...mode,
    fixedHeightM,
    fixedDepthM:
      first?.depthM || (asset.fixedWaterDepthM ?? WATER_BODY_DEFAULT_FIXED_WATER_DEPTH_M),
    fixedVelocityXZ: Object.freeze(fixedVelocityXZ),
  });
}
function validCookedWave(wave: CookedGerstnerWave): boolean {
  return (
    [
      ...wave.directionXZ,
      wave.amplitudeM,
      wave.wavelengthM,
      wave.steepness,
      wave.kPerM,
      wave.omegaPerSec,
      wave.gpuQ,
      wave.cpuQM,
      wave.maxHeightM,
    ].every(Number.isFinite) &&
    Math.hypot(...wave.directionXZ) > 0 &&
    wave.amplitudeM >= 0 &&
    wave.wavelengthM > 0 &&
    wave.maxHeightM >= 0
  );
}
export function cookGerstnerWaveSet(
  asset: WaterWaveSetAsset,
): Result<CookedGerstnerWaveSet, WaterError> {
  if (
    asset.kind !== 'water-wave-set' ||
    !Array.isArray(asset.waves) ||
    asset.waves.length === 0 ||
    !Number.isFinite(asset.depthMaskM) ||
    asset.depthMaskM < 0 ||
    !Number.isFinite(asset.maxWaveHeightM) ||
    asset.maxWaveHeightM < 0 ||
    typeof asset.inputDigest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(asset.inputDigest)
  ) {
    return err(
      waterError(
        'a non-empty admitted WaterWaveSet asset',
        'cook and validate the WaveSet before compiling its GPU ABI',
      ),
    );
  }
  const waves: CookedGerstnerWave[] = [];
  for (const wave of asset.waves) {
    const cooked = cookWave(wave);
    if (!cooked)
      return err(
        waterError(
          'finite waves with positive wavelength and non-zero direction',
          'repair the WaveSet asset before compiling the GPU ABI',
        ),
      );
    waves.push(cooked);
  }
  const amplitudeBound = waves.reduce((sum, wave) => sum + wave.maxHeightM, 0);
  if (!Number.isFinite(asset.maxWaveHeightM) || asset.maxWaveHeightM < amplitudeBound) {
    return err(
      waterError(
        'maxWaveHeightM at least the sum of wave amplitudes',
        'increase the authored conservative bound before publishing the WaveSet',
        { amplitudeBoundM: amplitudeBound, authoredMaxWaveHeightM: asset.maxWaveHeightM },
      ),
    );
  }
  return ok(
    Object.freeze({
      inputDigest: asset.inputDigest,
      waves: Object.freeze(waves),
      depthMaskM: asset.depthMaskM,
      maxWaveHeightM: asset.maxWaveHeightM,
      timeSource: asset.timeSource,
    }),
  );
}
/** Fixed only when the caller owns the Body and its detached dependency closure. */
export type WaterBodyWavePreparation = Readonly<{
  dependency: WaterDependencySnapshot | undefined;
  cooked: Result<CookedGerstnerWaveSet, WaterError> | undefined;
}>;

export function prepareWaterBodyWaves(
  snapshot: Pick<WaterBodySnapshot, 'asset' | 'dependencies'>,
): WaterBodyWavePreparation {
  const dependency = snapshot.asset.waveSetGuid
    ? snapshot.dependencies.find(
        (entry) => entry.field === 'waveSetGuid' && entry.guid === snapshot.asset.waveSetGuid,
      )
    : undefined;
  const payload = dependency?.payload;
  return Object.freeze({
    dependency,
    cooked:
      dependency?.status === 'valid' &&
      payload !== null &&
      typeof payload === 'object' &&
      'kind' in payload &&
      payload.kind === 'water-wave-set'
        ? cookGerstnerWaveSet(payload as WaterWaveSetAsset)
        : undefined,
  });
}
/** Fixes wave material inputs to the same immutable Body/dependency generation used by CPU queries. */
export function buildWaterWaveUploadBody(
  snapshot: WaterBodySnapshot,
  context: WaterWaveUploadSnapshotContext,
): Result<WaterWaveUploadBody, WaterError> {
  return buildPreparedWaterWaveUploadBody(snapshot, context);
}

/** Internal Admitted Body route; public borrowed snapshots always use live preparation. */
export function buildPreparedWaterWaveUploadBody(
  snapshot: WaterBodySnapshot,
  context: WaterWaveUploadSnapshotContext,
  preparation?: WaterBodyWavePreparation,
): Result<WaterWaveUploadBody, WaterError> {
  if (!validDynamicBounds(context.dynamicBoundsCenterExtentXZ))
    return err(
      waterError(
        'finite float32 Zone/view bounds with positive extents',
        'publish the exact accepted Zone/view bounds or omit bounds for an unbound Body',
      ),
    );
  const zoneGeneration = snapshot.binding.kind === 'bound' ? snapshot.binding.zoneGeneration : 0;
  const localY =
    snapshot.asset.baseHeightM +
    (snapshot.asset.type === 'ocean' ? (snapshot.asset.heightOffsetM ?? 0) : 0);
  const basePoint = [
    requireWaterValue(snapshot.worldMatrixM[4]) * localY +
      requireWaterValue(snapshot.worldMatrixM[12]),
    requireWaterValue(snapshot.worldMatrixM[5]) * localY +
      requireWaterValue(snapshot.worldMatrixM[13]),
    requireWaterValue(snapshot.worldMatrixM[6]) * localY +
      requireWaterValue(snapshot.worldMatrixM[14]),
  ];
  const tileOriginWorldXZ = context.tileOriginWorldXZ ?? waterBodyWaveOriginXZ(snapshot);
  let waveSet: CookedGerstnerWaveSet = Object.freeze({
    inputDigest: '0'.repeat(64),
    waves: Object.freeze([]),
    depthMaskM: 0,
    maxWaveHeightM: snapshot.asset.maxWaveHeightM,
    timeSource: 'scene-clock',
  });
  let supportsWaves = false;
  const prepareWaveClosure = () => {
    if (snapshot.asset.type !== 'river' && snapshot.asset.waveSetGuid) {
      const prepared = preparation ?? prepareWaterBodyWaves(snapshot);
      const dependency = prepared.dependency;
      if (
        dependency?.status !== 'valid' ||
        !dependency.payload ||
        (
          dependency.payload as {
            kind?: string;
          }
        ).kind !== 'water-wave-set'
      )
        return err({
          code: 'query-data-unavailable' as const,
          expected: `admitted WaveSet dependency ${snapshot.asset.waveSetGuid} in Body generation ${snapshot.sceneGeneration}`,
          hint: 'refresh the accepted Body dependency closure before preparing this view upload',
          detail: {
            status: dependency?.status ?? 'missing',
            bodyGeneration: snapshot.sceneGeneration,
          },
        });
      const cooked = prepared.cooked;
      if (cooked === undefined)
        return err(
          waterError('an admitted WaveSet payload', 'refresh the accepted Body dependency closure'),
        );
      if (!cooked.ok) return cooked;
      waveSet = cooked.value;
      if (
        snapshot.asset.maxWaveHeightM <
        waveSet.maxWaveHeightM + (snapshot.asset.maxWaveHeightOffsetM ?? 0)
      )
        return err(
          waterError(
            'Body maxWaveHeightM covering the WaveSet bound and authored component-bound offset',
            'increase the one total Body wave envelope; do not add the offset again in consumers',
          ),
        );
      supportsWaves = waveSet.waves.length > 0;
    }
    return undefined;
  };
  const waveFailure = prepareWaveClosure();
  if (waveFailure !== undefined) return waveFailure;
  const row: WaterWaveUploadBody = Object.freeze({
    worldId: context.worldId,
    worldIdentity: context.worldIdentity,
    bodyGuid: snapshot.guid,
    ...(snapshot.asset.type !== 'river' && snapshot.asset.waveSetGuid
      ? { waveSetGuid: snapshot.asset.waveSetGuid }
      : {}),
    bodyGeneration: snapshot.sceneGeneration,
    zoneGeneration,
    waveSet,
    timeSeconds: context.timeSeconds,
    previousTimeSeconds: context.previousTimeSeconds,
    baseHeightM: requireWaterValue(basePoint[1]),
    tileOriginWorldXZ,
    tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
    heightSource: fixedBodyHeightSource(snapshot, context.heightSource),
    ...(context.dynamicBoundsCenterExtentXZ === undefined
      ? {}
      : {
          dynamicBoundsCenterExtentXZ: Object.freeze([
            ...context.dynamicBoundsCenterExtentXZ,
          ]) as typeof context.dynamicBoundsCenterExtentXZ,
        }),
    supportsWaves,
    usesFlatSurfaceHeight: snapshot.asset.type !== 'river',
    meshEdgeOverlayEnabled: context.meshEdgeOverlayEnabled ?? false,
    ...(context.bakedGrid === undefined ? {} : { bakedGrid: context.bakedGrid }),
  });
  if (context.heightSource.kind === 'baked' && context.bakedGrid === undefined)
    return err({
      code: 'query-data-unavailable',
      expected: 'an accepted baked query grid for this body generation',
      hint: 'publish the baked grid before selecting the Baked GPU source',
      detail: { bodyGuid: snapshot.guid, bodyGeneration: snapshot.sceneGeneration },
    });
  return ok(row);
}
function cookWave(wave: WaterWaveSource): CookedGerstnerWave | undefined {
  const magnitude = Math.hypot(wave.directionXZ[0], wave.directionXZ[1]);
  if (
    !(magnitude > 0) ||
    !Number.isFinite(magnitude) ||
    !(wave.wavelengthM > 0) ||
    !Number.isFinite(wave.wavelengthM) ||
    !(wave.amplitudeM >= 0) ||
    !Number.isFinite(wave.amplitudeM) ||
    !Number.isFinite(wave.steepness)
  )
    return undefined;
  const directionXZ: Vec2 = [wave.directionXZ[0] / magnitude, wave.directionXZ[1] / magnitude];
  const kPerM = (Math.PI * 2) / wave.wavelengthM;
  const omegaPerSec = Math.sqrt(kPerM * WATER_WAVE_GRAVITY_M_PER_SEC2);
  const gpuQ = wave.amplitudeM === 0 ? 0 : wave.steepness / (wave.amplitudeM * kPerM);
  const cpuQM = wave.steepness / kPerM;
  const cooked: CookedGerstnerWave = {
    directionXZ,
    amplitudeM: wave.amplitudeM,
    wavelengthM: wave.wavelengthM,
    steepness: wave.steepness,
    kPerM,
    omegaPerSec,
    gpuQ,
    cpuQM,
    maxHeightM: wave.amplitudeM,
  };
  return validCookedWave(cooked) ? Object.freeze(cooked) : undefined;
}
export function waterWaveDepthAttenuation(depthM: number, depthMaskM: number): number {
  if (!(depthMaskM > 0)) return 1;
  return 1 - Math.exp(-Math.max(depthM, 0) / (depthMaskM / 2));
}
export type GerstnerEvaluation = Readonly<{
  displacementM: Vec3;
  normalYUp: Vec3;
  velocityMPerSec: Vec3;
}>;
type WaveSample = {
  phase: number;
  horizontalM: number;
  verticalM: number;
  derivativeX: Vec3;
  derivativeZ: Vec3;
  cpuNormalContribution: Vec3;
  velocityMPerSec: Vec3;
};
function phaseAt(positionXZ: Vec2, timeSeconds: number, wave: CookedGerstnerWave): number {
  const offsetX =
    positionXZ[0] -
    Math.floor(positionXZ[0] / WATER_WAVE_LWC_TILE_LENGTH_M + 0.5) * WATER_WAVE_LWC_TILE_LENGTH_M;
  const offsetZ =
    positionXZ[1] -
    Math.floor(positionXZ[1] / WATER_WAVE_LWC_TILE_LENGTH_M + 0.5) * WATER_WAVE_LWC_TILE_LENGTH_M;
  return (
    (offsetX * wave.directionXZ[0] + offsetZ * wave.directionXZ[1]) * wave.kPerM -
    wave.omegaPerSec * timeSeconds
  );
}
function waveSinCos(
  positionXZ: Vec2,
  timeSeconds: number,
  wave: CookedGerstnerWave,
): readonly [number, number] {
  const phase = phaseAt(positionXZ, timeSeconds, wave);
  let sine = Math.sin(phase);
  let cosine = Math.cos(phase);
  const offsetX =
    positionXZ[0] -
    Math.floor(positionXZ[0] / WATER_WAVE_LWC_TILE_LENGTH_M + 0.5) * WATER_WAVE_LWC_TILE_LENGTH_M;
  const offsetZ =
    positionXZ[1] -
    Math.floor(positionXZ[1] / WATER_WAVE_LWC_TILE_LENGTH_M + 0.5) * WATER_WAVE_LWC_TILE_LENGTH_M;
  const borderX = WATER_WAVE_LWC_TILE_LENGTH_M * 0.5 - Math.abs(offsetX);
  const borderZ = WATER_WAVE_LWC_TILE_LENGTH_M * 0.5 - Math.abs(offsetZ);
  if (borderX < WATER_WAVE_EDGE_BLEND_WIDTH_M || borderZ < WATER_WAVE_EDGE_BLEND_WIDTH_M) {
    const blend =
      Math.max(0, Math.min(1, borderX / WATER_WAVE_EDGE_BLEND_WIDTH_M)) *
      Math.max(0, Math.min(1, borderZ / WATER_WAVE_EDGE_BLEND_WIDTH_M));
    const blendPhase =
      (borderX * wave.directionXZ[0] + borderZ * wave.directionXZ[1]) * wave.kPerM -
      wave.omegaPerSec * timeSeconds;
    sine = Math.sin(blendPhase) + (sine - Math.sin(blendPhase)) * blend;
    cosine = Math.cos(blendPhase) + (cosine - Math.cos(blendPhase)) * blend;
  }
  return [sine, cosine];
}
function sampleWave(
  positionXZ: Vec2,
  timeSeconds: number,
  wave: CookedGerstnerWave,
  attenuation: number,
): WaveSample {
  const phase = phaseAt(positionXZ, timeSeconds, wave);
  const [sin, cos] = waveSinCos(positionXZ, timeSeconds, wave);
  const amplitude = wave.amplitudeM * attenuation;
  const horizontal = -wave.gpuQ * amplitude * sin;
  const vertical = amplitude * cos;
  const horizontalDerivative = -wave.gpuQ * amplitude * wave.kPerM * cos;
  const verticalDerivative = -amplitude * wave.kPerM * sin;
  const dx = wave.directionXZ[0];
  const dz = wave.directionXZ[1];
  return {
    phase,
    horizontalM: horizontal,
    verticalM: vertical,
    derivativeX: [
      horizontalDerivative * dx * dx,
      verticalDerivative * dx,
      horizontalDerivative * dx * dz,
    ],
    derivativeZ: [
      horizontalDerivative * dx * dz,
      verticalDerivative * dz,
      horizontalDerivative * dz * dz,
    ],
    cpuNormalContribution: [
      sin * wave.amplitudeM * wave.kPerM * dx,
      0,
      sin * wave.amplitudeM * wave.kPerM * dz,
    ],
    velocityMPerSec: [
      wave.gpuQ * amplitude * wave.omegaPerSec * cos * dx,
      amplitude * wave.omegaPerSec * sin,
      wave.gpuQ * amplitude * wave.omegaPerSec * cos * dz,
    ],
  };
}
function sampleCpuWave(
  positionXZ: Vec2,
  timeSeconds: number,
  wave: CookedGerstnerWave,
  attenuation: number,
): WaveSample {
  const phase = phaseAt(positionXZ, timeSeconds, wave);
  const [sin, cos] = waveSinCos(positionXZ, timeSeconds, wave);
  const amplitude = wave.amplitudeM * attenuation;
  const horizontal = -wave.cpuQM * sin;
  const vertical = amplitude * cos;
  const horizontalDerivative = -wave.cpuQM * wave.kPerM * cos;
  const verticalDerivative = -amplitude * wave.kPerM * sin;
  const dx = wave.directionXZ[0];
  const dz = wave.directionXZ[1];
  return {
    phase,
    horizontalM: horizontal,
    verticalM: vertical,
    derivativeX: [
      horizontalDerivative * dx * dx,
      verticalDerivative * dx,
      horizontalDerivative * dx * dz,
    ],
    derivativeZ: [
      horizontalDerivative * dx * dz,
      verticalDerivative * dz,
      horizontalDerivative * dz * dz,
    ],
    cpuNormalContribution: [
      sin * wave.amplitudeM * wave.kPerM * dx,
      0,
      sin * wave.amplitudeM * wave.kPerM * dz,
    ],
    velocityMPerSec: [
      wave.cpuQM * attenuation * wave.omegaPerSec * cos * dx,
      amplitude * wave.omegaPerSec * sin,
      wave.cpuQM * attenuation * wave.omegaPerSec * cos * dz,
    ],
  };
}
export function evaluateGerstnerWavesGpuForward(input: {
  readonly waves: readonly CookedGerstnerWave[];
  readonly positionXZ: Vec2;
  readonly timeSeconds: number;
  readonly depthM: number;
  readonly depthMaskM: number;
}): GerstnerEvaluation {
  const attenuation = waterWaveDepthAttenuation(input.depthM, input.depthMaskM);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  for (const wave of input.waves) {
    const sample = sampleWave(input.positionXZ, input.timeSeconds, wave, attenuation);
    dx += sample.horizontalM * wave.directionXZ[0];
    dz += sample.horizontalM * wave.directionXZ[1];
    dy += sample.verticalM;
    vx += sample.velocityMPerSec[0];
    vy += sample.velocityMPerSec[1];
    vz += sample.velocityMPerSec[2];
    const [sine, cosine] = waveSinCos(input.positionXZ, input.timeSeconds, wave);
    const wka = wave.amplitudeM * attenuation * wave.kPerM;
    normalX += sine * wka * wave.directionXZ[0];
    normalY +=
      cosine * wave.steepness * Math.max(0, Math.min(1, (wave.amplitudeM * 50) / wave.wavelengthM));
    normalZ += sine * wka * wave.directionXZ[1];
  }
  let normal: Vec3 = [normalX, 1 - normalY, normalZ];
  const length = Math.hypot(...normal) || 1;
  normal = [normal[0] / length, normal[1] / length, normal[2] / length];
  return Object.freeze({
    displacementM: [dx, dy, dz],
    normalYUp: normal,
    velocityMPerSec: [vx, vy, vz],
  });
}
export function evaluateGerstnerWavesCpuSimple(
  input: Parameters<typeof evaluateGerstnerWavesGpuForward>[0],
): number {
  const attenuation = waterWaveDepthAttenuation(input.depthM, input.depthMaskM);
  return input.waves.reduce(
    (height, wave) =>
      height +
      wave.amplitudeM * attenuation * waveSinCos(input.positionXZ, input.timeSeconds, wave)[1],
    0,
  );
}
export function evaluateGerstnerWavesCpuFull(
  input: Parameters<typeof evaluateGerstnerWavesGpuForward>[0],
): GerstnerEvaluation {
  const attenuation = waterWaveDepthAttenuation(input.depthM, input.depthMaskM);
  let height = 0;
  let normalX = 0;
  let normalZ = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (const wave of input.waves) {
    const phase = phaseAt(input.positionXZ, input.timeSeconds, wave);
    let first = sampleCpuWave(input.positionXZ, input.timeSeconds, wave, attenuation);
    if (wave.cpuQM !== 0) {
      const twoPi = Math.PI * 2;
      const mappedPhase = phase >= 0 ? phase % twoPi : twoPi - Math.abs(phase % twoPi);
      const firstHalf = mappedPhase < Math.PI;
      const probe = firstHalf ? wave.cpuQM : -wave.cpuQM;
      const shifted: Vec2 = [
        input.positionXZ[0] + probe * wave.directionXZ[0],
        input.positionXZ[1] + probe * wave.directionXZ[1],
      ];
      let second = sampleCpuWave(shifted, input.timeSeconds, wave, attenuation);
      second.horizontalM += firstHalf ? wave.cpuQM : -wave.cpuQM;
      if (!firstHalf) [first, second] = [second, first];
      const denominator = second.horizontalM - first.horizontalM;
      const amount = -first.horizontalM / (denominator > 0 ? denominator : 1);
      const lerp = (a: number, b: number) => a + (b - a) * amount;
      height += lerp(first.verticalM, second.verticalM);
      normalX += lerp(first.cpuNormalContribution[0], second.cpuNormalContribution[0]);
      normalZ += lerp(first.cpuNormalContribution[2], second.cpuNormalContribution[2]);
      vx += lerp(first.velocityMPerSec[0], second.velocityMPerSec[0]);
      vy += lerp(first.velocityMPerSec[1], second.velocityMPerSec[1]);
      vz += lerp(first.velocityMPerSec[2], second.velocityMPerSec[2]);
    } else {
      height += first.verticalM;
      normalX += first.cpuNormalContribution[0];
      normalZ += first.cpuNormalContribution[2];
      vx += first.velocityMPerSec[0];
      vy += first.velocityMPerSec[1];
      vz += first.velocityMPerSec[2];
    }
  }
  let normal: Vec3 = [normalX, 1, normalZ];
  const norm = Math.hypot(...normal) || 1;
  normal = [normal[0] / norm, normal[1] / norm, normal[2] / norm];
  return Object.freeze({
    displacementM: [0, height, 0],
    normalYUp: normal,
    velocityMPerSec: [vx, vy, vz],
  });
}
export function buildWaterWaveUploadPlan(
  bodies: readonly WaterWaveUploadBody[],
): Result<WaterWaveUploadPlan, WaterError> {
  if (
    bodies.some(
      (body) =>
        !Number.isSafeInteger(body.worldId) ||
        body.worldId < 0 ||
        typeof body.worldIdentity !== 'string' ||
        !body.worldIdentity ||
        !body.bodyGuid ||
        typeof body.supportsWaves !== 'boolean' ||
        (body.waveSetGuid !== undefined && !body.waveSetGuid) ||
        (body.supportsWaves && !body.waveSetGuid) ||
        ![
          body.timeSeconds,
          body.previousTimeSeconds,
          body.baseHeightM,
          ...body.tileOriginWorldXZ,
          body.tileLengthM,
          body.waveSet.depthMaskM,
          body.waveSet.maxWaveHeightM,
        ].every(Number.isFinite) ||
        body.tileLengthM !== WATER_WAVE_LWC_TILE_LENGTH_M ||
        body.waveSet.depthMaskM < 0 ||
        body.waveSet.maxWaveHeightM < 0 ||
        !body.heightSource ||
        !validHeightSource(body.heightSource) ||
        typeof body.waveSet.inputDigest !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(body.waveSet.inputDigest) ||
        !body.waveSet.waves.every(validCookedWave),
    )
  )
    return err(
      waterError(
        'valid per-view body snapshots, finite time/LWC inputs, an explicit height source and the configured meter tile length',
        'reconcile body ownership and admit the fixed or same-generation WaterInfo/Baked source before wave upload',
      ),
    );
  const ownerKey = (body: WaterWaveUploadBody) =>
    waterBodyOwnerKey(body.worldIdentity, body.bodyGuid, body.bodyGeneration, body.zoneGeneration);
  const waveSetKey = (body: WaterWaveUploadBody) =>
    JSON.stringify([body.waveSetGuid ?? '', body.waveSet.inputDigest]);
  const ordered = [...bodies].sort((a, b) =>
    ownerKey(a) < ownerKey(b) ? -1 : ownerKey(a) > ownerKey(b) ? 1 : 0,
  );
  const seen = new Set<string>();
  const sharedWaveSets = new Map<
    string,
    {
      readonly waveSet: CookedGerstnerWaveSet;
      readonly signature: string;
      firstWave?: number;
    }
  >();
  const admitBodyOwnershipAndWaveSets = () => {
    for (const body of ordered) {
      const key = ownerKey(body);
      if (seen.has(key))
        return err(
          waterError(
            'unique World/body owner keys in a wave upload view',
            'deduplicate scene body identities before upload',
            { bodyGuid: key },
          ),
        );
      seen.add(key);
      if (!validDynamicBounds(body.dynamicBoundsCenterExtentXZ))
        return err(
          waterError(
            'finite float32 Zone/view bounds with positive extents',
            'publish the exact accepted Zone/view bounds or omit bounds for an unbound Body',
            { bodyGuid: key },
          ),
        );
      if (
        ![body.bodyGeneration, body.zoneGeneration].every(
          (value) => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295,
        )
      )
        return err(
          waterError(
            'body and Zone generations representable as unsigned 32-bit values',
            'reconcile the body and Zone snapshots before wave upload',
            {
              bodyGuid: key,
              bodyGeneration: body.bodyGeneration,
              zoneGeneration: body.zoneGeneration,
            },
          ),
        );
      if (
        ![
          body.timeSeconds,
          body.previousTimeSeconds,
          body.baseHeightM,
          ...body.tileOriginWorldXZ,
        ].every((value) => Number.isFinite(Math.fround(value)))
      )
        return err(
          waterError(
            'body times, base height and tile origin representable in the float32 shader ABI',
            'rebase the view origin before uploading wave data',
            { bodyGuid: key },
          ),
        );
      if (body.supportsWaves) {
        const key = waveSetKey(body);
        const signature = canonicalJson(body.waveSet);
        const shared = sharedWaveSets.get(key);
        if (shared && shared.signature !== signature)
          return err(
            waterError(
              'one immutable cooked WaveSet closure per WaveSet GUID and content digest in a view',
              'reconcile shared WaveSet references before building wave ranges',
              {
                worldId: body.worldId,
                waveSetGuid: body.waveSetGuid,
                waveSetDigest: body.waveSet.inputDigest,
                bodyGuid: body.bodyGuid,
              },
            ),
          );
        if (!shared) sharedWaveSets.set(key, { waveSet: body.waveSet, signature });
      }
    }
    return undefined;
  };
  const ownerFailure = admitBodyOwnershipAndWaveSets();
  if (ownerFailure !== undefined) return ownerFailure;
  const waves: CookedGerstnerWave[] = [];
  for (const [key, shared] of [...sharedWaveSets].sort(([a], [b]) => a.localeCompare(b))) {
    if (shared.waveSet.waves.length > WATER_WAVE_UPLOAD_CAPACITY)
      return err({
        code: 'wave-upload-capacity-exceeded',
        expected: `at most ${WATER_WAVE_UPLOAD_CAPACITY} waves in one unique WaveSet asset`,
        hint: 'reduce the WaveSet wave count; the engine never truncates an uploaded asset range',
        detail: {
          waveSetKey: key,
          waveCount: shared.waveSet.waves.length,
          capacity: WATER_WAVE_UPLOAD_CAPACITY,
        },
      } as WaterError);
    shared.firstWave = waves.length;
    waves.push(...shared.waveSet.waves);
  }
  const bodyData: WaterBodyData[] = [];
  const bodyIndices = new Map<string, number>();
  const bodyZoneGenerations = new Map<string, number>();
  const bakedDescriptors = new Uint8Array(
    Math.max(
      WATER_BAKED_DESCRIPTOR_STRIDE_BYTES,
      ordered.length * WATER_BAKED_DESCRIPTOR_STRIDE_BYTES,
    ),
  );
  const bakedSamples: number[] = [];
  const bakedSources: WaterBakedUploadSource[] = [];
  for (const body of ordered) {
    const shared = body.supportsWaves ? sharedWaveSets.get(waveSetKey(body)) : undefined;
    const firstWave = shared?.firstWave ?? waves.length;
    const highX = Math.floor(body.tileOriginWorldXZ[0] / body.tileLengthM + 0.5) * body.tileLengthM;
    const highZ = Math.floor(body.tileOriginWorldXZ[1] / body.tileLengthM + 0.5) * body.tileLengthM;
    const lowX = body.tileOriginWorldXZ[0] - highX;
    const lowZ = body.tileOriginWorldXZ[1] - highZ;
    if (![highX, highZ, lowX, lowZ].every((value) => Number.isFinite(Math.fround(value))))
      return err(
        waterError(
          'high/low LWC tile origin parts representable in float32',
          'rebase the view origin before preparing wave uploads',
          { bodyGuid: ownerKey(body), tileOriginWorldXZ: body.tileOriginWorldXZ },
        ),
      );
    const row = Object.freeze<WaterBodyData>({
      firstWave,
      waveCount: shared?.waveSet.waves.length ?? 0,
      bodyGeneration: body.bodyGeneration,
      flags:
        (body.supportsWaves ? 1 : 0) |
        (body.usesFlatSurfaceHeight ? 2 : 0) |
        (body.meshEdgeOverlayEnabled ? 4 : 0),
      timeSeconds: body.timeSeconds,
      previousTimeSeconds: body.previousTimeSeconds,
      depthMaskM: body.waveSet.depthMaskM,
      maxWaveHeightM: body.waveSet.maxWaveHeightM,
      tileOriginHighXZ: [highX, highZ],
      tileOriginLowXZ: [lowX, lowZ],
      tileLengthM: body.tileLengthM,
      edgeBlendWidthM: WATER_WAVE_EDGE_BLEND_WIDTH_M,
      baseHeightM: body.baseHeightM,
      heightSource: body.heightSource,
      ...(body.dynamicBoundsCenterExtentXZ === undefined
        ? {}
        : {
            dynamicBoundsCenterExtentXZ: Object.freeze([
              ...body.dynamicBoundsCenterExtentXZ,
            ]) as typeof body.dynamicBoundsCenterExtentXZ,
          }),
    });
    const appendBakedBodySource = () => {
      if (body.bakedGrid !== undefined || body.heightSource.kind === 'baked') {
        const grid = body.bakedGrid;
        const cellCount = grid ? grid.width * grid.height : 0;
        if (
          !grid ||
          !Number.isSafeInteger(grid.width) ||
          !Number.isSafeInteger(grid.height) ||
          grid.width < 3 ||
          grid.height < 3 ||
          !Number.isSafeInteger(cellCount) ||
          cellCount * 4 !== grid.samples.length ||
          cellCount > 4294967295 ||
          ![...grid.originXZ, grid.originY, ...grid.spacingXZ].every(
            (value) => Number.isFinite(value) && Number.isFinite(Math.fround(value)),
          ) ||
          grid.spacingXZ.some((value) => value <= 0) ||
          [...grid.samples].some(
            (value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)),
          ) ||
          bakedSamples.length / 4 + cellCount > 4294967295
        )
          return err(
            waterError(
              'a finite, dimensionally valid Baked grid for every Baked source body',
              'publish a valid grid from the accepted body generation before wave upload',
              { bodyGuid: ownerKey(body), bodyGeneration: body.bodyGeneration },
            ),
          );
        const acceptedGrid = snapshotWaterBakedQueryGrid(grid);
        const offset = bakedSamples.length / 4;
        const base = bodyData.length * WATER_BAKED_DESCRIPTOR_STRIDE_BYTES;
        const view = new DataView(bakedDescriptors.buffer);
        [
          acceptedGrid.originXZ[0],
          acceptedGrid.originXZ[1],
          acceptedGrid.spacingXZ[0],
          acceptedGrid.spacingXZ[1],
          acceptedGrid.originY,
          0,
          0,
          0,
        ].forEach((value, i) => {
          view.setFloat32(base + i * 4, value, true);
        });
        view.setUint32(base + 32, acceptedGrid.width, true);
        view.setUint32(base + 36, acceptedGrid.height, true);
        view.setUint32(base + 40, offset, true);
        view.setUint32(base + WATER_BAKED_DESCRIPTOR_VALID_OFFSET_BYTES, 1, true);
        for (const sample of acceptedGrid.samples) bakedSamples.push(sample);
        const descriptorEnd = base + WATER_BAKED_DESCRIPTOR_STRIDE_BYTES;
        const sampleStart = offset * 16;
        const sampleEnd = sampleStart + cellCount * 16;
        bakedSources.push(
          Object.freeze({
            bodyIndex: bodyData.length,
            worldIdentity: body.worldIdentity,
            bodyGuid: body.bodyGuid,
            bodyGeneration: body.bodyGeneration,
            zoneGeneration: body.zoneGeneration,
            descriptorRange: Object.freeze([base, descriptorEnd]) as readonly [number, number],
            sampleRange: Object.freeze([sampleStart, sampleEnd]) as readonly [number, number],
            ...(acceptedGrid.lineage === undefined ? {} : { lineage: acceptedGrid.lineage }),
          }),
        );
      }
      return undefined;
    };
    const bakedFailure = appendBakedBodySource();
    if (bakedFailure !== undefined) return bakedFailure;
    const key = ownerKey(body);
    bodyIndices.set(key, bodyData.length);
    bodyZoneGenerations.set(key, body.zoneGeneration);
    bodyData.push(row);
  }
  return ok(
    Object.freeze({
      bodyData: Object.freeze(bodyData),
      waves: Object.freeze(waves),
      bodyBuffer: packWaterBodyData(bodyData),
      waveBuffer: packCookedGerstnerWaves(waves),
      bodyIndices,
      bodyZoneGenerations,
      bakedDescriptorBuffer: bakedDescriptors,
      bakedSamplesBuffer: new Uint8Array(new Float32Array(bakedSamples).buffer),
      bakedSources: Object.freeze(bakedSources),
    }),
  );
}
export function packWaterBodyData(rows: readonly WaterBodyData[]): Uint8Array {
  const bytes = new Uint8Array(rows.length * WATER_BODY_DATA_STRIDE_BYTES);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, index) => {
    const base = index * WATER_BODY_DATA_STRIDE_BYTES;
    view.setUint32(base, row.firstWave, true);
    view.setUint32(base + 4, row.waveCount, true);
    view.setUint32(base + 8, row.bodyGeneration, true);
    view.setUint32(base + 12, row.flags, true);
    const sourceKind =
      row.heightSource.kind === 'fixed' ? 0 : row.heightSource.kind === 'water-info' ? 1 : 2;
    [
      row.timeSeconds,
      row.previousTimeSeconds,
      row.depthMaskM,
      row.maxWaveHeightM,
      ...row.tileOriginHighXZ,
      0,
      0,
      ...row.tileOriginLowXZ,
      0,
      0,
      row.tileLengthM,
      row.edgeBlendWidthM,
      row.baseHeightM,
      0,
      row.heightSource.fixedHeightM,
      row.heightSource.fixedDepthM,
      row.heightSource.fixedVelocityXZ[0],
      row.heightSource.fixedVelocityXZ[1],
    ].forEach((value, scalar) => {
      view.setFloat32(base + 16 + scalar * 4, value, true);
    });
    const zoneIndex = row.heightSource.kind === 'fixed' ? 0 : row.heightSource.zoneIndex;
    const slice = row.heightSource.kind === 'fixed' ? 0 : row.heightSource.slice;
    const modeFlags = (row.flags & 1) | (sourceKind << 1);
    view.setUint32(base + 96, modeFlags, true);
    view.setUint32(base + 100, zoneIndex, true);
    view.setUint32(base + 104, slice, true);
    view.setUint32(base + 108, 0, true);
    row.dynamicBoundsCenterExtentXZ?.forEach((value, scalar) => {
      view.setFloat32(base + 112 + scalar * 4, value, true);
    });
  });
  return bytes;
}
export function packCookedGerstnerWaves(waves: readonly CookedGerstnerWave[]): Uint8Array {
  const bytes = new Uint8Array(waves.length * WATER_GERSTNER_WAVE_STRIDE_BYTES);
  const view = new DataView(bytes.buffer);
  waves.forEach((wave, index) => {
    const base = index * WATER_GERSTNER_WAVE_STRIDE_BYTES;
    [
      wave.directionXZ[0],
      wave.directionXZ[1],
      wave.amplitudeM,
      wave.wavelengthM,
      wave.steepness,
      wave.kPerM,
      wave.omegaPerSec,
      wave.gpuQ,
      wave.cpuQM,
      wave.maxHeightM,
      0,
      0,
    ].forEach((value, scalar) => {
      view.setFloat32(base + scalar * 4, value, true);
    });
  });
  return bytes;
}
