import type { Buffer, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import type { Result } from '@forgeax/engine-types';
import { rebuildCardOwnerIndex, updateCardProjectionRows } from './card-owner-index';
import {
  type FieldEdit,
  type FieldEditBounds,
  type FieldEditState,
  fieldEditBounds,
  worldBounds,
} from './field-edit';
import { GLOBAL_SDF_SETTINGS_BYTES, packGlobalSdfObjectBounds } from './global-sdf';
import type { IndexRun } from './index-allocator';
import type { ProbeCardCapture } from './renderer-probe-cards';
import type { ProbeGlobalPlacementSnapshot, ProbeGlobalRegion } from './renderer-probe-global';
import type { RayReferenceError } from './scene';
import { repackSdfPlacementRow, SDF_INSTANCE_STRIDE, type SdfMeshInstance } from './sdf-query';
import { packSdfSceneCandidates } from './sdf-scene-candidates';
import { sdfSurfaceRowAddress } from './sdf-scene-surface';
import { sameSdfSurfaceCoverage } from './sdf-surface-coverage';
import { packSdfSurfaceRowHeader, type SdfSurfacePoolRow } from './sdf-surface-storage';
import { type SdfPlacementBounds, SdfTransformCertificate } from './sdf-transform-certificate';
import { writeCardLookupProjection } from './surface-cards';
import { WORLD_BOUNDS_HEADER_BYTES, WORLD_BOUNDS_ROW_BYTES } from './world-bounds-pool';
import { packWorldSource } from './world-traversal';

export type { IndexRun } from './index-allocator';

const CARD_PROJECTION_BYTES = 80;
type EditRegion = Pick<ProbeGlobalRegion, 'grid' | 'placement'> & {
  readonly input: Pick<ProbeGlobalRegion['input'], 'instances' | 'fields' | 'bounds' | 'settings'>;
};
type FieldWrite = (
  target: { readonly buffer: Buffer },
  offset: number,
  data: ArrayBufferView,
) => void;

/** Sorted, merged runs; adjacency and overlap coalesce. */
export function mergeRuns(runs: readonly IndexRun[]): IndexRun[] {
  const sorted = [...runs].filter((run) => run.end > run.first).sort((a, b) => a.first - b.first);
  const merged: { first: number; end: number }[] = [];
  for (const run of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && run.first <= last.end) last.end = Math.max(last.end, run.end);
    else merged.push({ ...run });
  }
  return merged;
}
interface PreparedPlacement {
  readonly index: number;
  readonly instance: SdfMeshInstance;
  readonly bytes: Uint8Array;
  readonly bounds: Uint8Array;
  readonly header: Uint32Array | undefined;
  readonly enclosure: SdfPlacementBounds | undefined;
}
interface WrittenFieldEdit {
  readonly tiles: IndexRun[];
  readonly addedTiles: IndexRun[];
  readonly bounds: FieldEditBounds[];
  readonly probeBounds: FieldEditBounds[];
  readonly added: number[];
  /** All adoption and edit-box writes must finish before this final publication. */
  publish(): void;
}
function samePose(left: ArrayLike<number>, right: ArrayLike<number>) {
  return (
    left.length === 16 &&
    right.length === 16 &&
    Array.from(left).every((value, axis) => value === right[axis])
  );
}
function ownedPlacement(
  current: ProbeGlobalPlacementSnapshot,
  state: FieldEditState,
  id: string,
  index: number,
) {
  const owned = state.get(id);
  const instance = current.instances[index];
  if (
    !owned ||
    !instance ||
    owned.index !== index ||
    !samePose(owned.transform, instance.transform)
  )
    throw new Error('field edit identity, slot generation or current placement is stale');
  return instance;
}
function placementStorageValid(region: EditRegion, image: ProbeGlobalPlacementSnapshot) {
  const { headerCapacity } = image.surface;
  const fieldBytes = region.input.fields.size,
    boundsBytes = region.input.bounds.size;
  return (
    Number.isSafeInteger(fieldBytes) &&
    fieldBytes !== undefined &&
    fieldBytes <= SDF_SURFACE_POOL_LAYOUT.maxBytes &&
    region.input.instances.size === image.instanceData.byteLength &&
    region.input.settings.size === GLOBAL_SDF_SETTINGS_BYTES &&
    boundsBytes !== undefined &&
    boundsBytes >= WORLD_BOUNDS_HEADER_BYTES + headerCapacity * WORLD_BOUNDS_ROW_BYTES &&
    (image.surface.headers[3] ?? Infinity) <= fieldBytes / 4
  );
}
function placementHeaderValid(image: ProbeGlobalPlacementSnapshot) {
  const { headers, headerCapacity } = image.surface;
  return (
    headers[0] === SDF_SURFACE_POOL_LAYOUT.magic &&
    (headers[1] === SDF_SURFACE_POOL_LAYOUT.version ||
      headers[1] === SDF_SURFACE_POOL_LAYOUT.indexedVersion) &&
    headers[2] === headerCapacity &&
    Number.isSafeInteger(headerCapacity) &&
    headerCapacity >= 1 &&
    headerCapacity <= SDF_SURFACE_POOL_LAYOUT.maxRows &&
    image.instanceData.byteLength === headerCapacity * SDF_INSTANCE_STRIDE &&
    image.surface.sourceEpoch !== undefined &&
    Number.isInteger(image.surface.sourceEpoch) &&
    image.surface.sourceEpoch >= 1 &&
    image.surface.sourceEpoch <= 0xffffffff &&
    image.surface.placementBounds.length === image.instances.length &&
    headers.length ===
      SDF_SURFACE_POOL_LAYOUT.sceneWords + headerCapacity * SDF_SURFACE_POOL_LAYOUT.rowWords &&
    (headers[3] ?? 0) >=
      headers.length + headerCapacity * SDF_SURFACE_POOL_LAYOUT.coverageRecordWords
  );
}
function placementImage(region: EditRegion) {
  const image = region.placement.current;
  const { headers } = image.surface;
  if (!placementStorageValid(region, image) || !placementHeaderValid(image))
    throw new Error('field edit requires the complete admitted canonical placement image');
  const candidate = image.surface.candidates;
  if (
    (headers[1] === SDF_SURFACE_POOL_LAYOUT.indexedVersion) !== (candidate !== undefined) ||
    (candidate &&
      (candidate.epoch !== image.surface.sourceEpoch ||
        candidate.rowLimit !== image.instances.length ||
        candidate.first + candidate.words + SDF_SURFACE_POOL_LAYOUT.candidateFooterWords !==
          headers[3]))
  )
    throw new Error('field edit candidate source epoch or immutable span is stale');
  return image;
}
function surfaceHeader(
  region: EditRegion,
  current: ProbeGlobalPlacementSnapshot,
  instance: SdfMeshInstance,
  index: number,
  packed: Extract<ReturnType<typeof repackSdfPlacementRow>, { ok: true }>['value'],
) {
  const field = instance.field;
  const certificate = SdfTransformCertificate.create(packed.forward, packed.inverse),
    local = sampledSurfaceField(field) ? field.policy.traceBounds : field.bounds,
    enclosed = certificate.ok
      ? certificate.value.encloseBounds(packed.forward, packed.inverse, local)
      : undefined,
    enclosure = enclosed?.ok ? enclosed.value : undefined;
  if (!sampledSurfaceField(field)) return { header: undefined, enclosure };
  const mesh = current.surface.meshes.get(field);
  const address = sdfSurfaceRowAddress(index);
  const view = new DataView(packed.bytes.buffer, packed.bytes.byteOffset, packed.bytes.byteLength);
  if (
    !mesh ||
    mesh.first < current.surface.headers.length ||
    mesh.end > (current.surface.candidates?.geometryEnd ?? current.surface.headers[3] ?? 0) ||
    view.getUint32(80, true) !== address
  )
    throw new Error('field edit lost its canonical Mesh region or per-row header address');
  const acceptedCoverage = current.surface.coverage[index];
  if (acceptedCoverage === undefined)
    throw new Error('field edit lost its accepted placement coverage');
  // Immutable shared bitmaps are never patched in place. The owning Renderer
  // catches this preflight refusal and rebuilds/retire-fences the complete region.
  if (
    instance.surfaceCoverage !== 'unavailable' &&
    !sameSdfSurfaceCoverage(acceptedCoverage, instance.surfaceCoverage)
  )
    throw new Error('field coverage changes require a complete scene rebuild before mutation');
  const coverageFirst =
    SDF_SURFACE_POOL_LAYOUT.sceneWords +
    current.surface.headerCapacity * SDF_SURFACE_POOL_LAYOUT.rowWords +
    index * SDF_SURFACE_POOL_LAYOUT.coverageRecordWords;
  if (
    current.surface.headers[address + 3] !== coverageFirst ||
    coverageFirst + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords > mesh.first
  )
    throw new Error('field edit lost its placement-owned coverage record');
  const header = packSdfSurfaceRowHeader(
    { field, forward: packed.forward, inverse: packed.inverse, certificate: certificate.unwrap() },
    mesh,
    coverageFirst,
  ).unwrap();
  if (instance.surfaceCoverage === 'unavailable') header[2] = 0;
  if (mesh.end * 4 > (region.input.fields.size ?? 0))
    throw new Error('field edit exceeds its bound field allocation');
  return { header, enclosure };
}

