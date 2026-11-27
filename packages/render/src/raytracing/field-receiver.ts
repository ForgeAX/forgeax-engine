import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import { type FieldEditState, fieldEditOwnerKey } from './field-edit';
import { type FieldReceiverGpuSource, packFieldReceiverGpuSource } from './field-receiver-texture';
import type { ProbeGlobalPlacementSnapshot } from './renderer-probe-global';
import {
  type SceneFieldReceiverProof,
  type SceneFieldReceiverSource,
  sceneFieldReceiverProof,
} from './scene-field-projection';
import {
  resolveVisibleSurfaceRange,
  VISIBLE_SURFACE_RECORD_WORDS,
  type VisibleSurfaceIdentity,
  type VisibleSurfaceProjection,
  type VisibleSurfaceRange,
} from './visible-surface';
import type { WorldSource } from './world-traversal';

type AcceptedSource = Extract<WorldSource, { traversal: 'global-sdf' }>['expected'];
type UnavailableReason =
  | 'field-not-ready'
  | 'raster-unavailable'
  | 'stale-source'
  | 'stale-owner'
  | 'uncovered'
  | 'receiver-not-admitted'
  | 'owner-mismatch'
  | 'geometry-mismatch'
  | 'pose-mismatch'
  | 'material-unavailable';

export interface FieldReceiverUnavailable {
  readonly state: 'unavailable';
  readonly reason: UnavailableReason;
}
interface ReceiverOwner {
  readonly entityKey: number;
  readonly slot: number;
  readonly generation: number;
  readonly instanceGeneration: number;
  readonly assetHandle: number;
  readonly assetRevision: number;
}
interface ReceiverRange {
  readonly rasterRow: number;
  readonly canonicalRow: number;
  readonly primitiveFirst: number;
  readonly primitiveCount: number;
  readonly owner: ReceiverOwner;
  readonly forward: Float32Array;
  readonly receiverProof: SceneFieldReceiverProof;
}
type ReceiverRow =
  | (ReceiverRange & { readonly state: 'identified' })
  | (FieldReceiverUnavailable & { readonly rasterRow: number });

export type FieldReceiverIdentity =
  | FieldReceiverUnavailable
  | {
      readonly state: 'identified';
      readonly canonicalRow: number;
      readonly primitive: number;
      readonly primitiveFirst: number;
      readonly primitiveCount: number;
      readonly receiverProof: SceneFieldReceiverProof;
      readonly acceptedSource: AcceptedSource;
      readonly frameOwner: object;
      readonly owner: ReceiverOwner;
      /** Identity/range is not a reconstruction-error or self-contact proof. */
      readonly contact: {
        readonly state: 'unavailable';
        readonly reason: 'receiver-contact-unqualified';
      };
    };

export type FieldReceiverFrame =
  | FieldReceiverUnavailable
  | {
      readonly state: 'ready';
      readonly acceptedSource: AcceptedSource;
      readonly frameOwner: object;
      gpuSource(
        expectedSource: AcceptedSource,
        frameOwner: object,
        frame: number,
        limits: { readonly maxTextureDimension2D: number; readonly maxBytes: number },
      ): Result<FieldReceiverGpuSource | FieldReceiverUnavailable, RhiError>;
      resolve(
        rasterRow: number,
        primitive: number,
        expectedSource: AcceptedSource,
        frameOwner: object,
      ): Result<FieldReceiverIdentity, RhiError>;
    };

interface ReceiverInput {
  /** Existing prepared Field identity and retirement/source fence; no new clock. */
  readonly owner: { readonly identity: object; current(): boolean };
  readonly raster: VisibleSurfaceProjection;
  readonly state: FieldEditState;
  readonly placement: ProbeGlobalPlacementSnapshot;
  readonly acceptedSource: AcceptedSource;
  readonly sources: Iterable<SceneFieldReceiverSource>;
  readonly sourceScope: RenderResourceScope;
}
const unavailable = (reason: UnavailableReason): FieldReceiverUnavailable => ({
  state: 'unavailable',
  reason,
});
export const unavailableFieldReceivers = (reason: UnavailableReason): FieldReceiverFrame =>
  unavailable(reason);
