import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationMetadata,
} from './contract';

/**
 * Wire protocol of one source publication. Per-frame facts live in one
 * transferable `record` (a fixed Float64 header, then the change columns); the
 * object graph crosses only for low-frequency rows that actually exist this
 * frame, so an unchanged frame structured-clones three scalars and a buffer.
 */
export const RENDER_PUBLICATION_PROTOCOL = 4;

/** What crosses the Worker boundary and what a Renderer draws. */
export interface RenderPublicationMessage extends RenderPublicationIdentity {
  readonly revision: number;
  /** Header and change columns; transferred to the receiver and returned with the completion. */
  readonly record: ArrayBuffer;
  /** Absent when every low-frequency row is empty and the frame metadata is unchanged. */
  readonly side?: RenderPublicationSide;
}

/** Low-frequency rows, each present only when non-empty. */
export type RenderPublicationSide = {
  readonly [K in SideKey]?: RenderPublication[K];
} & {
  /** Top-level frame metadata entries that differ from the last accepted publication. */
  readonly metadata?: Partial<RenderPublicationMetadata>;
  /** Metadata entries the accepted publication had and this one omits. */
  readonly retiredMetadata?: readonly (keyof RenderPublicationMetadata)[];
};

const SIDE_KEYS = [
  'materials',
  'retiredMaterials',
  'templates',
  'canvasFrames',
  'videoFrames',
  'targets',
  'targetSources',
  'features',
  'programs',
  'assets',
  'preparedAssets',
  'assetVersions',
  'retiredAssetVersions',
  'assetPatches',
  'retiredAssets',
] as const satisfies readonly (keyof RenderPublication)[];
type SideKey = (typeof SIDE_KEYS)[number];

const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 8;
// Header word indices (Float64).
const PROTOCOL = 0,
  BASE = 1,
  FLAGS = 2,
  DELTA = 3,
  ELAPSED = 4,
  MAX_DELTA = 5,
  SAMPLE_TIME = 6,
  SORT_MODE = 7,
  SORT_YZ_ALPHA = 8,
  UPSERTS = 9,
  REMOVED = 10,
  TRANSFORMS = 11,
  RETIRED_JOINTS = 12;
const BASELINE = 1;
const TEMPORAL_RESET = 2;
/** The side metadata is complete and replaces, rather than amends, the accepted metadata. */
const METADATA_COMPLETE = 4;
const EMPTY: readonly never[] = Object.freeze([]);

/** Element counts of the four identity columns; transforms hold 16 floats per transform identity. */
export interface RenderPublicationRecordCounts {
  readonly upserts: number;
  readonly removed: number;
  readonly transforms: number;
  readonly retiredJoints: number;
}

export function renderPublicationRecordBytes(counts: RenderPublicationRecordCounts): number {
  return (
    HEADER_BYTES +
    4 * (counts.upserts + counts.removed + counts.transforms + counts.retiredJoints) +
    64 * counts.transforms
  );
}

/** Column views at their canonical record offsets. */
export function renderPublicationRecordColumns(
  record: ArrayBuffer,
  counts: RenderPublicationRecordCounts,
): Pick<
  RenderPublication,
  'upserts' | 'removed' | 'transformEntities' | 'retiredJoints' | 'transforms'
> {
  let offset = HEADER_BYTES;
  const take = (length: number): Uint32Array => {
    const view = new Uint32Array(record, offset, length);
    offset += 4 * length;
    return view;
  };
  const upserts = take(counts.upserts);
  const removed = take(counts.removed);
  const transformEntities = take(counts.transforms);
  const retiredJoints = take(counts.retiredJoints);
  return {
    upserts,
    removed,
    transformEntities,
    retiredJoints,
    transforms: new Float32Array(record, offset, 16 * counts.transforms),
  };
}

function countsOf(packet: RenderPublication): RenderPublicationRecordCounts {
  return {
    upserts: packet.upserts.length,
    removed: packet.removed.length,
    transforms: packet.transformEntities.length,
    retiredJoints: packet.retiredJoints.length,
  };
}