function sampledSurfaceField(field: SdfMeshInstance['field']): field is SdfSurfacePoolRow['field'] {
  return !('missing' in field) && field.policy.kind === 'sampled-visibility';
}
function preparePlacement(
  region: EditRegion,
  current: ProbeGlobalPlacementSnapshot,
  index: number,
  instance: SdfMeshInstance,
): PreparedPlacement {
  const old = current.instances[index];
  if (!old || instance.field !== old.field || instance.mask !== old.mask)
    throw new Error('field edit changed geometry or membership and requires rebuilding');
  const bytes = current.instanceData.subarray(
    index * SDF_INSTANCE_STRIDE,
    (index + 1) * SDF_INSTANCE_STRIDE,
  );
  const packed = repackSdfPlacementRow(instance, bytes).unwrap();
  const bounds = packGlobalSdfObjectBounds([instance]).unwrap();
  const surface = surfaceHeader(region, current, instance, index, packed);
  return { index, instance, bytes: packed.bytes, bounds, ...surface };
}
function preparePlacements(region: EditRegion, edit: FieldEdit, state: FieldEditState) {
  if (edit.added.length)
    throw new Error('canonical field additions require a complete scene rebuild before mutation');
  const current = placementImage(region);
  const removals = prepareRemovals(region, current, edit, state);
  const removed = new Set(edit.removed.map((change) => change.index));
  const instances = new Map<number, SdfMeshInstance>();
  for (const move of edit.moved) {
    const instance = ownedPlacement(current, state, move.id, move.index);
    if (
      !samePose(move.from, instance.transform) ||
      instances.has(move.index) ||
      removed.has(move.index)
    )
      throw new Error('field move baseline is stale or duplicated');
    instances.set(move.index, { ...instance, transform: Float32Array.from(move.to) });
  }
  const materials = new Set<number>();
  for (const change of edit.rematerialized) {
    const instance = ownedPlacement(current, state, change.id, change.index);
    if (materials.has(change.index) || removed.has(change.index))
      throw new Error('field material edit is duplicated or removes its placement');
    materials.add(change.index);
    const moved = instances.get(change.index);
    if (!samePose(moved?.transform ?? instance.transform, change.instance.transform))
      throw new Error('field material and placement edits disagree');
    instances.set(change.index, {
      ...change.instance,
      instanceId: instance.instanceId,
      geometryId: instance.geometryId,
      transform: Float32Array.from(change.instance.transform),
    });
  }
  return {
    current,
    placements: [
      ...removals,
      ...[...instances].map(([index, instance]) =>
        preparePlacement(region, current, index, instance),
      ),
    ],
  };
}
function prepareRemovals(
  region: EditRegion,
  current: ProbeGlobalPlacementSnapshot,
  edit: FieldEdit,
  state: FieldEditState,
) {
  const rows = new Set<number>();
  return edit.removed.map((change) => {
    const instance = ownedPlacement(current, state, change.id, change.index);
    if (rows.has(change.index) || !samePose(change.from, instance.transform))
      throw new Error('field removal baseline is stale or duplicated');
    rows.add(change.index);
    const placement = preparePlacement(region, current, change.index, instance);
    // Retain the canonical row and Mesh addresses. All traversal loops skip mask
    // zero; additions still rebuild, so tombstones cannot acquire a new identity.
    new DataView(placement.bytes.buffer, placement.bytes.byteOffset).setUint32(76, 0, true);
    if (placement.header) placement.header[2] = 0;
    return { ...placement, instance: { ...instance, mask: 0 } };
  });
}
function nextPlacementImage(
  current: ProbeGlobalPlacementSnapshot,
  placements: readonly PreparedPlacement[],
  sourceEpoch: number,
) {
  const previousIndex = current.boundsIndex;
  const coverage =
    previousIndex && previousIndex.sourceEpoch === current.surface.sourceEpoch
      ? previousIndex.coverage
      : undefined;
  const boundsIndex =
    coverage &&
    placements.every(
      ({ index, instance, bounds, bytes }) =>
        instance.mask === 0 || coverage.retains(index, bounds, bytes),
    )
      ? { sourceEpoch, coverage }
      : undefined;
  const instances = [...current.instances];
  const instanceData = current.instanceData.slice();
  const headers = current.surface.headers.slice();
  const placementBounds = [...current.surface.placementBounds];
  for (const placement of placements) {
    instances[placement.index] = placement.instance;
    instanceData.set(placement.bytes, placement.index * SDF_INSTANCE_STRIDE);
    if (placement.header) headers.set(placement.header, sdfSurfaceRowAddress(placement.index));
    placementBounds[placement.index] = placement.enclosure;
  }
  let candidates = current.surface.candidates,
    candidateWords: Uint32Array | undefined;
  if (candidates) {
    const rebuilt = packSdfSceneCandidates(
      placementBounds,
      instanceData,
      current.surface.headerCapacity,
      candidates.words,
    ).unwrap();
    if (!rebuilt)
      throw new Error(
        'existing candidate allocation cannot be silently disabled during a placement edit',
      );
    candidateWords = rebuilt.words;
    candidates = Object.freeze({
      ...candidates,
      nodeCount: rebuilt.nodeCount,
      rowLimit: instances.length,
      epoch: sourceEpoch,
    });
  }
  return {
    image: {
      instances,
      instanceData,
      ...(boundsIndex === undefined ? {} : { boundsIndex }),
      surface: {
        ...current.surface,
        headers,
        placementBounds: Object.freeze(placementBounds),
        candidates,
        sourceEpoch,
      },
    },
    candidateWords,
  };
}