const sameSource = (a: AcceptedSource, b: AcceptedSource) =>
  a.every((word, index) => word === b[index]);
function invalid(expected: string): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'rhi-descriptor-invalid',
      expected,
      hint: 'use the same admitted raster frame and accepted canonical placement; do not synthesize receiver identities',
    }),
  );
}
/** Finite numeric owner snapshots compare as their admitted f32 bits, including signed zero. */
export function fieldReceiverPoseMatches(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== 16 || b.length !== 16) return false;
  for (let index = 0; index < 16; index++) {
    const left = Math.fround(a[index] as number),
      right = Math.fround(b[index] as number);
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Object.is(left, right)) return false;
  }
  return true;
}
function sourceInstances(source: SceneFieldReceiverSource): boolean {
  const count = source.instances?.instanceCount ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || source.transforms.length !== count) return false;
  if (!source.instances) return count === 1;
  const generations = source.instances.generations;
  return (
    generations?.length === count &&
    new Set(generations).size === count &&
    generations.every((generation) => generation !== 0)
  );
}
function ownerMatches(
  identity: VisibleSurfaceIdentity,
  source: SceneFieldReceiverSource,
  ordinal: number,
) {
  return (
    identity.entityKey === source.record.entityKey &&
    identity.slot === source.record.slot &&
    identity.generation === source.record.generation &&
    identity.instanceOrdinal === ordinal &&
    identity.instanceGeneration === (source.instances?.generations?.[ordinal] ?? 0) &&
    identity.assetHandle === source.assetHandle
  );
}
function sectionMatches(range: VisibleSurfaceRange, source: SceneFieldReceiverSource): boolean {
  const section = source.mesh.submeshes[range.drawItemIndex];
  const material = source.materials[range.drawItemIndex];
  if (!section || !material || material.handle !== range.materialHandle) return false;
  const indexed = source.mesh.indices !== undefined;
  const first = indexed
    ? section.indexOffset
    : source.mesh.submeshes
        .slice(0, range.drawItemIndex)
        .reduce((sum, part) => sum + part.vertexCount, 0);
  const count = indexed ? section.indexCount : section.vertexCount;
  return (
    section.topology === 'triangle-list' &&
    range.baseVertex === 0 &&
    range.indexed === indexed &&
    range.firstElement === first &&
    range.elementCount === count &&
    first % 3 === 0 &&
    count % 3 === 0
  );
}
function materialMatches(accepted: readonly unknown[], source: SceneFieldReceiverSource): boolean {
  const bindings = source.materials.flatMap((material) => [
    material.materialSlot,
    material.resource,
    material.handle,
  ]);
  return (
    accepted.length === bindings.length &&
    accepted.every((value, index) => Object.is(value, bindings[index]))
  );
}
function identifyRow(
  input: ReceiverInput,
  source: SceneFieldReceiverSource,
  ordinal: number,
  rasterRow: number,
  range: VisibleSurfaceRange,
): ReceiverRow {
  const absent = (reason: UnavailableReason): ReceiverRow => ({
    ...unavailable(reason),
    rasterRow,
  });
  if (!ownerMatches(range, source, ordinal)) return absent('owner-mismatch');
  const owned = input.state.get(fieldEditOwnerKey(source.record, range.instanceGeneration));
  if (!owned) return absent('receiver-not-admitted');
  if (
    owned.geometry[0] !== source.scope ||
    owned.geometry[1] !== source.assetHandle ||
    owned.geometry[2] !== source.assetRevision
  )
    return absent('geometry-mismatch');
  const instance = input.placement.instances[owned.index],
    pose = source.transforms[ordinal];
  if (
    !instance ||
    !pose ||
    owned.index >= input.acceptedSource[2] ||
    instance.mask === 0 ||
    'missing' in instance.field ||
    instance.surfaceCoverage === 'unavailable'
  )
    return absent('receiver-not-admitted');
  if (
    !fieldReceiverPoseMatches(owned.transform, pose) ||
    !fieldReceiverPoseMatches(owned.transform, instance.transform)
  )
    return absent('pose-mismatch');
  if (!materialMatches(owned.material, source) || !sectionMatches(range, source))
    return absent('material-unavailable');
  const material = source.materials[range.drawItemIndex];
  const receiverProof = material && sceneFieldReceiverProof(material);
  if (!receiverProof) return absent('material-unavailable');
  return {
    state: 'identified',
    rasterRow,
    canonicalRow: owned.index,
    primitiveFirst: range.firstElement / 3,
    primitiveCount: range.elementCount / 3,
    receiverProof,
    owner: Object.freeze({
      entityKey: range.entityKey,
      slot: range.slot,
      generation: range.generation,
      instanceGeneration: range.instanceGeneration,
      assetHandle: source.assetHandle,
      assetRevision: source.assetRevision,
    }),
    forward: Float32Array.from(pose),
  };
}
function sourceRows(
  input: ReceiverInput,
  source: SceneFieldReceiverSource,
): Result<ReceiverRow[], RhiError> {
  if (source.scope !== input.sourceScope)
    return invalid('the exact accepted receiver resource scope');
  if (!sourceInstances(source))
    return invalid('unique admitted nonzero generations for every explicit instance');
  const base = input.raster.slotBases.get(source.record.slot);
  if (base === undefined) return ok([]);
  const count = source.instances?.instanceCount ?? 1,
    rows: ReceiverRow[] = [];
  const span = input.raster.slotRowCount?.(source.record.slot);
  if (
    span === undefined ||
    !Number.isSafeInteger(span) ||
    span < 1 ||
    span > source.mesh.submeshes.length * count ||
    span % count !== 0
  )
    return invalid('the actual visible-surface allocation span of this admitted slot');
  for (let local = 0; local < span; local++) {
    const ordinal = local % count;
    const rasterRow = base + local;
    // VisibleSurfaceRows preserves source drawItem addresses. Count zero is
    // its uncovered hole, not a covered row for the strict range decoder.
    if (input.raster.records[(rasterRow - 1) * VISIBLE_SURFACE_RECORD_WORDS + 10] === 0) {
      rows.push(Object.freeze({ ...unavailable('uncovered'), rasterRow }));
      continue;
    }
    const read = resolveVisibleSurfaceRange(input.raster, rasterRow);
    if (!read.ok) return read;
    if (read.value !== undefined)
      rows.push(Object.freeze(identifyRow(input, source, ordinal, rasterRow, read.value)));
  }
  return ok(rows);
}
function resolveRow(rows: readonly ReceiverRow[], rasterRow: number): ReceiverRow | undefined {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1,
      value = rows[mid];
    if (value !== undefined && value.rasterRow < rasterRow) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo]?.rasterRow === rasterRow ? rows[lo] : undefined;
}
function resolveIdentity(
  rows: readonly ReceiverRow[],
  acceptedSource: AcceptedSource,
  owner: ReceiverInput['owner'],
  rasterRow: number,
  primitive: number,
  expectedSource: AcceptedSource,
  frameOwner: object,
): Result<FieldReceiverIdentity, RhiError> {
  if (frameOwner !== owner.identity || !owner.current()) return ok(unavailable('stale-owner'));
  if (!sameSource(acceptedSource, expectedSource)) return ok(unavailable('stale-source'));
  if (
    !Number.isInteger(rasterRow) ||
    rasterRow < 0 ||
    rasterRow > 0xfffffffe ||
    !Number.isInteger(primitive) ||
    primitive < 0 ||
    primitive > 0xffffffff
  )
    return invalid('an admitted u32 raster address and draw-local primitive');
  if (rasterRow === 0) return ok(unavailable('uncovered'));
  const row = resolveRow(rows, rasterRow);
  if (!row) return ok(unavailable('receiver-not-admitted'));
  if (row.state === 'unavailable') return ok(row);
  if (primitive >= row.primitiveCount)
    return invalid('a draw-local primitive inside its admitted section');
  return ok({
    state: 'identified',
    canonicalRow: row.canonicalRow,
    primitive: row.primitiveFirst + primitive,
    primitiveFirst: row.primitiveFirst,
    primitiveCount: row.primitiveCount,
    receiverProof: row.receiverProof,
    acceptedSource,
    frameOwner: owner.identity,
    owner: row.owner,
    contact: { state: 'unavailable', reason: 'receiver-contact-unqualified' },
  });
}