/** True when every column already sits at its canonical offset of one record. */
function inPlace(packet: RenderPublication, counts: RenderPublicationRecordCounts): boolean {
  const record = packet.upserts.buffer;
  if (!(record instanceof ArrayBuffer)) return false;
  const at = (column: Uint32Array | Float32Array, offset: number) =>
    column.buffer === record && column.byteOffset === offset;
  const removed = HEADER_BYTES + packet.upserts.byteLength;
  const transformEntities = removed + packet.removed.byteLength;
  const retiredJoints = transformEntities + packet.transformEntities.byteLength;
  return (
    at(packet.upserts, HEADER_BYTES) &&
    at(packet.removed, removed) &&
    at(packet.transformEntities, transformEntities) &&
    at(packet.retiredJoints, retiredJoints) &&
    at(packet.transforms, retiredJoints + packet.retiredJoints.byteLength) &&
    record.byteLength >= renderPublicationRecordBytes(counts)
  );
}

/** Every frame metadata entry; the type check keeps it complete. */
const METADATA_KEYS = [
  'projectedDecals',
  'cameras',
  'auxiliaryCameras',
  'cubeCameras',
  'reflectionProbes',
  'lights',
  'environment',
  'environmentReady',
  'volumetricFog',
  'cloudLayer',
  'skylight',
  'skylightCount',
  'lightProbes',
  'skybox',
  'skyboxCount',
  'fog',
  'fogFailure',
  'frustumStats',
  'cameraVisible',
  'cameraAdmission',
  'gpuOwned',
  'visibilityStats',
  'materialTextureSources',
  'postProcessParams',
] as const satisfies readonly (keyof RenderPublicationMetadata)[];
type MissingMetadataKey = Exclude<keyof RenderPublicationMetadata, (typeof METADATA_KEYS)[number]>;
const METADATA_KEYS_COMPLETE: MissingMetadataKey extends never ? true : MissingMetadataKey = true;
void METADATA_KEYS_COMPLETE;

/** Camera metadata entries whose snapshots may name a published target token. */
const TARGET_CAMERA_KEYS: ReadonlySet<keyof RenderPublicationMetadata> = new Set([
  'cameras',
  'auxiliaryCameras',
  'cubeCameras',
] satisfies (keyof RenderPublicationMetadata)[]);

function namesTarget(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((camera) => (camera as { readonly target?: unknown }).target !== undefined)
  );
}

/**
 * Entries whose identity differs from the accepted publication. The source
 * retains an unchanged entry's object, so identity is the change evidence.
 * `targets` marks a crossing that carries target rows: a target token keeps
 * its identity only inside one structured clone, so every camera entry that
 * names one crosses with them even when unchanged.
 */
function metadataDelta(
  metadata: RenderPublicationMetadata,
  accepted: RenderPublicationMetadata | undefined,
  targets: boolean,
): Pick<RenderPublicationSide, 'metadata' | 'retiredMetadata'> | undefined {
  if (accepted === undefined) return { metadata };
  let changed: Record<string, unknown> | undefined;
  let retired: (keyof RenderPublicationMetadata)[] | undefined;
  for (const key of METADATA_KEYS) {
    const next = metadata[key];
    const previous = accepted[key];
    if (next === previous && !(targets && TARGET_CAMERA_KEYS.has(key) && namesTarget(next)))
      continue;
    if (next === undefined) {
      retired ??= [];
      retired.push(key);
      continue;
    }
    changed ??= {};
    changed[key] = next;
  }
  if (changed === undefined && retired === undefined) return undefined;
  return {
    ...(changed === undefined ? {} : { metadata: changed as Partial<RenderPublicationMetadata> }),
    ...(retired === undefined ? {} : { retiredMetadata: retired }),
  };
}

/**
 * The single encoder. `accepted` is the metadata of the last publication the
 * receiver accepted; unchanged entries are omitted, and without it the message
 * carries complete metadata. Columns already laid out in one record are not copied.
 */