function sceneSourceTuple(region: EditRegion, image: ProbeGlobalPlacementSnapshot, epoch: number) {
  if (image.surface.sourceEpoch !== undefined && epoch < image.surface.sourceEpoch)
    throw new Error('field source epoch cannot move backwards within an admitted allocation');
  return packWorldSource({
    traversal: 'global-sdf',
    expected: [
      region.input.instances.size / 4,
      region.input.fields.size / 4,
      image.instances.length,
      epoch,
    ],
  }).unwrap();
}
function writeCandidatePayload(
  write: FieldWrite,
  region: EditRegion,
  image: ProbeGlobalPlacementSnapshot,
  words: Uint32Array | undefined,
) {
  const directory = image.surface.candidates;
  if (!directory) return;
  if (!words) throw new Error('indexed placement publication lost its complete rebuilt tree');
  write(region.input.fields, directory.first * 4, words);
  write(
    region.input.fields,
    ((image.surface.headers[3] ?? 0) - SDF_SURFACE_POOL_LAYOUT.candidateFooterWords) * 4,
    Uint32Array.from([
      SDF_SURFACE_POOL_LAYOUT.candidateMagic,
      directory.geometryEnd,
      directory.first,
      directory.words,
      directory.nodeCount,
      directory.rowLimit,
      directory.epoch,
      0,
    ]),
  );
}
function invalidateSource(write: FieldWrite, region: EditRegion) {
  write(region.input.fields, 0, new Uint32Array([0]));
  write(region.input.settings, 60, new Uint32Array([0]));
}
function publishSource(
  write: FieldWrite,
  region: EditRegion,
  image: ProbeGlobalPlacementSnapshot,
  tuple: readonly [number, number, number, number],
) {
  write(region.input.settings, 48, Uint32Array.from(tuple));
  // Ready is the final physical write, after payloads and every adoption.
  write(region.input.fields, 0, image.surface.headers.subarray(0, 1));
  region.placement.current = image;
}
function fieldWriter(device: RhiDevice): FieldWrite {
  return (target, offset, data) =>
    device.queue
      .writeBuffer(
        target.buffer,
        offset,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      .unwrap();
}

/** Source-only changes use the same immutable publication transaction. This
 * advances the accepted existing clock; it never invents a local revision. */
export function adoptFieldSourceEpoch(
  device: RhiDevice,
  region: EditRegion,
  sourceEpoch: number,
  beforeWrite: () => Result<void, RhiError | RayReferenceError>,
) {
  const current = placementImage(region);
  if (sourceEpoch === current.surface.sourceEpoch) return;
  const tuple = sceneSourceTuple(region, current, sourceEpoch),
    { image, candidateWords } = nextPlacementImage(current, [], sourceEpoch),
    write = fieldWriter(device);
  beforeWrite().unwrap();
  invalidateSource(write, region);
  writeCandidatePayload(write, region, image, candidateWords);
  publishSource(write, region, image, tuple);
}
function writeProjections(
  write: FieldWrite,
  cards: ProbeCardCapture,
  instanceId: number,
  run: { first: number; count: number },
) {
  const entry = cards.capture.entry(instanceId);
  if (!entry || entry.projections.length !== run.count)
    throw new Error('field edit lost its Card entry');
  const bytes = new Uint8Array(run.count * CARD_PROJECTION_BYTES);
  entry.projections.forEach((projection, index) => {
    writeCardLookupProjection(bytes, index, projection, instanceId, 1);
  });
  updateCardProjectionRows(cards.projections.bytes, run.first, bytes);
  write(cards.projections, run.first * CARD_PROJECTION_BYTES, bytes);
  return { first: run.first, end: run.first + run.count };
}
function removeProjections(cards: ProbeCardCapture, row: number) {
  const run = cards.capture.remove(row).unwrap();
  const bytes = new Uint8Array(run.count * CARD_PROJECTION_BYTES);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.byteLength; offset += CARD_PROJECTION_BYTES)
    view.setUint32(offset + 64, 0xffffffff, true);
  updateCardProjectionRows(cards.projections.bytes, run.first, bytes);
  return { first: run.first, end: run.first + run.count };
}