/** Derived metadata of one ready raster/canonical frame. It owns no roster,
 * clock or geometry, and never makes a self-intersection exclusion decision. */
export function deriveFieldReceivers(input: ReceiverInput): Result<FieldReceiverFrame, RhiError> {
  if (input.raster.slotRowCount === undefined) return ok(unavailable('raster-unavailable'));
  const expected = input.acceptedSource;
  if (
    expected[3] === 0 ||
    expected[3] !== input.placement.surface.sourceEpoch ||
    expected[2] !== input.placement.instances.length
  )
    return ok(unavailable('stale-source'));
  const rows: ReceiverRow[] = [];
  for (const source of input.sources) {
    const result = sourceRows(input, source);
    if (!result.ok) return result;
    rows.push(...result.value);
  }
  rows.sort((a, b) => a.rasterRow - b.rasterRow);
  if (
    rows.length > input.raster.records.length / VISIBLE_SURFACE_RECORD_WORDS ||
    rows.some((row, index) => index > 0 && rows[index - 1]?.rasterRow === row.rasterRow)
  )
    return invalid('one unambiguous canonical identity per admitted raster row');
  const acceptedSource: AcceptedSource = Object.freeze([...expected]);
  const snapshot = Object.freeze(rows);
  let gpu:
    | {
        readonly frame: number;
        readonly dimension: number;
        readonly bytes: number;
        readonly source: FieldReceiverGpuSource;
      }
    | undefined;
  return ok(
    Object.freeze({
      state: 'ready',
      acceptedSource,
      frameOwner: input.owner.identity,
      gpuSource: (
        current: AcceptedSource,
        frameOwner: object,
        frame: number,
        limits: { readonly maxTextureDimension2D: number; readonly maxBytes: number },
      ) => {
        if (frameOwner !== input.owner.identity || !input.owner.current())
          return ok(unavailable('stale-owner'));
        if (!sameSource(acceptedSource, current)) return ok(unavailable('stale-source'));
        if (
          gpu?.frame === frame &&
          gpu.dimension === limits.maxTextureDimension2D &&
          gpu.bytes === limits.maxBytes
        )
          return ok(gpu.source);
        const packed = packFieldReceiverGpuSource(
          snapshot.filter(
            (row): row is ReceiverRange & { readonly state: 'identified' } =>
              row.state === 'identified',
          ),
          input.raster.records.length / VISIBLE_SURFACE_RECORD_WORDS,
          acceptedSource,
          frame,
          input.raster.source?.revision ?? 0,
          limits,
        );
        if (packed.ok)
          gpu = {
            frame,
            dimension: limits.maxTextureDimension2D,
            bytes: limits.maxBytes,
            source: packed.value,
          };
        return packed;
      },
      resolve: (
        rasterRow: number,
        primitive: number,
        current: AcceptedSource,
        frameOwner: object,
      ) =>
        resolveIdentity(
          snapshot,
          acceptedSource,
          input.owner,
          rasterRow,
          primitive,
          current,
          frameOwner,
        ),
    }),
  );
}