export function encodeRenderPublication(
  packet: RenderPublication,
  accepted?: RenderPublicationMetadata,
): RenderPublicationMessage {
  const counts = countsOf(packet);
  // The record stores 16 floats per transform identity; no other shape is representable.
  if (packet.transforms.length !== 16 * counts.transforms)
    throw new RenderPublicationError({ reason: 'shape', subject: 'transform columns' });
  let record: ArrayBuffer;
  if (inPlace(packet, counts)) record = packet.upserts.buffer as ArrayBuffer;
  else {
    record = new ArrayBuffer(renderPublicationRecordBytes(counts));
    const columns = renderPublicationRecordColumns(record, counts);
    columns.upserts.set(packet.upserts);
    columns.removed.set(packet.removed);
    columns.transformEntities.set(packet.transformEntities);
    columns.retiredJoints.set(packet.retiredJoints);
    columns.transforms.set(packet.transforms);
  }
  const header = new Float64Array(record, 0, HEADER_WORDS);
  header[PROTOCOL] = RENDER_PUBLICATION_PROTOCOL;
  header[BASE] = packet.base;
  header[FLAGS] =
    (packet.baseline ? BASELINE : 0) |
    (packet.temporalReset ? TEMPORAL_RESET : 0) |
    (accepted === undefined ? METADATA_COMPLETE : 0);
  header[DELTA] = packet.time.delta;
  header[ELAPSED] = packet.time.elapsed;
  header[MAX_DELTA] = packet.time.maxDeltaSeconds;
  header[SAMPLE_TIME] = packet.sampleTimeSeconds;
  header[SORT_MODE] = packet.transparentSort.mode;
  header[SORT_YZ_ALPHA] = packet.transparentSort.yzAlpha;
  header[UPSERTS] = counts.upserts;
  header[REMOVED] = counts.removed;
  header[TRANSFORMS] = counts.transforms;
  header[RETIRED_JOINTS] = counts.retiredJoints;
  let side: Record<string, unknown> | undefined;
  // Indexed: this runs once per frame, usually below the optimizing tier.
  for (let index = 0; index < SIDE_KEYS.length; index++) {
    const key = SIDE_KEYS[index] as SideKey;
    const value = packet[key];
    if (value === undefined || (value as readonly unknown[]).length === 0) continue;
    side ??= {};
    side[key] = value;
  }
  const metadata = metadataDelta(packet.metadata, accepted, packet.targets.length > 0);
  if (metadata !== undefined) side = { ...side, ...metadata };
  return {
    source: packet.source,
    epoch: packet.epoch,
    revision: packet.revision,
    record,
    ...(side === undefined ? {} : { side: side as RenderPublicationSide }),
  };
}

/** Logical bytes of the record (header and columns), independent of its capacity. */
export function renderPublicationRecordLength(message: RenderPublicationMessage): number {
  const header = new Float64Array(message.record, 0, HEADER_WORDS);
  return renderPublicationRecordBytes({
    upserts: header[UPSERTS] as number,
    removed: header[REMOVED] as number,
    transforms: header[TRANSFORMS] as number,
    retiredJoints: header[RETIRED_JOINTS] as number,
  });
}

function shape(subject: string): Result<never, RenderPublicationError> {
  return err(new RenderPublicationError({ reason: 'shape', subject }));
}