function removeProjectionBatch(
  write: FieldWrite,
  cards: ProbeCardCapture,
  removed: FieldEdit['removed'],
): IndexRun[] {
  const runs: IndexRun[] = [];
  for (const removal of removed)
    if (cards.capture.has(removal.index)) runs.push(removeProjections(cards, removal.index));
  if (runs.length !== 0) {
    rebuildCardOwnerIndex(cards.projections.bytes, cards.capture.allocatedTiles);
    write(cards.projections, 0, cards.projections.bytes);
  }
  return runs;
}

/** Preflight has no physical writes. Any failure after invalidation retires the whole generation. */
export function writeFieldEdit(
  device: RhiDevice,
  region: EditRegion,
  cards: ProbeCardCapture,
  edit: FieldEdit,
  state: FieldEditState,
  sourceEpoch: number,
  beforeWrite?: () => Result<void, RhiError | RayReferenceError>,
): WrittenFieldEdit {
  const { current, placements } = preparePlacements(region, edit, state);
  const tuple = sceneSourceTuple(region, current, sourceEpoch);
  if (placements.length && sourceEpoch === current.surface.sourceEpoch)
    throw new Error('placement edits require a different accepted source epoch');
  const { image: next, candidateWords } = nextPlacementImage(current, placements, sourceEpoch);
  const materialDraws = edit.rematerialized.map((change) =>
    cards.lower(change.source, change.instance, change.index),
  );
  for (const lowered of materialDraws)
    if (!cards.capture.admitted(lowered))
      throw new Error('field material edit requires prior Card admission');
  const changed = placements.length !== 0 || sourceEpoch !== current.surface.sourceEpoch;
  if (changed) beforeWrite?.().unwrap();
  const write = fieldWriter(device);
  const tiles: IndexRun[] = [];
  if (changed) invalidateSource(write, region);
  // Tombstones are still skipped. A moved row can keep the uploaded lists
  // only when its complete new support stays within its admitted cells.
  if (
    next.boundsIndex === undefined &&
    (edit.moved.length || (placements.length && current.boundsIndex))
  )
    write(region.input.bounds, 28, new Uint32Array([0]));
  for (const placement of placements) {
    write(region.input.instances, placement.index * SDF_INSTANCE_STRIDE, placement.bytes);
    write(
      region.input.bounds,
      WORLD_BOUNDS_HEADER_BYTES + placement.index * WORLD_BOUNDS_ROW_BYTES,
      placement.bounds,
    );
    if (placement.header)
      write(region.input.fields, sdfSurfaceRowAddress(placement.index) * 4, placement.header);
  }
  if (changed) writeCandidatePayload(write, region, next, candidateWords);
  for (const run of removeProjectionBatch(write, cards, edit.removed)) tiles.push(run);
  for (const move of edit.moved) {
    if (!cards.capture.has(move.index)) continue;
    const run = cards.capture.retransform(move.index, move.to).unwrap();
    tiles.push(writeProjections(write, cards, move.index, run));
  }
  for (const [index, change] of edit.rematerialized.entries()) {
    if (!cards.capture.has(change.index)) continue;
    const lowered = materialDraws[index];
    if (!lowered) throw new Error('field material edit lost its prepared draw');
    const run = cards.capture.rematerialize(change.index, lowered).unwrap();
    tiles.push(writeProjections(write, cards, change.index, run));
  }
  const bounds = fieldEditBounds(edit);
  const probeBounds = edit.rematerialized.map((change) =>
    worldBounds(change.local, change.instance.transform),
  );
  let published = false;
  return {
    tiles: mergeRuns(tiles),
    addedTiles: [],
    bounds,
    probeBounds: [...bounds, ...probeBounds],
    added: [],
    publish() {
      if (published || region.placement.current !== current)
        throw new Error('field edit publication is stale or repeated');
      if (changed) publishSource(write, region, next, tuple);
      published = true;
    },
  };
}
