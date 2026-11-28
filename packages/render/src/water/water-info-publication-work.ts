import type { BindGroupLayoutEntry } from '@forgeax/engine-types';

import { err, type MaterialRenderState, ok, type Result } from '@forgeax/engine-types';

import {
  buildWaterWaveUploadPlan,
  snapshotWaterBakedQueryGrid,
  snapshotWaterBakedQueryLineage,
  validateWaterAsset,
  WATER_BODY_DATA_STRIDE_BYTES,
  type WaterDependencyLoadFailure,
  type WaterInfoContext,
  type WaterInfoSliceAllocator,
  type WaterSystem,
  type WaterWaveUploadBody,
  type WaterWaveUploadPlan,
  type WaterZoneSnapshot,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';

import { requireWaterValue } from '@forgeax/engine-water/internal';

import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';

import type {
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../features/plan';

import type { RenderFeatureGraphResourceState } from '../features/types';

import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';

import type { WaterGpuMeshZone } from './gpu-mesh-source';

import {
  encodeWaterInfoGpuZoneParams,
  type WaterInfoGpuZoneParams,
  waterInfoBlurWgsl,
  waterInfoClearWgsl,
  waterInfoFinalizeWgsl,
  waterInfoMergeWgsl,
} from './water-info-producer';

export const WATER_INFO_FEATURE_IDENTITY = 'water-info-producer';

export const MAX_WATER_INFO_SLICES = 256;

export const MAX_VELOCITY_M_PER_SEC = 10.24;

export const UNDERGROUND_DILATION_OFFSET_M = 0.64;

const WORKGROUP = 8;

const WATER_INFO_RETAIN_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@compute @workgroup_size(1, 1, 1)
fn retain(@builtin(global_invocation_id) id: vec3<u32>) {
  let value = textureLoad(source, vec2<i32>(0), 0, 0);
  if (id.x == 0xffffffffu) { _ = value; }
}
`;

export interface WaterInfoDescriptorRow {
  readonly ownerKey: string;
  readonly worldId: number;
  readonly worldIdentity: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly outputGeneration: number;
  readonly zoneGuid: string;
  readonly zoneGeneration: number;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
  readonly targetName: string;
  readonly targetFormat: 'rgba16float' | 'rgba32float';
  readonly slice: number;
  readonly descriptor: Uint8Array;
  readonly context: WaterInfoContext;
}

export type WaterInfoSourceAvailability = Readonly<{
  bodyGuid: string;
  bodyGeneration: number;
  field: string;
  guid?: string;
}> &
  (
    | Readonly<{ kind: 'pending'; guid: string }>
    | Readonly<{ kind: 'failed'; failure: WaterDependencyLoadFailure }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'incompatible'; actualKind?: string }>
  );

export interface WaterInfoFramePublication {
  readonly viewIdentity: string;
  readonly frameGeneration: number;
  readonly deviceGeneration: number;
  readonly graphResourceVersion: string;
  readonly targets: readonly Readonly<{
    targetName: string;
    targetFormat: 'rgba16float' | 'rgba32float';
    bank: 0 | 1;
    epoch: number;
    write: boolean;
    sourceDigest: string;
    contentFrameGeneration: number;
    width: number;
    height: number;
    layers: number;
    graphResourceVersion: string;
  }>[];
  readonly rows: ReadonlyMap<string, WaterInfoDescriptorRow>;
  readonly waterInfoAvailability: ReadonlyMap<string, WaterInfoSourceAvailability>;
  readonly waveBodies: readonly WaterWaveUploadBody[];
  readonly waveUploadPlan: WaterWaveUploadPlan;
  /** Flat target cohorts still consumed by accepted CPU mesh proxies. */
  readonly bindingSnapshots?: readonly WaterInfoBindingSnapshot[];
  readonly gpuMeshes?: readonly WaterGpuMeshZone[];
}

export type WaterInfoBindingSnapshot = Pick<
  WaterInfoFramePublication,
  'targets' | 'rows' | 'waveBodies' | 'waveUploadPlan'
>;

export function waterInfoTargetBindingSnapshot(
  publication: WaterInfoBindingSnapshot,
  target: WaterInfoFramePublication['targets'][number],
  roster?: ReadonlyMap<string, WaterMeshProxyRef>,
  previousTimes?: ReadonlyMap<string, number>,
): Result<WaterInfoBindingSnapshot, RenderError> {
  const rows = new Map(
    [...publication.rows].filter(([, row]) => row.targetName === target.targetName),
  );
  const waveBodies = publication.waveBodies.flatMap((body) => {
    const ownerKey = waterBodyOwnerKey(
      body.worldIdentity,
      body.bodyGuid,
      body.bodyGeneration,
      body.zoneGeneration,
    );
    const row = rows.get(ownerKey);
    if (row === undefined) return [];
    const proxy = roster?.get(ownerKey);
    if (proxy === undefined) return [body];
    rows.set(ownerKey, Object.freeze({ ...row, worldId: proxy.worldId }));
    return [
      Object.freeze({
        ...body,
        worldId: proxy.worldId,
        timeSeconds: proxy.timeSeconds,
        previousTimeSeconds: previousTimes?.get(ownerKey) ?? body.timeSeconds,
      }),
    ];
  });
  const waveUploadPlan = buildWaterWaveUploadPlan(waveBodies);
  if (!waveUploadPlan.ok)
    return err(
      featureFailure('a complete per-target Water material cohort', {
        targetName: target.targetName,
        cause: waveUploadPlan.error,
      }),
    );
  return ok(
    Object.freeze({
      targets: Object.freeze([target]),
      rows,
      waveBodies: Object.freeze(waveBodies),
      waveUploadPlan: waveUploadPlan.value,
    }),
  );
}

/** Internal renderer route. A descriptor and every transition row share one target. */
export function waterInfoMaterialBindingSnapshots(
  publication: WaterInfoFramePublication,
): Result<readonly WaterInfoBindingSnapshot[], RenderError> {
  const snapshots: WaterInfoBindingSnapshot[] = [];
  const retainedNames = new Set<string>();
  for (const snapshot of publication.bindingSnapshots ?? []) {
    const target = snapshot.targets[0];
    if (
      target === undefined ||
      !publication.targets.some((row) => row.targetName === target.targetName)
    )
      continue;
    retainedNames.add(target.targetName);
    snapshots.push(snapshot);
  }
  for (const target of publication.targets) {
    if (retainedNames.has(target.targetName)) continue;
    const snapshot = waterInfoTargetBindingSnapshot(publication, target);
    if (!snapshot.ok) return snapshot;
    snapshots.push(snapshot.value);
  }
  const independent = publication.waveBodies.filter(
    // Fixed geometry can be read without the optional WaterInfo texture even
    // while another accepted draw retains a target row for this same Body.
    (body) =>
      body.heightSource.kind === 'fixed' ||
      !publication.rows.has(
        waterBodyOwnerKey(
          body.worldIdentity,
          body.bodyGuid,
          body.bodyGeneration,
          body.zoneGeneration,
        ),
      ),
  );
  if (independent.length > 0) {
    const waveUploadPlan = buildWaterWaveUploadPlan(independent);
    if (!waveUploadPlan.ok)
      return err(
        featureFailure('valid independent Water material inputs', { cause: waveUploadPlan.error }),
      );
    snapshots.push(
      Object.freeze({
        targets: Object.freeze([]),
        rows: new Map(),
        waveBodies: Object.freeze(independent),
        waveUploadPlan: waveUploadPlan.value,
      }),
    );
  }
  return ok(Object.freeze(snapshots));
}

export type WaterInfoPublicationContext = Omit<
  WaterInfoContext,
  'slice' | 'deviceGeneration' | 'frameGeneration' | 'graphResourceVersion'
>;

export type WaterInfoPublicationWaveBody = Omit<WaterWaveUploadBody, 'heightSource'> & {
  readonly heightSource: Omit<WaterWaveUploadBody['heightSource'], 'zoneIndex' | 'slice'>;
};

export interface WaterInfoWaterDraw {
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly firstVertex: number;
  readonly vertexCount: number;
  readonly material?: {
    readonly handle: number;
    readonly revision: number;
    readonly shader: string;
    readonly bindings: 'group-0' | 'render-material';
    readonly renderState: MaterialRenderState;
  };
}

export interface WaterInfoPublicationInput {
  readonly kind: 'forgeax-water-info-input';
  readonly version: 6;
  readonly sourceSession: string;
  readonly sourceFrameGeneration: number;
  readonly views: readonly WaterInfoPublicationInputView[];
}

export interface WaterInfoPublicationInputView {
  readonly viewIdentity: string;
  readonly sourceFrameGeneration: number;
  readonly gpuMeshes: readonly Omit<WaterGpuMeshZone, 'mesh' | 'indexCount'>[];
  readonly captures: readonly Readonly<{
    readonly worldId: number;
    readonly worldIdentity: string;
    readonly zoneGuid: string;
    readonly zone: WaterZoneSnapshot;
    readonly groundGeneration?: number;
    readonly context: WaterInfoPublicationContext;
    readonly captureZM: number;
    readonly waterVertices: Float32Array;
    readonly waterDraws?: readonly WaterInfoWaterDraw[];
    readonly groundVertices: Float32Array;
    readonly dilationVertices: Float32Array;
  }>[];
  readonly bodies: readonly (Readonly<{
    readonly ownerKey: string;
    readonly worldId: number;
    readonly worldIdentity: string;
    readonly bodyGuid: string;
    readonly bodyGeneration: number;
    readonly outputGeneration: number;
    readonly zoneGeneration: number;
    readonly waveBody: WaterInfoPublicationWaveBody;
  }> &
    (
      | Readonly<{
          kind: 'water-info';
          zoneGuid: string;
          targetFormat: 'rgba16float' | 'rgba32float';
        }>
      | Readonly<{
          kind: 'independent';
          zoneGuid?: never;
          targetFormat?: never;
          waterInfoAvailability?: WaterInfoSourceAvailability;
        }>
    ))[];
  readonly meshOwners: readonly Readonly<{
    readonly worldId: number;
    readonly worldIdentity: string;
    readonly timeSeconds: number;
    readonly owner: WaterMeshProxyOwner;
  }>[];
  readonly meshCandidates: readonly Readonly<{
    readonly worldId: number;
    readonly worldIdentity: string;
    readonly zoneGuid: string;
    readonly zoneGeneration: number;
    readonly waterInfoFormat: 'rgba16float' | 'rgba32float';
    readonly viewIdentity: string;
    readonly publicationGeneration: number;
    readonly sourceGenerations: Readonly<Record<string, number>>;
    readonly waterMeshOutputGenerations: Readonly<Record<string, number>>;
    readonly owners: readonly Readonly<{ bodyGuid: string; bodyGeneration: number }>[];
  }>[];
}

export interface WaterInfoSourceFeedback {
  readonly kind: 'forgeax-water-info-submitted';
  readonly sourceSession: string;
  readonly sourceFrameGeneration: number;
  readonly views: readonly Readonly<{
    readonly viewIdentity: string;
    readonly receiverFrameGeneration: number;
    readonly deviceGeneration: number;
    readonly targets: readonly Readonly<{
      readonly targetName: string;
      readonly targetFormat: 'rgba16float' | 'rgba32float';
      readonly sourceDigest: string;
      readonly write: boolean;
    }>[];
    readonly bodies: readonly Readonly<{
      readonly ownerKey: string;
      readonly bodyGeneration: number;
      readonly outputGeneration: number;
      readonly zoneGeneration: number;
    }>[];
    readonly meshCandidates: readonly Readonly<{
      readonly worldIdentity: string;
      readonly zoneGuid: string;
      readonly zoneGeneration: number;
      readonly publicationGeneration: number;
    }>[];
  }>[];
}

export const WATER_INFO_RASTER_WATER_ID = 'forgeax::water-info-raster-water';

export const WATER_INFO_RASTER_GROUND_ID = 'forgeax::water-info-raster-ground';

export const WATER_INFO_RASTER_DILATION_ID = 'forgeax::water-info-raster-dilation';

export interface WaterInfoPublicationState {
  readonly pending: Map<string, WaterInfoFramePublication>;
  readonly submitted: Map<string, WaterInfoFramePublication>;
  readonly bodyTimes: Map<string, Map<string, number>>;
  readonly reservations: Map<string, ReadonlySet<string>>;
  readonly history: Map<string, WaterInfoTargetHistory>;
  readonly captureCache: Map<
    string,
    Readonly<{ key: string; capture: DirectWaterInfoZoneCapture }>
  >;
}

interface WaterInfoTargetHistory {
  readonly owner: object | undefined;
  readonly activeTargets: Map<'rgba16float' | 'rgba32float', WaterInfoPublicationTarget>;
  publication?: WaterInfoFramePublication;
}

export const publicationStates = new WeakMap<object, WaterInfoPublicationState>();

export const publicationKey = (view: string, frame: number, device: number) =>
  JSON.stringify([view, device, frame]);

export const targetFormatForContext = (
  format: WaterInfoContext['format'],
): 'rgba16float' | 'rgba32float' => (format === 'rgba32f' ? 'rgba32float' : 'rgba16float');

const targetNameForFormat = (format: 'rgba16float' | 'rgba32float', epoch: number, bank: 0 | 1) =>
  `water-info-array-${format}-epoch-${epoch}-bank-${bank}`;

export function waterInfoTargetDigest(
  captures: readonly Readonly<{
    zoneGuid: string;
    context: Pick<WaterInfoPublicationContext, 'sourceDigest' | 'format'>;
  }>[],
  targetFormat: 'rgba16float' | 'rgba32float',
): string {
  const rows = captures
    .filter((capture) => targetFormatForContext(capture.context.format) === targetFormat)
    .map((capture) => [capture.zoneGuid, capture.context.sourceDigest] as const)
    .sort((left, right) =>
      JSON.stringify(left) < JSON.stringify(right)
        ? -1
        : JSON.stringify(left) > JSON.stringify(right)
          ? 1
          : 0,
    );
  return JSON.stringify(rows);
}

export const historyKey = (view: string, device: number) => JSON.stringify([view, device]);

/** Internal renderer fast path. Callers must treat the returned publication as read-only. */
export function waterInfoFramePublicationForRenderer(
  feature: object,
  viewIdentity: string,
  frameGeneration: number,
  deviceGeneration: number,
): WaterInfoFramePublication | undefined {
  const state = publicationStates.get(feature);
  return (
    state?.pending.get(publicationKey(viewIdentity, frameGeneration, deviceGeneration)) ??
    state?.submitted.get(publicationKey(viewIdentity, frameGeneration, deviceGeneration)) ??
    state?.history.get(historyKey(viewIdentity, deviceGeneration))?.publication
  );
}

export function cloneWaterWaveUploadBody(body: WaterWaveUploadBody): WaterWaveUploadBody {
  const waves = Object.freeze(
    body.waveSet.waves.map((wave) =>
      Object.freeze({
        ...wave,
        directionXZ: Object.freeze([...wave.directionXZ]) as typeof wave.directionXZ,
      }),
    ),
  );
  const waveSet = Object.freeze({ ...body.waveSet, waves });
  const heightSource = Object.freeze({
    ...body.heightSource,
    fixedVelocityXZ: Object.freeze([
      ...body.heightSource.fixedVelocityXZ,
    ]) as typeof body.heightSource.fixedVelocityXZ,
  });
  return Object.freeze({
    ...body,
    waveSet,
    heightSource,
    tileOriginWorldXZ: Object.freeze([...body.tileOriginWorldXZ]) as typeof body.tileOriginWorldXZ,
    ...(body.dynamicBoundsCenterExtentXZ === undefined
      ? {}
      : {
          dynamicBoundsCenterExtentXZ: Object.freeze([
            ...body.dynamicBoundsCenterExtentXZ,
          ]) as typeof body.dynamicBoundsCenterExtentXZ,
        }),
    ...(body.bakedGrid === undefined
      ? {}
      : { bakedGrid: snapshotWaterBakedQueryGrid(body.bakedGrid) }),
  });
}

function cloneWaterWaveUploadPlan(plan: WaterWaveUploadPlan): WaterWaveUploadPlan {
  return Object.freeze({
    bodyData: Object.freeze(
      plan.bodyData.map((row) =>
        Object.freeze({
          ...row,
          tileOriginHighXZ: Object.freeze([...row.tileOriginHighXZ]) as typeof row.tileOriginHighXZ,
          tileOriginLowXZ: Object.freeze([...row.tileOriginLowXZ]) as typeof row.tileOriginLowXZ,
          ...(row.dynamicBoundsCenterExtentXZ === undefined
            ? {}
            : {
                dynamicBoundsCenterExtentXZ: Object.freeze([
                  ...row.dynamicBoundsCenterExtentXZ,
                ]) as typeof row.dynamicBoundsCenterExtentXZ,
              }),
          heightSource: Object.freeze({
            ...row.heightSource,
            fixedVelocityXZ: Object.freeze([
              ...row.heightSource.fixedVelocityXZ,
            ]) as typeof row.heightSource.fixedVelocityXZ,
          }),
        }),
      ),
    ),
    waves: Object.freeze(
      plan.waves.map((wave) =>
        Object.freeze({
          ...wave,
          directionXZ: Object.freeze([...wave.directionXZ]) as typeof wave.directionXZ,
        }),
      ),
    ),
    bodyBuffer: new Uint8Array(plan.bodyBuffer),
    waveBuffer: new Uint8Array(plan.waveBuffer),
    bodyIndices: new Map(plan.bodyIndices),
    bodyZoneGenerations: new Map(plan.bodyZoneGenerations),
    bakedDescriptorBuffer: new Uint8Array(plan.bakedDescriptorBuffer),
    bakedSamplesBuffer: new Uint8Array(plan.bakedSamplesBuffer),
    bakedSources: Object.freeze(
      plan.bakedSources.map((source) => {
        const lineage = snapshotWaterBakedQueryLineage(source.lineage);
        return Object.freeze({
          ...source,
          descriptorRange: Object.freeze([
            ...source.descriptorRange,
          ]) as typeof source.descriptorRange,
          sampleRange: Object.freeze([...source.sampleRange]) as typeof source.sampleRange,
          ...(lineage === undefined ? {} : { lineage }),
        });
      }),
    ),
  });
}

function cloneWaterInfoBindingSnapshot(
  snapshot: WaterInfoBindingSnapshot,
): WaterInfoBindingSnapshot {
  return Object.freeze({
    targets: Object.freeze(snapshot.targets.map((target) => Object.freeze({ ...target }))),
    rows: new Map(
      [...snapshot.rows].map(([key, row]) => [
        key,
        Object.freeze({ ...row, descriptor: new Uint8Array(row.descriptor) }),
      ]),
    ),
    waveBodies: Object.freeze(snapshot.waveBodies.map(cloneWaterWaveUploadBody)),
    waveUploadPlan: cloneWaterWaveUploadPlan(snapshot.waveUploadPlan),
  });
}

/** Public read returns a detached publication so callers cannot mutate retained frame state. */
export function waterInfoFramePublication(
  feature: object,
  viewIdentity: string,
  frameGeneration: number,
  deviceGeneration: number,
): WaterInfoFramePublication | undefined {
  const publication = waterInfoFramePublicationForRenderer(
    feature,
    viewIdentity,
    frameGeneration,
    deviceGeneration,
  );
  if (publication === undefined) return undefined;
  const rows = new Map(
    [...publication.rows].map(([key, row]) => [
      key,
      Object.freeze({ ...row, descriptor: new Uint8Array(row.descriptor) }),
    ]),
  );
  return Object.freeze({
    ...publication,
    targets: Object.freeze(publication.targets.map((target) => Object.freeze({ ...target }))),
    rows,
    waterInfoAvailability: new Map(
      [...publication.waterInfoAvailability].map(([key, value]) => [key, structuredClone(value)]),
    ),
    waveBodies: Object.freeze(publication.waveBodies.map(cloneWaterWaveUploadBody)),
    waveUploadPlan: cloneWaterWaveUploadPlan(publication.waveUploadPlan),
    ...(publication.bindingSnapshots === undefined
      ? {}
      : {
          bindingSnapshots: Object.freeze(
            publication.bindingSnapshots.map(cloneWaterInfoBindingSnapshot),
          ),
        }),
  });
}

interface WaterInfoZoneCaptureBase {
  readonly worldId: number;
  readonly worldIdentity: string;
  readonly zoneGuid: string;
  readonly zone: WaterZoneSnapshot;
  readonly groundGeneration?: number;
  readonly context: WaterInfoContext;
  readonly reservation: NonNullable<ReturnType<WaterInfoSliceAllocator['reserve']>>;
  readonly waterVertices: Float32Array;
  readonly waterDraws?: readonly WaterInfoWaterDraw[];
  readonly groundVertices: Float32Array;
  readonly dilationVertices: Float32Array;
  readonly captureZM: number;
}

interface DirectWaterInfoZoneCapture extends WaterInfoZoneCaptureBase {
  readonly source: 'direct';
  readonly cacheIdentity: string;
  readonly cacheKey: string;
  readonly system: WaterSystem;
}

interface ReceivedWaterInfoZoneCapture extends WaterInfoZoneCaptureBase {
  readonly source: 'received';
}

export type WaterInfoZoneCapture = DirectWaterInfoZoneCapture | ReceivedWaterInfoZoneCapture;

type WaterInfoPublicationTarget = WaterInfoFramePublication['targets'][number];

type WaterInfoTargetRosterEntry = Pick<
  WaterInfoPublicationTarget,
  'targetName' | 'targetFormat' | 'write'
>;

/** @internal Shared roster contract for receiver submission and source acknowledgment. */
export function waterInfoTargetRosterIsValid(
  targets: readonly WaterInfoTargetRosterEntry[],
): boolean {
  const targetNames = new Set<string>();
  const writableFormats = new Set<string>();
  for (const target of targets) {
    if (
      targetNames.has(target.targetName) ||
      (target.write && writableFormats.has(target.targetFormat))
    )
      return false;
    targetNames.add(target.targetName);
    if (target.write) writableFormats.add(target.targetFormat);
  }
  return true;
}

export function observeWaterInfoTargetHistory(
  state: WaterInfoPublicationState,
  viewIdentity: string,
  deviceGeneration: number,
  graphResources: RenderFeatureGraphResourceState | undefined,
): WaterInfoTargetHistory {
  const key = historyKey(viewIdentity, deviceGeneration);
  const previous = state.history.get(key);
  if (
    previous !== undefined &&
    previous.owner === graphResources?.owner &&
    (previous.publication === undefined || graphResources?.retained === true)
  )
    return previous;
  const history: WaterInfoTargetHistory = {
    owner: graphResources?.owner,
    activeTargets: new Map(),
  };
  state.history.set(key, history);
  return history;
}

export function planWaterInfoTargets(
  captures: readonly WaterInfoZoneCapture[],
  history: WaterInfoTargetHistory,
  frameGeneration: number,
): readonly WaterInfoPublicationTarget[] {
  const previousPublication = history.publication;
  const targetFormats = [
    ...new Set(captures.map((capture) => targetFormatForContext(capture.context.format))),
  ].sort();
  return Object.freeze(
    targetFormats.map((targetFormat) => {
      const matchingCaptures = captures.filter(
        (capture) => targetFormatForContext(capture.context.format) === targetFormat,
      );
      const sourceDigest = waterInfoTargetDigest(matchingCaptures, targetFormat);
      const activeTarget = history.activeTargets.get(targetFormat);
      const activeDigest = activeTarget?.sourceDigest;
      const candidateEpoch =
        (activeTarget?.epoch ?? 0) +
        (activeDigest === undefined || activeDigest === sourceDigest ? 0 : 1);
      const candidateBank: 0 | 1 =
        activeDigest === sourceDigest ? (activeTarget?.bank === 0 ? 1 : 0) : 0;
      const candidateName = targetNameForFormat(targetFormat, candidateEpoch, candidateBank);
      const activeName =
        activeDigest === sourceDigest
          ? targetNameForFormat(targetFormat, activeTarget?.epoch ?? 0, activeTarget?.bank ?? 0)
          : undefined;
      const previousTarget =
        activeName === undefined
          ? undefined
          : previousPublication?.targets.find((target) => target.targetName === activeName);
      const captureSlices = new Set(
        matchingCaptures.map((capture) =>
          JSON.stringify([
            capture.worldIdentity,
            capture.zone.guid,
            capture.zone.generation,
            capture.context.slice,
          ]),
        ),
      );
      const previousSlices = new Set(
        [...(previousPublication?.rows.values() ?? [])]
          .filter((row) => row.targetName === activeName)
          .map((row) =>
            JSON.stringify([row.worldIdentity, row.zoneGuid, row.zoneGeneration, row.slice]),
          ),
      );
      const sameSlices =
        captureSlices.size === previousSlices.size &&
        [...captureSlices].every((slice) => previousSlices.has(slice));
      const width = Math.max(...matchingCaptures.map((capture) => capture.context.widthPx));
      const height = Math.max(...matchingCaptures.map((capture) => capture.context.heightPx));
      const layers = Math.max(...matchingCaptures.map((capture) => capture.context.slice + 1));
      const reusable =
        previousTarget !== undefined &&
        previousTarget.sourceDigest === sourceDigest &&
        previousTarget.targetFormat === targetFormat &&
        previousTarget.width === width &&
        previousTarget.height === height &&
        previousTarget.layers === layers &&
        sameSlices;
      if (reusable) return Object.freeze({ ...previousTarget, write: false });
      return Object.freeze({
        targetName: candidateName,
        targetFormat,
        bank: candidateBank,
        epoch: candidateEpoch,
        write: true,
        sourceDigest,
        contentFrameGeneration: frameGeneration,
        width,
        height,
        layers,
        graphResourceVersion: matchingCaptures
          .map((capture) => capture.context.graphResourceVersion)
          .sort()
          .join('|'),
      });
    }),
  );
}

export interface WaterInfoViewFrame {
  readonly viewIdentity: string;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
  readonly history: WaterInfoTargetHistory;
  readonly captures: readonly WaterInfoZoneCapture[];
  readonly systems: readonly Readonly<{
    worldId: number;
    worldIdentity: string;
    system: WaterSystem;
  }>[];
  readonly beginProfileWork?: NonNullable<RenderFeaturePlanContext['beginProfileWork']>;
  readonly publication: WaterInfoFramePublication;
}

type WaterMeshProxyOwner = ReturnType<WaterSystem['waterMeshOwnerRoster']>[number];

export type WaterMeshProxyRef = Readonly<{
  worldId: number;
  worldIdentity: string;
  timeSeconds: number;
  owner: WaterMeshProxyOwner;
}>;

type WaterInfoWireRecord = Record<string, unknown>;

export function isWaterInfoWireRecord(value: unknown): value is WaterInfoWireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyWireString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeWireInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWaterInfoWireGeneration(value: unknown): value is number {
  return isNonNegativeWireInteger(value) && value <= 0xffffffff;
}

function isWireFiniteArray(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  return true;
}

export function isWireWaterInfoFormat(value: unknown): value is 'rgba16float' | 'rgba32float' {
  return value === 'rgba16float' || value === 'rgba32float';
}

function isWireWaterInfoZoneAsset(value: unknown): value is WaterZoneSnapshot['asset'] {
  if (
    !isWaterInfoWireRecord(value) ||
    value.kind !== 'water-zone' ||
    !isWaterInfoWireRecord(value.extentM) ||
    !isWaterInfoWireRecord(value.waterInfo)
  )
    return false;
  const extent = value.extentM;
  const waterInfo = value.waterInfo;
  const resolution = waterInfo.resolution;
  if (!isWaterInfoWireRecord(resolution)) return false;
  return (
    validWaterInfoZoneExtent(extent, resolution) &&
    (waterInfo.format === 'rgba16f' || waterInfo.format === 'rgba32f') &&
    typeof waterInfo.blurRadius === 'number' &&
    Number.isFinite(waterInfo.blurRadius) &&
    waterInfo.blurRadius >= 0 &&
    typeof waterInfo.localTessellation === 'boolean'
  );
}

function validWaterInfoZoneExtent(
  extent: Record<string, unknown>,
  resolution: Record<string, unknown>,
): boolean {
  return (
    typeof extent.spanXM === 'number' &&
    Number.isFinite(extent.spanXM) &&
    extent.spanXM > 0 &&
    typeof extent.spanZM === 'number' &&
    Number.isFinite(extent.spanZM) &&
    extent.spanZM > 0 &&
    isNonNegativeWireInteger(resolution.widthPx) &&
    resolution.widthPx > 0 &&
    isNonNegativeWireInteger(resolution.heightPx) &&
    resolution.heightPx > 0
  );
}

function isWireWaterZoneSnapshot(value: unknown): value is WaterZoneSnapshot {
  return (
    isWaterInfoWireRecord(value) &&
    isNonEmptyWireString(value.guid) &&
    isWaterInfoWireGeneration(value.generation) &&
    isWireFiniteArray(value.worldMatrixM, 16) &&
    isWireWaterInfoZoneAsset(value.asset)
  );
}

function isWireWaterInfoContext(value: unknown): value is WaterInfoPublicationContext {
  return (
    isWaterInfoWireRecord(value) &&
    isNonEmptyWireString(value.zoneGuid) &&
    typeof value.viewId === 'string' &&
    isWireFiniteArray(value.centerXZ, 2) &&
    isWireFiniteArray(value.extentXZ, 2) &&
    (value.extentXZ as number[]).every((entry) => entry > 0) &&
    validWaterInfoContextHeight(value) &&
    (value.format === 'rgba16f' || value.format === 'rgba32f') &&
    isNonNegativeWireInteger(value.widthPx) &&
    value.widthPx > 0 &&
    isNonNegativeWireInteger(value.heightPx) &&
    value.heightPx > 0 &&
    typeof value.blurRadius === 'number' &&
    Number.isFinite(value.blurRadius) &&
    value.blurRadius >= 0 &&
    isWaterInfoWireGeneration(value.zoneGeneration) &&
    isNonEmptyWireString(value.sourceDigest)
  );
}

function validWaterInfoContextHeight(value: Record<string, unknown>): boolean {
  return (
    typeof value.waterYMinM === 'number' &&
    Number.isFinite(value.waterYMinM) &&
    typeof value.waterYMaxM === 'number' &&
    Number.isFinite(value.waterYMaxM) &&
    value.waterYMaxM >= value.waterYMinM &&
    typeof value.groundYMinM === 'number' &&
    Number.isFinite(value.groundYMinM) &&
    typeof value.maxVelocityMPerSec === 'number' &&
    Number.isFinite(value.maxVelocityMPerSec) &&
    value.maxVelocityMPerSec > 0
  );
}

function isWirePublicationCapture(
  value: unknown,
  viewIdentity: string,
): value is WaterInfoPublicationInputView['captures'][number] {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonNegativeWireInteger(value.worldId) ||
    !isNonEmptyWireString(value.worldIdentity) ||
    !isNonEmptyWireString(value.zoneGuid) ||
    !isWireWaterZoneSnapshot(value.zone) ||
    !isWireWaterInfoContext(value.context) ||
    typeof value.captureZM !== 'number' ||
    !Number.isFinite(value.captureZM)
  )
    return false;
  const waterVertices = value.waterVertices;
  const groundVertices = value.groundVertices;
  const dilationVertices = value.dilationVertices;
  if (
    !(waterVertices instanceof Float32Array) ||
    !(groundVertices instanceof Float32Array) ||
    !(dilationVertices instanceof Float32Array)
  )
    return false;
  if (!isWireWaterDraws(value.waterDraws, waterVertices.length / 6)) return false;
  if (value.groundGeneration !== undefined && !isWaterInfoWireGeneration(value.groundGeneration))
    return false;
  return (
    matchesWaterInfoCaptureContext(
      value.zoneGuid,
      value.worldIdentity,
      value.zone,
      value.context,
      viewIdentity,
    ) &&
    [waterVertices, groundVertices, dilationVertices].every(
      (vertices) => vertices.length % 6 === 0 && vertices.every(Number.isFinite),
    )
  );
}

function matchesWaterInfoCaptureContext(
  zoneGuid: string,
  worldIdentity: string,
  zone: WaterZoneSnapshot,
  context: WaterInfoPublicationContext,
  viewIdentity: string,
): boolean {
  const waterInfo = zone.asset.waterInfo;
  const expectedFormat = waterInfo.format === 'rgba32f' ? 'rgba32f' : 'rgba16f';
  return (
    zoneGuid === zone.guid &&
    context.zoneGuid === JSON.stringify([worldIdentity, zoneGuid]) &&
    context.viewId === (waterInfo.localTessellation ? viewIdentity : 'shared') &&
    context.zoneGeneration === zone.generation &&
    context.format === expectedFormat &&
    context.widthPx === waterInfo.resolution.widthPx &&
    context.heightPx === waterInfo.resolution.heightPx
  );
}

export function isWireWaterDraws(
  value: unknown,
  vertexCount: number,
): value is readonly WaterInfoWaterDraw[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  let nextVertex = 0;
  const bodies = new Set<string>();
  for (const draw of value) {
    if (
      !isWaterInfoWireRecord(draw) ||
      !isNonEmptyWireString(draw.bodyGuid) ||
      !isWaterInfoWireGeneration(draw.bodyGeneration) ||
      bodies.has(draw.bodyGuid) ||
      draw.firstVertex !== nextVertex ||
      !isNonNegativeWireInteger(draw.vertexCount) ||
      draw.vertexCount % 3 !== 0
    )
      return false;
    bodies.add(draw.bodyGuid);
    nextVertex += draw.vertexCount;
    const material = draw.material;
    if (
      material !== undefined &&
      (!isWaterInfoWireRecord(material) ||
        !isNonNegativeWireInteger(material.handle) ||
        material.handle === 0 ||
        !isNonNegativeWireInteger(material.revision) ||
        !isNonEmptyWireString(material.shader) ||
        (material.bindings !== 'group-0' && material.bindings !== 'render-material') ||
        !isWaterInfoWireRecord(material.renderState))
    )
      return false;
  }
  return nextVertex === vertexCount;
}

function isWirePublicationHeightSource(
  value: unknown,
): value is WaterInfoPublicationWaveBody['heightSource'] {
  if (!isWaterInfoWireRecord(value)) return false;
  return (
    (value.kind === 'fixed' || value.kind === 'water-info' || value.kind === 'baked') &&
    typeof value.fixedHeightM === 'number' &&
    Number.isFinite(value.fixedHeightM) &&
    typeof value.fixedDepthM === 'number' &&
    Number.isFinite(value.fixedDepthM) &&
    value.fixedDepthM >= 0 &&
    isWireFiniteArray(value.fixedVelocityXZ, 2)
  );
}

function isWireCookedWave(value: unknown): boolean {
  if (!isWaterInfoWireRecord(value) || !isWireFiniteArray(value.directionXZ, 2)) return false;
  const directionXZ = value.directionXZ;
  const values = [
    value.amplitudeM,
    value.wavelengthM,
    value.steepness,
    value.kPerM,
    value.omegaPerSec,
    value.gpuQ,
    value.cpuQM,
    value.maxHeightM,
  ];
  return (
    values.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    Math.hypot(...directionXZ) > 0 &&
    (value.amplitudeM as number) >= 0 &&
    (value.wavelengthM as number) > 0 &&
    (value.maxHeightM as number) >= 0
  );
}

function isWireBakedGrid(value: unknown): boolean {
  if (
    !isWaterInfoWireRecord(value) ||
    !isWireFiniteArray(value.originXZ, 2) ||
    !isWireFiniteArray(value.spacingXZ, 2) ||
    !(value.samples instanceof Float32Array)
  )
    return false;
  const spacingXZ = value.spacingXZ;
  const samples = value.samples;
  const width = value.width;
  const height = value.height;
  return (
    typeof value.originY === 'number' &&
    Number.isFinite(value.originY) &&
    spacingXZ.every((entry) => entry > 0) &&
    isNonNegativeWireInteger(width) &&
    width > 0 &&
    isNonNegativeWireInteger(height) &&
    height > 0 &&
    width * height * 4 === samples.length &&
    samples.every(Number.isFinite)
  );
}

function isWirePublicationWaveBody(value: unknown): value is WaterInfoPublicationWaveBody {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonNegativeWireInteger(value.worldId) ||
    !isNonEmptyWireString(value.worldIdentity) ||
    !isNonEmptyWireString(value.bodyGuid) ||
    (value.waveSetGuid !== undefined && !isNonEmptyWireString(value.waveSetGuid)) ||
    !isWaterInfoWireGeneration(value.bodyGeneration) ||
    !isWaterInfoWireGeneration(value.zoneGeneration) ||
    !isWaterInfoWireRecord(value.waveSet) ||
    !isWirePublicationHeightSource(value.heightSource) ||
    !hasFiniteWaterWaveFrame(value) ||
    typeof value.supportsWaves !== 'boolean'
  )
    return false;
  if (!validWaveDynamicBounds(value.dynamicBoundsCenterExtentXZ)) return false;
  if (!isWireWaveSet(value.waveSet)) return false;
  if (value.supportsWaves && !value.waveSetGuid) return false;
  if (value.heightSource.kind === 'baked' && value.bakedGrid === undefined) return false;
  return value.bakedGrid === undefined || isWireBakedGrid(value.bakedGrid);
}

function validWaveDynamicBounds(bounds: unknown): boolean {
  return (
    bounds === undefined ||
    (isWireFiniteArray(bounds, 4) &&
      bounds.every((entry) => Number.isFinite(Math.fround(entry))) &&
      Math.fround(bounds[2] ?? 0) > 0 &&
      Math.fround(bounds[3] ?? 0) > 0)
  );
}

function isWireWaveSet(waveSet: WaterInfoWireRecord): boolean {
  if (
    typeof waveSet.inputDigest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(waveSet.inputDigest) ||
    !Array.isArray(waveSet.waves) ||
    typeof waveSet.depthMaskM !== 'number' ||
    !Number.isFinite(waveSet.depthMaskM) ||
    waveSet.depthMaskM < 0 ||
    typeof waveSet.maxWaveHeightM !== 'number' ||
    !Number.isFinite(waveSet.maxWaveHeightM) ||
    waveSet.maxWaveHeightM < 0 ||
    (waveSet.timeSource !== 'fixed-step' && waveSet.timeSource !== 'scene-clock')
  )
    return false;
  for (const wave of waveSet.waves) if (!isWireCookedWave(wave)) return false;
  return true;
}

function hasFiniteWaterWaveFrame(value: WaterInfoWireRecord): boolean {
  return !(
    typeof value.timeSeconds !== 'number' ||
    !Number.isFinite(value.timeSeconds) ||
    typeof value.previousTimeSeconds !== 'number' ||
    !Number.isFinite(value.previousTimeSeconds) ||
    typeof value.baseHeightM !== 'number' ||
    !Number.isFinite(value.baseHeightM) ||
    !isWireFiniteArray(value.tileOriginWorldXZ, 2) ||
    typeof value.tileLengthM !== 'number' ||
    !Number.isFinite(value.tileLengthM) ||
    value.tileLengthM <= 0
  );
}

function isWireWaterInfoSourceAvailability(value: unknown): value is WaterInfoSourceAvailability {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonEmptyWireString(value.bodyGuid) ||
    !isWaterInfoWireGeneration(value.bodyGeneration) ||
    !isNonEmptyWireString(value.field) ||
    (value.guid !== undefined && !isNonEmptyWireString(value.guid))
  )
    return false;
  switch (value.kind) {
    case 'pending':
      return isNonEmptyWireString(value.guid);
    case 'missing':
      return true;
    case 'incompatible':
      return value.actualKind === undefined || isNonEmptyWireString(value.actualKind);
    case 'failed':
      return (
        isWaterInfoWireRecord(value.failure) &&
        isNonEmptyWireString(value.failure.code) &&
        isNonEmptyWireString(value.failure.expected) &&
        isNonEmptyWireString(value.failure.hint)
      );
    default:
      return false;
  }
}

function isWireBodyInput(
  value: unknown,
  captures: readonly WaterInfoPublicationInputView['captures'][number][],
): value is WaterInfoPublicationInputView['bodies'][number] {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonEmptyWireString(value.ownerKey) ||
    !isNonNegativeWireInteger(value.worldId) ||
    !isNonEmptyWireString(value.worldIdentity) ||
    !isNonEmptyWireString(value.bodyGuid) ||
    !isWaterInfoWireGeneration(value.bodyGeneration) ||
    !isNonNegativeWireInteger(value.outputGeneration) ||
    !isWaterInfoWireGeneration(value.zoneGeneration) ||
    !isWirePublicationWaveBody(value.waveBody)
  )
    return false;
  if (!matchesWaterInfoBodyIdentity(value, value.waveBody)) return false;
  if (value.kind === 'independent')
    return (
      value.zoneGuid === undefined &&
      value.targetFormat === undefined &&
      (value.waterInfoAvailability === undefined ||
        isWireWaterInfoSourceAvailability(value.waterInfoAvailability)) &&
      value.waveBody.heightSource.kind !== 'water-info'
    );
  if (
    value.kind !== 'water-info' ||
    value.waterInfoAvailability !== undefined ||
    !isNonEmptyWireString(value.zoneGuid) ||
    !isWireWaterInfoFormat(value.targetFormat)
  )
    return false;
  return matchesWaterInfoBodyCapture(value, value.waveBody, captures);
}

function matchesWaterInfoBodyCapture(
  value: WaterInfoWireRecord,
  waveBody: WaterInfoPublicationWaveBody,
  captures: readonly WaterInfoPublicationInputView['captures'][number][],
): boolean {
  const capture = captures.find(
    (row) =>
      row.worldId === value.worldId &&
      row.worldIdentity === value.worldIdentity &&
      row.zoneGuid === value.zoneGuid &&
      row.zone.generation === value.zoneGeneration,
  );
  const bounds = waveBody.dynamicBoundsCenterExtentXZ;
  return (
    capture !== undefined &&
    targetFormatForContext(capture.context.format) === value.targetFormat &&
    bounds !== undefined &&
    [...capture.context.centerXZ, ...capture.context.extentXZ].every(
      (entry, index) => entry === bounds[index],
    ) &&
    waveBody.worldId === value.worldId &&
    waveBody.worldIdentity === value.worldIdentity &&
    waveBody.bodyGuid === value.bodyGuid &&
    waveBody.bodyGeneration === value.bodyGeneration &&
    waveBody.zoneGeneration === value.zoneGeneration
  );
}

function matchesWaterInfoBodyIdentity(
  value: WaterInfoWireRecord,
  waveBody: WaterInfoPublicationWaveBody,
): boolean {
  const expectedOwnerKey = waterBodyOwnerKey(
    waveBody.worldIdentity,
    waveBody.bodyGuid,
    waveBody.bodyGeneration,
    waveBody.zoneGeneration,
  );
  if (
    value.ownerKey !== expectedOwnerKey ||
    waveBody.worldId !== value.worldId ||
    waveBody.worldIdentity !== value.worldIdentity ||
    waveBody.bodyGuid !== value.bodyGuid ||
    waveBody.bodyGeneration !== value.bodyGeneration ||
    waveBody.zoneGeneration !== value.zoneGeneration
  )
    return false;
  return true;
}

function isWireMeshOwner(
  value: unknown,
): value is WaterInfoPublicationInputView['meshOwners'][number]['owner'] {
  return (
    isWaterInfoWireRecord(value) &&
    isNonEmptyWireString(value.bodyGuid) &&
    isWaterInfoWireGeneration(value.bodyGeneration) &&
    isNonEmptyWireString(value.zoneGuid) &&
    isWaterInfoWireGeneration(value.zoneGeneration) &&
    isWireWaterInfoFormat(value.waterInfoFormat)
  );
}

function isWireGenerationRecord(
  value: unknown,
  waterGeneration = false,
): value is Readonly<Record<string, number>> {
  if (!isWaterInfoWireRecord(value)) return false;
  return Object.values(value).every((generation) =>
    waterGeneration ? isWaterInfoWireGeneration(generation) : isNonNegativeWireInteger(generation),
  );
}

function isWireMeshOwnerInput(
  value: unknown,
): value is WaterInfoPublicationInputView['meshOwners'][number] {
  return (
    isWaterInfoWireRecord(value) &&
    isNonNegativeWireInteger(value.worldId) &&
    isNonEmptyWireString(value.worldIdentity) &&
    typeof value.timeSeconds === 'number' &&
    Number.isFinite(value.timeSeconds) &&
    value.timeSeconds >= 0 &&
    isWireMeshOwner(value.owner)
  );
}

function isWireMeshCandidateInput(
  value: unknown,
  viewIdentity: string,
): value is WaterInfoPublicationInputView['meshCandidates'][number] {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonNegativeWireInteger(value.worldId) ||
    !isNonEmptyWireString(value.worldIdentity) ||
    !isNonEmptyWireString(value.zoneGuid) ||
    !isWaterInfoWireGeneration(value.zoneGeneration) ||
    !isWireWaterInfoFormat(value.waterInfoFormat) ||
    value.viewIdentity !== viewIdentity ||
    !isNonNegativeWireInteger(value.publicationGeneration) ||
    !isWireGenerationRecord(value.sourceGenerations, true) ||
    !isWireGenerationRecord(value.waterMeshOutputGenerations) ||
    !Array.isArray(value.owners)
  )
    return false;
  const sourceGenerations = value.sourceGenerations as Readonly<Record<string, number>>;
  for (const owner of value.owners) {
    if (
      !isWaterInfoWireRecord(owner) ||
      !isNonEmptyWireString(owner.bodyGuid) ||
      !isWaterInfoWireGeneration(owner.bodyGeneration) ||
      sourceGenerations[owner.bodyGuid] !== owner.bodyGeneration
    )
      return false;
  }
  return true;
}

function isWaterInfoPublicationKind(
  value: unknown,
): value is WaterInfoWireRecord & { kind: 'forgeax-water-info-input' } {
  try {
    return isWaterInfoWireRecord(value) && value.kind === 'forgeax-water-info-input';
  } catch {
    return false;
  }
}

export function waterInfoFrameDataKind(
  value: unknown,
): 'publication-input' | 'feature-frame' | undefined {
  try {
    if (!isWaterInfoWireRecord(value)) return undefined;
    if (value.kind === 'forgeax-water-info-input') return 'publication-input';
    if (value.kind === 'forgeax-water-info-frame') return 'feature-frame';
    return undefined;
  } catch {
    return undefined;
  }
}

export function isWaterInfoPublicationInput(value: unknown): value is WaterInfoPublicationInput {
  try {
    if (
      !isWaterInfoPublicationKind(value) ||
      value.version !== 6 ||
      !isNonEmptyWireString(value.sourceSession) ||
      !isNonNegativeWireInteger(value.sourceFrameGeneration) ||
      !Array.isArray(value.views)
    )
      return false;
    const viewIdentities = new Set<string>();
    for (const view of value.views) {
      if (
        !isWaterInfoWireRecord(view) ||
        !isNonEmptyWireString(view.viewIdentity) ||
        viewIdentities.has(view.viewIdentity) ||
        view.sourceFrameGeneration !== value.sourceFrameGeneration ||
        !Array.isArray(view.captures) ||
        !Array.isArray(view.bodies) ||
        !Array.isArray(view.meshOwners) ||
        !Array.isArray(view.meshCandidates) ||
        !Array.isArray(view.gpuMeshes)
      )
        return false;
      viewIdentities.add(view.viewIdentity);
      const checkedView = {
        ...view,
        viewIdentity: view.viewIdentity,
        captures: view.captures,
        bodies: view.bodies,
        meshOwners: view.meshOwners,
        meshCandidates: view.meshCandidates,
        gpuMeshes: view.gpuMeshes,
      };
      if (!validWaterInfoViewBodies(checkedView) || !validWaterInfoViewMeshes(checkedView))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validWaterInfoViewBodies(
  view: WaterInfoWireRecord & { viewIdentity: string; captures: unknown[]; bodies: unknown[] },
): boolean {
  const captures: WaterInfoPublicationInputView['captures'][number][] = [];
  const captureKeys = new Set<string>();
  for (const capture of view.captures) {
    if (!isWirePublicationCapture(capture, view.viewIdentity)) return false;
    const key = JSON.stringify([capture.worldIdentity, capture.zoneGuid, capture.zone.generation]);
    if (captureKeys.has(key)) return false;
    captureKeys.add(key);
    captures.push(capture);
  }
  const acceptedBodies: WaterInfoPublicationInputView['bodies'][number][] = [];
  const bodyKeys = new Set<string>();
  for (const body of view.bodies) {
    if (!isWireBodyInput(body, captures) || bodyKeys.has(body.ownerKey)) return false;
    bodyKeys.add(body.ownerKey);
    acceptedBodies.push(body);
  }
  for (const body of acceptedBodies) {
    if (body.kind !== 'independent' || body.waterInfoAvailability === undefined) continue;
    const blocker = body.waterInfoAvailability;
    if (
      !acceptedBodies.some(
        (candidate) =>
          candidate.worldIdentity === body.worldIdentity &&
          candidate.bodyGuid === blocker.bodyGuid &&
          candidate.bodyGeneration === blocker.bodyGeneration,
      )
    )
      return false;
  }
  for (const capture of captures)
    for (const draw of capture.waterDraws ?? [])
      if (
        !bodyKeys.has(
          waterBodyOwnerKey(
            capture.worldIdentity,
            draw.bodyGuid,
            draw.bodyGeneration,
            capture.zone.generation,
          ),
        )
      )
        return false;
  return true;
}

function validWaterInfoViewMeshes(
  view: WaterInfoWireRecord & {
    viewIdentity: string;
    meshOwners: unknown[];
    meshCandidates: unknown[];
    gpuMeshes: unknown[];
  },
): boolean {
  const acceptedMeshOwners: WaterInfoPublicationInputView['meshOwners'][number][] = [];
  const meshOwnerKeys = new Set<string>();
  for (const entry of view.meshOwners) {
    if (!isWireMeshOwnerInput(entry)) return false;
    const key = JSON.stringify([
      entry.worldIdentity,
      entry.owner.bodyGuid,
      entry.owner.bodyGeneration,
      entry.owner.zoneGeneration,
    ]);
    if (meshOwnerKeys.has(key)) return false;
    meshOwnerKeys.add(key);
    acceptedMeshOwners.push(entry);
  }
  for (const candidate of view.meshCandidates)
    if (!isWireMeshCandidateInput(candidate, view.viewIdentity)) return false;
  const gpuKeys = new Set<string>();
  for (const source of view.gpuMeshes) {
    if (!isWireGpuMeshSource(source, view.viewIdentity) || gpuKeys.has(source.key)) return false;
    gpuKeys.add(source.key);
    for (const body of source.bodies)
      if (
        !acceptedMeshOwners.some(
          (entry) =>
            entry.worldIdentity === source.worldIdentity &&
            entry.owner.bodyGuid === body.guid &&
            entry.owner.bodyGeneration === body.generation &&
            entry.owner.zoneGuid === source.zone.guid &&
            entry.owner.zoneGeneration === source.zone.generation,
        )
      )
        return false;
  }
  return true;
}

function isWireGpuMeshSource(
  value: unknown,
  viewIdentity: string,
): value is WaterInfoPublicationInputView['gpuMeshes'][number] {
  if (
    !isWaterInfoWireRecord(value) ||
    !isNonEmptyWireString(value.key) ||
    !isNonEmptyWireString(value.worldIdentity) ||
    value.viewIdentity !== viewIdentity ||
    !isWireWaterZoneSnapshot(value.zone) ||
    value.zone.asset.gpuMesh === undefined ||
    !validateWaterAsset(value.zone.asset).ok ||
    !isWireFiniteArray(value.originXZ, 2) ||
    !isWireFiniteArray(value.extentXZ, 2) ||
    !value.extentXZ.every((extent) => extent > 0) ||
    !validGpuMeshVerticalBounds(value) ||
    !Array.isArray(value.bodies) ||
    value.bodies.length === 0 ||
    value.bodies.length > 127 ||
    !Array.isArray(value.materials) ||
    value.materials.length === 0 ||
    !value.materials.every(isNonEmptyWireString)
  )
    return false;
  if (!isWireGpuMeshDimensions({ ...value, zone: value.zone }) || !isWireGpuMeshMipTable(value))
    return false;
  const guids = new Set<string>();
  const materialCount = value.materials.length;
  return value.bodies.every((body: unknown, index: number) => {
    if (
      !isWaterInfoWireRecord(body) ||
      !isNonEmptyWireString(body.guid) ||
      guids.has(body.guid) ||
      !isWaterInfoWireGeneration(body.generation) ||
      body.rasterIndex !== index + 1 ||
      !['river', 'lake', 'ocean', 'custom'].includes(String(body.type)) ||
      !(body.vertices instanceof Float32Array) ||
      body.vertices.length === 0 ||
      body.vertices.length % 9 !== 0 ||
      !body.vertices.every(Number.isFinite) ||
      !isNonNegativeWireInteger(body.prioritySlot) ||
      body.prioritySlot > 7 ||
      !isNonNegativeWireInteger(body.materialBucket) ||
      !isNonNegativeWireInteger(body.flatFarBoundaryMask) ||
      body.flatFarBoundaryMask > 15 ||
      body.materialBucket >= materialCount
    )
      return false;
    if (!validGpuMeshWaveDependency(body)) return false;
    if (!validGpuMeshBodyFields(body, materialCount)) return false;
    guids.add(body.guid);
    return true;
  });
}

function validGpuMeshWaveDependency(body: WaterInfoWireRecord): boolean {
  if (
    !isWaterInfoWireRecord(body.waveDependency) ||
    !(body.waveDependency.kind === 'ready'
      ? !('guid' in body.waveDependency)
      : body.waveDependency.kind === 'pending' &&
        body.type !== 'river' &&
        isNonEmptyWireString(body.waveDependency.guid))
  )
    return false;
  return true;
}

function validGpuMeshVerticalBounds(value: WaterInfoWireRecord): boolean {
  return !(
    typeof value.yMin !== 'number' ||
    !Number.isFinite(value.yMin) ||
    typeof value.yMax !== 'number' ||
    !Number.isFinite(value.yMax) ||
    value.yMax <= value.yMin
  );
}

function validGpuMeshBodyFields(body: WaterInfoWireRecord, materialCount: number): boolean {
  for (const name of ['yMin', 'yMax', 'surfaceY', 'maxWaveHeightM'])
    if (typeof body[name] !== 'number' || !Number.isFinite(body[name])) return false;
  if ((body.yMin as number) > (body.yMax as number) || (body.maxWaveHeightM as number) < 0)
    return false;
  for (const name of ['lakeTransitionBucket', 'oceanTransitionBucket'])
    if (
      typeof body[name] !== 'number' ||
      !Number.isInteger(body[name]) ||
      (body[name] as number) < -1 ||
      (body[name] as number) >= materialCount
    )
      return false;
  return true;
}

function isWireGpuMeshDimensions(
  value: WaterInfoWireRecord & { zone: WaterZoneSnapshot },
): boolean {
  for (const name of [
    'width',
    'height',
    'nodeCount',
    'tileCapacity',
    'quadsPerDraw',
    'quadsLod0',
    'densityCount',
  ])
    if (
      !isNonNegativeWireInteger(value[name]) ||
      value[name] === 0 ||
      (value[name] as number) > 0xffffffff
    )
      return false;
  if (
    ![value.width, value.height].every((dimension) =>
      Number.isInteger(Math.log2(dimension as number)),
    )
  )
    return false;
  if (
    ![2, 4, 8].includes(value.quadsPerDraw as number) ||
    value.quadsLod0 !== Math.max(2, 2 ** value.zone.asset.tessellationFactor) ||
    value.tileCapacity !==
      (value.width as number) *
        (value.height as number) *
        ((value.quadsLod0 as number) / (value.quadsPerDraw as number)) ** 2
  )
    return false;
  return true;
}

function isWireGpuMeshMipTable(value: WaterInfoWireRecord): boolean {
  if (
    !Array.isArray(value.mipOffsets) ||
    !Array.isArray(value.mipWidths) ||
    !Array.isArray(value.mipHeights) ||
    value.mipOffsets.length !==
      Math.log2(Math.max(value.width as number, value.height as number)) + 1 ||
    value.mipWidths.length !== value.mipOffsets.length ||
    value.mipHeights.length !== value.mipOffsets.length
  )
    return false;
  let offset = 0,
    width = value.width as number,
    height = value.height as number;
  for (let mip = 0; mip < value.mipOffsets.length; mip++) {
    if (
      value.mipOffsets[mip] !== offset ||
      value.mipWidths[mip] !== width ||
      value.mipHeights[mip] !== height
    )
      return false;
    offset += width * height;
    width = Math.max(1, width / 2);
    height = Math.max(1, height / 2);
  }
  if (offset !== value.nodeCount || width !== 1 || height !== 1) return false;
  return true;
}

export function isWaterInfoSourceFeedback(value: unknown): value is WaterInfoSourceFeedback {
  if (typeof value !== 'object' || value === null) return false;
  const feedback = value as Partial<WaterInfoSourceFeedback>;
  if (
    feedback.kind !== 'forgeax-water-info-submitted' ||
    typeof feedback.sourceSession !== 'string' ||
    !Number.isSafeInteger(feedback.sourceFrameGeneration) ||
    !Array.isArray(feedback.views)
  )
    return false;
  const viewIdentities = new Set<string>();
  for (const view of feedback.views) {
    if (
      typeof view !== 'object' ||
      view === null ||
      typeof view.viewIdentity !== 'string' ||
      viewIdentities.has(view.viewIdentity) ||
      !Number.isSafeInteger(view.receiverFrameGeneration) ||
      view.receiverFrameGeneration < 0 ||
      !Number.isSafeInteger(view.deviceGeneration) ||
      view.deviceGeneration < 0 ||
      !Array.isArray(view.targets) ||
      !Array.isArray(view.bodies) ||
      !Array.isArray(view.meshCandidates)
    )
      return false;
    viewIdentities.add(view.viewIdentity);
    if (!validWaterInfoFeedbackRows(view)) return false;
  }
  return true;
}

function validWaterInfoFeedbackRows(view: WaterInfoSourceFeedback['views'][number]): boolean {
  if (
    !view.targets.every(
      (target: unknown) =>
        isWaterInfoWireRecord(target) &&
        typeof target.targetName === 'string' &&
        target.targetName.length > 0 &&
        isWireWaterInfoFormat(target.targetFormat) &&
        typeof target.sourceDigest === 'string' &&
        typeof target.write === 'boolean',
    )
  )
    return false;
  if (
    !view.bodies.every(
      (body: unknown) =>
        isWaterInfoWireRecord(body) &&
        typeof body.ownerKey === 'string' &&
        isNonNegativeWireInteger(body.bodyGeneration) &&
        isNonNegativeWireInteger(body.outputGeneration) &&
        isNonNegativeWireInteger(body.zoneGeneration),
    )
  )
    return false;
  if (
    !view.meshCandidates.every(
      (candidate: unknown) =>
        isWaterInfoWireRecord(candidate) &&
        typeof candidate.worldIdentity === 'string' &&
        typeof candidate.zoneGuid === 'string' &&
        isNonNegativeWireInteger(candidate.zoneGeneration) &&
        isNonNegativeWireInteger(candidate.publicationGeneration),
    )
  )
    return false;
  return true;
}

export function featureFailure(expected: string, detail: unknown): RenderError {
  return new RenderFeatureStageFailedError(
    WATER_INFO_FEATURE_IDENTITY,
    -1,
    'extract',
    'next-frame',
    { expected, detail },
  );
}

function textureTarget(
  name: string,
  format: 'rgba16float' | 'rgba32float' | 'depth32float',
  width: number,
  height: number,
  layers: number,
  allocationKey = name,
  baseArrayLayer = 0,
  arrayLayerCount = layers,
  forceArrayView = false,
  lifetime: 'transient' | 'persistent' = 'transient',
) {
  return {
    kind: 'graph-texture' as const,
    name,
    allocationKey,
    descriptor: {
      format,
      size: { width, height, depthOrArrayLayers: layers },
      sampleCount: 1,
      dimension: '2d' as const,
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        (lifetime === 'persistent'
          ? GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING
          : 0),
      lifetime,
    },
    view: {
      dimension: (forceArrayView || arrayLayerCount > 1 ? '2d-array' : '2d') as '2d' | '2d-array',
      baseArrayLayer,
      arrayLayerCount,
    },
  };
}

function computeProgram(
  name: string,
  wgsl: string,
  entry: string,
  entries: readonly BindGroupLayoutEntry[],
) {
  return {
    kind: 'compute-program' as const,
    name,
    preparePipelines: true,
    program: { wgsl, entryPoints: [entry], bindings: [{ entries }] },
  };
}

function validateWaterInfoWorkLimits(frame: WaterInfoViewFrame, context: RenderFeaturePlanContext) {
  const plan = frame.publication.waveUploadPlan;
  const maxBufferSize = context.limits?.maxBufferSize ?? 256 * 1024 * 1024;
  const maxStorageBindingSize = context.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
  const storageBuffers = [
    ['body data', plan.bodyBuffer, WATER_BODY_DATA_STRIDE_BYTES],
    ['Gerstner waves', plan.waveBuffer, 48],
    ['Baked descriptors', plan.bakedDescriptorBuffer, 48],
    ['Baked samples', plan.bakedSamplesBuffer, 16],
  ] as const;
  for (const [label, bytes, minimumSize] of storageBuffers) {
    const bindingSize = Math.max(minimumSize, bytes.byteLength);
    if (bindingSize > maxBufferSize || bindingSize > maxStorageBindingSize)
      return err(
        featureFailure(
          `Water ${label} storage buffer within device maxBufferSize and maxStorageBufferBindingSize`,
          {
            viewIdentity: frame.viewIdentity,
            bytes: bindingSize,
            maxBufferSize,
            maxStorageBufferBindingSize: maxStorageBindingSize,
          },
        ),
      );
  }
  const maxLayers = context.limits?.maxTextureArrayLayers ?? MAX_WATER_INFO_SLICES;
  const maxDimension = context.limits?.maxTextureDimension2D ?? 8192;
  for (const target of frame.publication.targets) {
    if (target.layers > maxLayers)
      return err(
        featureFailure('WaterInfo array layer count within device maxTextureArrayLayers', {
          targetName: target.targetName,
          requested: target.layers,
          maxTextureArrayLayers: maxLayers,
        }),
      );
    if (target.width > maxDimension || target.height > maxDimension)
      return err(
        featureFailure('WaterInfo extent within maxTextureDimension2D', {
          targetName: target.targetName,
          width: target.width,
          height: target.height,
          maxTextureDimension2D: maxDimension,
        }),
      );
  }
  for (const capture of frame.captures)
    for (const vertices of [
      capture.waterVertices,
      capture.groundVertices,
      capture.dilationVertices,
    ])
      if (vertices.byteLength > maxBufferSize)
        return err(
          featureFailure('WaterInfo raster vertex stream within maxBufferSize', {
            zoneGuid: capture.zoneGuid,
            bytes: vertices.byteLength,
            maxBufferSize,
          }),
        );

  return undefined;
}

export function makeWork(
  frame: WaterInfoViewFrame,
  context: RenderFeaturePlanContext,
): Result<RenderFeatureWork, RenderError> {
  if (frame.publication.targets.length === 0)
    return ok({ scope: { view: frame.viewIdentity }, resources: [], passes: [] });
  const deviceFailure = validateWaterInfoWorkLimits(frame, context);
  if (deviceFailure !== undefined) return deviceFailure;

  const resourceSuffix = (format: 'rgba16float' | 'rgba32float') => format;
  const programName = (
    stage:
      | 'raster-water'
      | 'raster-ground'
      | 'raster-dilation'
      | 'merge'
      | 'blur'
      | 'finalize'
      | 'clear'
      | 'retain',
    format: 'rgba16float' | 'rgba32float',
  ) => `water-info-${stage}-program-${resourceSuffix(format)}`;
  const resources: RenderFeatureResourceDeclaration[] = [];
  const declareTargetsAndPrograms = (): void => {
    for (const target of frame.publication.targets) {
      const viewName = `${target.targetName}-view`;
      resources.push(
        {
          ...textureTarget(
            target.targetName,
            target.targetFormat,
            target.width,
            target.height,
            target.layers,
            target.targetName,
            0,
            target.layers,
            true,
            'persistent',
          ),
          materialSource: true,
        },
        {
          kind: 'prepared-gpu-resource',
          name: viewName,
          resource: { kind: 'texture-view', value: undefined },
          logicalTarget: target.targetName,
        },
      );
    }
    const targetFormats = [
      ...new Set(frame.publication.targets.map((target) => target.targetFormat)),
    ];
    const writableFormats = new Set(
      frame.publication.targets
        .filter((target) => target.write)
        .map((target) => target.targetFormat),
    );
    for (const outputFormat of targetFormats) {
      const sampledFloatType = outputFormat === 'rgba32float' ? 'unfilterable-float' : 'float';
      if (writableFormats.has(outputFormat)) {
        resources.push(
          {
            kind: 'graphics-program',
            name: programName('raster-water', outputFormat),
            program: {
              shader: WATER_INFO_RASTER_WATER_ID,
              preparePipelines: true,
              vertexLayout: 'water-info-position-flow',
              colorFormats: [outputFormat],
              depthFormat: 'depth32float',
              sampleCount: 1,
              topology: 'triangle-list',
              renderState: { cullMode: 'none', depthCompare: 'greater', depthWriteEnabled: true },
            },
          },
          {
            kind: 'graphics-bindings',
            name: `${programName('raster-water', outputFormat)}-bindings`,
            program: programName('raster-water', outputFormat),
            values: {},
          },
          {
            kind: 'graphics-program',
            name: programName('raster-ground', outputFormat),
            program: {
              shader: WATER_INFO_RASTER_GROUND_ID,
              preparePipelines: true,
              vertexLayout: 'water-info-position-flow',
              colorFormats: [outputFormat],
              depthFormat: 'depth32float',
              sampleCount: 1,
              topology: 'triangle-list',
              renderState: { cullMode: 'none', depthCompare: 'greater', depthWriteEnabled: true },
            },
          },
          {
            kind: 'graphics-bindings',
            name: `${programName('raster-ground', outputFormat)}-bindings`,
            program: programName('raster-ground', outputFormat),
            values: {},
          },
          {
            kind: 'graphics-program',
            name: programName('raster-dilation', outputFormat),
            program: {
              shader: WATER_INFO_RASTER_DILATION_ID,
              preparePipelines: true,
              vertexLayout: 'water-info-position-flow',
              colorFormats: [outputFormat],
              depthFormat: 'depth32float',
              sampleCount: 1,
              topology: 'triangle-list',
              renderState: { cullMode: 'none', depthCompare: 'greater', depthWriteEnabled: true },
            },
          },
          {
            kind: 'graphics-bindings',
            name: `${programName('raster-dilation', outputFormat)}-bindings`,
            program: programName('raster-dilation', outputFormat),
            values: {},
          },
          computeProgram(
            programName('merge', outputFormat),
            waterInfoMergeWgsl(outputFormat),
            'merge',
            [
              {
                binding: 0,
                visibility: 4,
                texture: { sampleType: sampledFloatType, viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: 4,
                texture: { sampleType: sampledFloatType, viewDimension: '2d' },
              },
              {
                binding: 2,
                visibility: 4,
                texture: { sampleType: sampledFloatType, viewDimension: '2d' },
              },
              { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
              {
                binding: 4,
                visibility: 4,
                storageTexture: { access: 'write-only', format: outputFormat, viewDimension: '2d' },
              },
            ],
          ),
          computeProgram(
            programName('blur', outputFormat),
            waterInfoBlurWgsl(outputFormat),
            'blur',
            [
              {
                binding: 0,
                visibility: 4,
                texture: { sampleType: sampledFloatType, viewDimension: '2d' },
              },
              { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
              {
                binding: 2,
                visibility: 4,
                storageTexture: { access: 'write-only', format: outputFormat, viewDimension: '2d' },
              },
            ],
          ),
          computeProgram(
            programName('finalize', outputFormat),
            waterInfoFinalizeWgsl(outputFormat),
            'finalize',
            [
              {
                binding: 0,
                visibility: 4,
                texture: { sampleType: sampledFloatType, viewDimension: '2d' },
              },
              { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
              {
                binding: 2,
                visibility: 4,
                storageTexture: {
                  access: 'write-only',
                  format: outputFormat,
                  viewDimension: '2d-array',
                },
              },
            ],
          ),
          computeProgram(
            programName('clear', outputFormat),
            waterInfoClearWgsl(outputFormat),
            'clear',
            [
              {
                binding: 0,
                visibility: 4,
                storageTexture: {
                  access: 'write-only',
                  format: outputFormat,
                  viewDimension: '2d-array',
                },
              },
            ],
          ),
        );
      }
      resources.push(
        computeProgram(programName('retain', outputFormat), WATER_INFO_RETAIN_WGSL, 'retain', [
          {
            binding: 0,
            visibility: 4,
            texture: { sampleType: sampledFloatType, viewDimension: '2d-array' },
          },
        ]),
      );
    }
    for (const target of frame.publication.targets) {
      const viewName = `${target.targetName}-view`;
      if (target.write) {
        resources.push({
          kind: 'compute-bindings',
          name: `water-info-clear-bindings-${target.targetName}`,
          program: programName('clear', target.targetFormat),
          entries: [{ binding: 0, resource: viewName }],
        });
      } else {
        resources.push({
          kind: 'compute-bindings',
          name: `water-info-retain-bindings-${target.targetName}`,
          program: programName('retain', target.targetFormat),
          entries: [{ binding: 0, resource: viewName }],
        });
      }
    }
  };
  declareTargetsAndPrograms();
  const passes: RenderFeatureWork['passes'][number][] = [];
  const writableCaptures = frame.captures.filter((capture) =>
    frame.publication.targets.some(
      (target) =>
        target.write && target.targetFormat === targetFormatForContext(capture.context.format),
    ),
  );
  const appendCaptureWork = (capture: WaterInfoZoneCapture, index: number) => {
    const suffix = String(index);
    const outputFormat = targetFormatForContext(capture.context.format);
    const arrayTargetName = requireWaterValue(
      frame.publication.targets.find(
        (target) => target.targetFormat === outputFormat && target.write,
      ),
    ).targetName;
    const arrayViewName = `${arrayTargetName}-view`;
    const params: WaterInfoGpuZoneParams = {
      width: capture.context.widthPx,
      height: capture.context.heightPx,
      blurRadius: capture.context.blurRadius,
      slice: capture.context.slice,
      centerXZ: capture.context.centerXZ,
      extentXZ: capture.context.extentXZ,
      waterYMinM: capture.context.waterYMinM,
      waterYMaxM: capture.context.waterYMaxM,
      groundYMinM: capture.context.groundYMinM,
      captureZM: capture.captureZM,
      triangleOffset: 0,
      triangleCount: 0,
      undergroundDilationOffsetM: UNDERGROUND_DILATION_OFFSET_M,
      maxVelocityMPerSec: MAX_VELOCITY_M_PER_SEC,
    };
    const waterRaw = `water-info-water-raster-${suffix}`;
    const groundRaw = `water-info-ground-raster-${suffix}`;
    const dilationRaw = `water-info-dilation-raster-${suffix}`;
    const depth = `water-info-depth-${suffix}`;
    const merged = `water-info-merged-${suffix}`;
    const blurred = `water-info-blurred-${suffix}`;
    const row = `water-info-zone-${suffix}`;
    const mergeBindings = `water-info-merge-bindings-${suffix}`;
    const blurBindings = `water-info-blur-bindings-${suffix}`;
    const finalBindings = `water-info-finalize-bindings-${suffix}`;
    const waterVertices = `water-info-water-vertices-${suffix}`;
    const groundVertices = `water-info-ground-vertices-${suffix}`;
    const dilationVertices = `water-info-dilation-vertices-${suffix}`;
    for (const [name, format] of [
      [waterRaw, outputFormat],
      [groundRaw, outputFormat],
      [dilationRaw, outputFormat],
      [merged, outputFormat],
      [blurred, outputFormat],
    ] as const)
      resources.push({
        ...textureTarget(name, format, capture.context.widthPx, capture.context.heightPx, 1),
      });
    resources.push({
      ...textureTarget(depth, 'depth32float', capture.context.widthPx, capture.context.heightPx, 1),
    });
    resources.push(
      {
        kind: 'vertex-data',
        name: waterVertices,
        layout: 'water-info-position-flow',
        data: capture.waterVertices.length === 0 ? new Float32Array(6) : capture.waterVertices,
      },
      {
        kind: 'vertex-data',
        name: groundVertices,
        layout: 'water-info-position-flow',
        data: capture.groundVertices.length === 0 ? new Float32Array(6) : capture.groundVertices,
      },
      {
        kind: 'vertex-data',
        name: dilationVertices,
        layout: 'water-info-position-flow',
        data:
          capture.dilationVertices.length === 0 ? new Float32Array(6) : capture.dilationVertices,
      },
      {
        kind: 'buffer',
        name: row,
        size: 64,
        usage: ['storage'],
        data: encodeWaterInfoGpuZoneParams(params),
      },
      {
        kind: 'prepared-gpu-resource',
        name: `${waterRaw}-view`,
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: waterRaw,
      },
      {
        kind: 'prepared-gpu-resource',
        name: `${groundRaw}-view`,
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: groundRaw,
      },
      {
        kind: 'prepared-gpu-resource',
        name: `${dilationRaw}-view`,
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: dilationRaw,
      },
      {
        kind: 'prepared-gpu-resource',
        name: `${merged}-view`,
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: merged,
      },
      {
        kind: 'prepared-gpu-resource',
        name: `${blurred}-view`,
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: blurred,
      },
      {
        kind: 'compute-bindings',
        name: mergeBindings,
        program: programName('merge', outputFormat),
        entries: [
          { binding: 0, resource: `${waterRaw}-view` },
          { binding: 1, resource: `${groundRaw}-view` },
          { binding: 2, resource: `${dilationRaw}-view` },
          { binding: 3, resource: row },
          { binding: 4, resource: `${merged}-view` },
        ],
      },
      {
        kind: 'compute-bindings',
        name: blurBindings,
        program: programName('blur', outputFormat),
        entries: [
          { binding: 0, resource: `${merged}-view` },
          { binding: 1, resource: row },
          { binding: 2, resource: `${blurred}-view` },
        ],
      },
      {
        kind: 'compute-bindings',
        name: finalBindings,
        program: programName('finalize', outputFormat),
        entries: [
          { binding: 0, resource: `${blurred}-view` },
          { binding: 1, resource: row },
          { binding: 2, resource: arrayViewName },
        ],
      },
    );
    const groups: [number, number, number] = [
      Math.ceil(capture.context.widthPx / WORKGROUP),
      Math.ceil(capture.context.heightPx / WORKGROUP),
      1,
    ];
    const waterDraws: import('../features/plan').RenderFeatureDrawDeclaration[] = [];
    for (let drawIndex = 0; drawIndex < (capture.waterDraws?.length ?? 0); drawIndex++) {
      const draw = requireWaterValue(requireWaterValue(capture.waterDraws)[drawIndex]);
      if (draw.vertexCount === 0) continue;
      let program = programName('raster-water', outputFormat);
      let bindings = [`${program}-bindings`];
      if (draw.material !== undefined) {
        const material = draw.material;
        const resolved = context.resolveAsset?.(material.handle, material.revision);
        if (resolved?.ok !== true || resolved.value.kind !== 'material')
          return err(
            featureFailure('the exact published WaterInfo material revision', {
              world: capture.worldId,
              bodyGuid: draw.bodyGuid,
              handle: material.handle,
              revision: material.revision,
              ...(resolved?.ok === false ? { cause: resolved.error } : {}),
            }),
          );
        program = `water-info-body-program-${suffix}-${drawIndex}`;
        const viewBinding = `${program}-view`;
        resources.push(
          {
            kind: 'graphics-program',
            name: program,
            program: {
              shader: material.shader,
              preparePipelines: true,
              vertexLayout: 'water-info-position-flow',
              colorFormats: [outputFormat],
              depthFormat: 'depth32float',
              sampleCount: 1,
              topology: 'triangle-list',
              renderState: material.renderState,
            },
          },
          { kind: 'graphics-bindings', name: viewBinding, program, values: { group: 0 } },
        );
        bindings = [viewBinding];
        if (material.bindings === 'render-material') {
          const parameterBinding = `${program}-parameters`;
          resources.push({
            kind: 'graphics-bindings',
            name: parameterBinding,
            program,
            values: {
              group: 1,
              material: {
                world: capture.worldId,
                handle: material.handle,
                revision: material.revision,
              },
            },
          });
          bindings.push(parameterBinding);
        }
      }
      waterDraws.push({
        program,
        bindings,
        vertexData: [{ slot: 0, resource: waterVertices }],
        draw: {
          kind: 'draw',
          vertexCount: draw.vertexCount,
          firstVertex: draw.firstVertex,
          instanceCount: 1,
        },
      });
    }
    passes.push(
      ...[
        {
          name: `water-info-water-raster-${suffix}`,
          target: waterRaw,
          program: programName('raster-water', outputFormat),
          vertices: waterVertices,
          count: capture.waterVertices.length / 6,
        },
        {
          name: `water-info-ground-raster-${suffix}`,
          target: groundRaw,
          format: outputFormat,
          program: programName('raster-ground', outputFormat),
          vertices: groundVertices,
          count: capture.groundVertices.length / 6,
        },
        {
          name: `water-info-dilation-raster-${suffix}`,
          target: dilationRaw,
          format: outputFormat,
          program: programName('raster-dilation', outputFormat),
          vertices: dilationVertices,
          count: capture.dilationVertices.length / 6,
        },
      ].map((raster) => ({
        kind: 'raster' as const,
        name: raster.name,
        colorAttachments: [
          {
            target: raster.target,
            format: (raster.format ?? outputFormat) as 'rgba16float' | 'rgba32float',
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          },
        ],
        depthStencilAttachment: {
          target: depth,
          format: 'depth32float' as const,
          depthClearValue: 1,
          depthLoadOp: 'clear' as const,
          depthStoreOp: 'store' as const,
        },
        draws:
          raster.target === waterRaw && capture.waterDraws !== undefined
            ? waterDraws
            : raster.count === 0
              ? []
              : [
                  {
                    program: raster.program,
                    bindings: [`${raster.program}-bindings`],
                    vertexData: [{ slot: 0, resource: raster.vertices }],
                    draw: { kind: 'draw' as const, vertexCount: raster.count, instanceCount: 1 },
                  },
                ],
      })),
      {
        kind: 'compute',
        name: `water-info-merge-${suffix}`,
        program: programName('merge', outputFormat),
        bindings: mergeBindings,
        dispatches: [{ kind: 'direct' as const, entryPoint: 'merge', workgroups: groups }],
      },
      {
        kind: 'compute',
        name: `water-info-flow-blur-${suffix}`,
        program: programName('blur', outputFormat),
        bindings: blurBindings,
        dispatches: [{ kind: 'direct' as const, entryPoint: 'blur', workgroups: groups }],
      },
      {
        kind: 'compute',
        name: `water-info-finalize-${suffix}`,
        program: programName('finalize', outputFormat),
        bindings: finalBindings,
        dispatches: [
          {
            kind: 'direct' as const,
            entryPoint: 'finalize',
            workgroups: [
              Math.ceil(capture.context.widthPx / WORKGROUP),
              Math.ceil(capture.context.heightPx / WORKGROUP),
              1,
            ] as const,
          },
        ],
      },
    );
    return undefined;
  };
  for (let index = 0; index < writableCaptures.length; index += 1) {
    const capture = requireWaterValue(writableCaptures[index]);
    const captureFailure = appendCaptureWork(capture, index);
    if (captureFailure !== undefined) return captureFailure;
  }
  passes.unshift(
    ...frame.publication.targets
      .filter((target) => !target.write)
      .map((target) => ({
        kind: 'compute' as const,
        name: `water-info-retain-${target.targetName}`,
        program: programName('retain', target.targetFormat),
        bindings: `water-info-retain-bindings-${target.targetName}`,
        dispatches: [
          { kind: 'direct' as const, entryPoint: 'retain', workgroups: [1, 1, 1] as const },
        ],
      })),
    ...frame.publication.targets
      .filter((target) => target.write)
      .map((target) => ({
        kind: 'compute' as const,
        name: `water-info-clear-array-${target.targetName}`,
        program: programName('clear', target.targetFormat),
        bindings: `water-info-clear-bindings-${target.targetName}`,
        dispatches: [
          {
            kind: 'direct' as const,
            entryPoint: 'clear',
            workgroups: [
              Math.ceil(target.width / WORKGROUP),
              Math.ceil(target.height / WORKGROUP),
              target.layers,
            ] as const,
          },
        ],
      })),
  );
  return ok({ scope: { view: frame.viewIdentity }, resources, passes });
}