function count(header: Float64Array, word: number): number {
  const value = header[word] as number;
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * The single decoder: the in-realm publication over the received record,
 * completing omitted metadata from the receiver's last accepted publication.
 */
export function decodeRenderPublication(
  message: RenderPublicationMessage,
  accepted: RenderPublicationMetadata | undefined,
): Result<RenderPublication, RenderPublicationError> {
  if (
    message === null ||
    typeof message !== 'object' ||
    !(message.record instanceof ArrayBuffer) ||
    message.record.byteLength < HEADER_BYTES
  )
    return shape('publication record');
  const header = new Float64Array(message.record, 0, HEADER_WORDS);
  if (header[PROTOCOL] !== RENDER_PUBLICATION_PROTOCOL) return shape('publication protocol');
  const counts = {
    upserts: count(header, UPSERTS),
    removed: count(header, REMOVED),
    transforms: count(header, TRANSFORMS),
    retiredJoints: count(header, RETIRED_JOINTS),
  };
  const flags = header[FLAGS] as number;
  if (
    counts.upserts < 0 ||
    counts.removed < 0 ||
    counts.transforms < 0 ||
    counts.retiredJoints < 0 ||
    (flags & ~(BASELINE | TEMPORAL_RESET | METADATA_COMPLETE)) !== 0 ||
    renderPublicationRecordBytes(counts) > message.record.byteLength
  )
    return shape('publication record columns');
  const side = message.side ?? {};
  if (typeof side !== 'object' || side === null) return shape('publication side');
  const baseline = (flags & BASELINE) !== 0;
  // A baseline carries complete metadata; a successor completes from the accepted one.
  const prior = baseline || (flags & METADATA_COMPLETE) !== 0 ? undefined : accepted;
  let metadata = prior;
  if (side.metadata !== undefined || side.retiredMetadata !== undefined) {
    if (
      (side.metadata !== undefined &&
        (typeof side.metadata !== 'object' || side.metadata === null)) ||
      (side.retiredMetadata !== undefined && !Array.isArray(side.retiredMetadata))
    )
      return shape('publication metadata');
    const merged: Record<string, unknown> = { ...prior, ...side.metadata };
    for (const key of side.retiredMetadata ?? EMPTY) delete merged[key];
    metadata = merged as unknown as RenderPublicationMetadata;
  }
  if (metadata === undefined) return shape('publication metadata');
  return ok({
    source: message.source,
    epoch: message.epoch,
    revision: message.revision,
    base: header[BASE] as number,
    baseline,
    temporalReset: (flags & TEMPORAL_RESET) !== 0,
    time: {
      delta: header[DELTA] as number,
      elapsed: header[ELAPSED] as number,
      maxDeltaSeconds: header[MAX_DELTA] as number,
    },
    sampleTimeSeconds: header[SAMPLE_TIME] as number,
    transparentSort: {
      mode: header[SORT_MODE] as number,
      yzAlpha: header[SORT_YZ_ALPHA] as number,
    },
    metadata,
    ...renderPublicationRecordColumns(message.record, counts),
    materials: side.materials ?? EMPTY,
    retiredMaterials: side.retiredMaterials ?? EMPTY,
    templates: side.templates ?? EMPTY,
    ...(side.canvasFrames === undefined ? {} : { canvasFrames: side.canvasFrames }),
    videoFrames: side.videoFrames ?? EMPTY,
    targets: side.targets ?? EMPTY,
    targetSources: side.targetSources ?? EMPTY,
    features: side.features ?? EMPTY,
    programs: side.programs ?? EMPTY,
    assets: side.assets ?? EMPTY,
    ...(side.preparedAssets === undefined ? {} : { preparedAssets: side.preparedAssets }),
    assetVersions: side.assetVersions ?? EMPTY,
    retiredAssetVersions: side.retiredAssetVersions ?? EMPTY,
    assetPatches: side.assetPatches ?? EMPTY,
    retiredAssets: side.retiredAssets ?? EMPTY,
  });
}

/** The record returns to its publisher with the frame completion. */
export function renderPublicationTransfers(message: RenderPublicationMessage): ArrayBuffer[] {
  return [message.record];
}

/**
 * Bytes one publication carries across the Worker boundary: the logical record
 * (header and change columns) and the transferred asset buffers. Structured-cloned
 * side rows (objects, materials, programs, features, changed metadata) are not counted.
 */
export function renderPublicationBytes(message: RenderPublicationMessage): {
  readonly columns: number;
  readonly assets: number;
} {
  let assets = 0;
  if (message.side?.assets !== undefined || message.side?.assetPatches !== undefined)
    for (const buffer of renderPublicationAssetTransfers(message)) assets += buffer.byteLength;
  return { columns: renderPublicationRecordLength(message), assets };
}

/** Mesh copies stay with the receiver; only the record is recycled. */
export function renderPublicationAssetTransfers(message: RenderPublicationMessage): ArrayBuffer[] {
  const side = message.side;
  if (side?.assets === undefined && side?.assetPatches === undefined) return [];
  const buffers = new Set<ArrayBuffer>();
  const collect = (value: unknown): void => {
    if (value instanceof ArrayBuffer) {
      buffers.add(value);
    } else if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child);
    }
  };
  for (const row of side.assets ?? EMPTY) collect(row.value);
  for (const patch of side.assetPatches ?? EMPTY) {
    collect(patch.fields);
    for (const range of patch.ranges) collect(range.bytes);
  }
  // The record is recycled separately and is never an asset buffer.
  buffers.delete(message.record);
  return [...buffers];
}

/** Transported sample time and temporal reset, read before the publication is adopted. */
export function renderPublicationTiming(message: RenderPublicationMessage): {
  readonly sampleTimeSeconds: number;
  readonly temporalReset: boolean;
} {
  // A malformed record is rejected when the receiver decodes it.
  if (!(message?.record instanceof ArrayBuffer) || message.record.byteLength < HEADER_BYTES)
    return { sampleTimeSeconds: 0, temporalReset: false };
  const header = new Float64Array(message.record, 0, HEADER_WORDS);
  return {
    sampleTimeSeconds: header[SAMPLE_TIME] as number,
    temporalReset: ((header[FLAGS] as number) & TEMPORAL_RESET) !== 0,
  };
}
