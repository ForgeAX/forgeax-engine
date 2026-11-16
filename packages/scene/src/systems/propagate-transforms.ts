import {
  defineSystem,
  defineSystemSet,
  type EcsError,
  ENTITY_NULL_RAW,
  type EntityHandle,
  FixedUpdate,
  type Query,
  type System,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import {
  createEntityLookup,
  type DerivedColumnBinding,
  type DerivedRangeCursor,
  type DerivedRangeWriter,
  type EntityLookup,
  getDerivedWriter,
} from '@forgeax/engine-ecs/internal';
import { type RemovedComponentsCursor, worldRead } from '@forgeax/engine-ecs/world-read';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import { GlobalTransform, Transform, TransformTreeChanged } from '../components/transform';
import { SceneError } from '../errors';
import { publishPresentationTransforms, registerTransformInterpolation } from '../presentation';

export const TransformSet = defineSystemSet({ name: 'transform' });
export const TransformFixedSet = defineSystemSet({ name: 'transform-fixed' });

/**
 * Optional, test-owned counters for the parent-first executor. The counters
 * are disabled unless a caller brackets a run with begin/end; production
 * propagation therefore pays only one predictable branch per instrumented
 * event. They are deliberately not a second execution state or a public
 * dirty/cache contract.
 */
export interface TransformPropagationTrace {
  hierarchyRootInvocations: number;
  hierarchyRootCursorReuses: number;
  hierarchyRootCursorAllocations: number;
  hierarchyEntityLookups: number;
  hierarchyRowsEvaluated: number;
  hierarchyEdgesVisited: number;
  hierarchyPublishedRows: number;
  hierarchyPublishedRuns: number;
  hierarchyResidualParentProbes: number;
  flatStructuralRootRows: number;
}

let propagationTrace: TransformPropagationTrace | undefined;

export function beginTransformPropagationTrace(): void {
  propagationTrace = {
    hierarchyRootInvocations: 0,
    hierarchyRootCursorReuses: 0,
    hierarchyRootCursorAllocations: 0,
    hierarchyEntityLookups: 0,
    hierarchyRowsEvaluated: 0,
    hierarchyEdgesVisited: 0,
    hierarchyPublishedRows: 0,
    hierarchyPublishedRuns: 0,
    hierarchyResidualParentProbes: 0,
    flatStructuralRootRows: 0,
  };
}

export function endTransformPropagationTrace(): TransformPropagationTrace {
  const trace = propagationTrace;
  propagationTrace = undefined;
  if (trace !== undefined) return trace;
  return {
    hierarchyRootInvocations: 0,
    hierarchyRootCursorReuses: 0,
    hierarchyRootCursorAllocations: 0,
    hierarchyEntityLookups: 0,
    hierarchyRowsEvaluated: 0,
    hierarchyEdgesVisited: 0,
    hierarchyPublishedRows: 0,
    hierarchyPublishedRuns: 0,
    hierarchyResidualParentProbes: 0,
    flatStructuralRootRows: 0,
  };
}

// Grow the walk stamps to cover `slot` and mark it with this walk.
function stampWalk(scratch: Scratch, slot: number, walkId: number): void {
  if (slot >= scratch.walkStamp.length) {
    const grown = new Int32Array(Math.max(slot + 1, scratch.walkStamp.length * 2));
    grown.set(scratch.walkStamp);
    scratch.walkStamp = grown;
  }
  scratch.walkStamp[slot] = walkId;
}

function countPropagation(name: keyof TransformPropagationTrace, amount = 1): void {
  const trace = propagationTrace;
  if (trace !== undefined) trace[name] += amount;
}

interface Scratch {
  world: World;
  /** DFS stack: entity, binding (hierarchy index, or -1 - index for a root's flat binding), row, changed. */
  hierarchyStackEntities: Float64Array;
  hierarchyStackBindings: Int32Array;
  hierarchyStackRows: Int32Array;
  hierarchyStackChanged: Uint8Array;
  hierarchyChildCursor: DerivedRangeCursor;
  hierarchyTouched: number[];
  flatCursor: DerivedRangeCursor;
  flatTouched: number[];
  seeds: EntityHandle[];
  /** Entity slots that lost their ChildOf this run; their world no longer follows a parent. */
  detachedFlags: Uint8Array;
  detachedSlots: number[];
  roots: EntityHandle[];
  /** (entity, bindingIndex, row) of each root written this run. */
  rootRows: number[];
  /** Mutation epoch when the previous run finished; later epochs are "changed". */
  lastRun: number;
  /** TransformTreeChanged and ChildOf.parent by entity. */
  treeLookup: EntityLookup;
  /** Block words and first index of the Children array `readChildren` located. */
  childrenWords: Uint32Array;
  childrenBase: number;
  /** Children.entities and GlobalTransform by entity. */
  childrenLookup: EntityLookup;
  markOrphans: RemovedComponentsCursor;
  removedTransforms: RemovedComponentsCursor;
  removedGlobals: RemovedComponentsCursor;
  /** Last walk that flagged each slot; a walk meeting its own stamp has cycled. */
  walkStamp: Int32Array;
  walkId: number;
  /** Rows cut from a broken or cyclic edge, re-derived as local roots. */
  fallbackRoots: EntityHandle[];
  cutMembers: EntityHandle[];
  walkError: SceneError | undefined;
  syncOrphans: RemovedComponentsCursor;
  dirtyTransforms?: Query<readonly []>;
  dirtyParents?: Query<readonly []>;
  addedGlobals?: Query<readonly []>;
  /** GlobalTransform writes from outside this owner; their rows are re-derived. */
  dirtyGlobals?: Query<readonly []>;
  editedGlobals: EntityHandle[];
  dirtyRoots?: Query<readonly []>;
  /** Every parentless entity that lists children, flagged or not. */
  allRoots?: Query<readonly []>;
  /** Entities whose Transform or GlobalTransform was removed since the previous run. */
  lostPairs: EntityHandle[];
  transformSpans: SpanItem[];
  /** Tables holding a hierarchy member, for the dense check. */
  treeTables: number[];
  /** Hierarchy rows counted by the last dense check; 0 when unknown. */
  treeRows: number;
  parentSpans: SpanItem[];
  addedSpans: SpanItem[];
  /** This run flagged only the roots; every listed child is entered. */
  dense: boolean;
  flatQuery?: FlatQuery;
  flatAddedQuery?: FlatQuery;
  hierarchyQuery?: HierarchyQuery;
  transformQuery?: TransformQuery;
  hierarchyWriter?: HierarchyWriter;
  transformWriter?: TransformWriter;
  missingGlobalQuery?: MissingGlobalQuery;
  missingTransformQuery?: MissingTransformQuery;
}

type FlatQuery = Query<readonly [typeof Transform], readonly [typeof GlobalTransform]>;
type HierarchyQuery = Query<
  readonly [typeof Transform, typeof ChildOf],
  readonly [typeof GlobalTransform]
>;
type TransformQuery = Query<readonly [typeof Transform], readonly [typeof GlobalTransform]>;
type HierarchyWriter = DerivedRangeWriter<
  typeof Transform | typeof ChildOf,
  typeof GlobalTransform
>;
type TransformWriter = DerivedRangeWriter<typeof Transform, typeof GlobalTransform>;
type HierarchyBinding = DerivedColumnBinding<
  typeof Transform | typeof ChildOf,
  typeof GlobalTransform
>;
type TransformBinding = DerivedColumnBinding<typeof Transform, typeof GlobalTransform>;
type MissingGlobalQuery = Query<readonly [], readonly [], readonly []>;
type MissingTransformQuery = Query<readonly [], readonly [], readonly []>;

interface RegistrationLease {
  refs: number;
  releasePresentation: () => void;
}

const SCRATCH = new WeakMap<World, Scratch>();
const REGISTRATION_LEASES = new WeakMap<World, RegistrationLease>();

function pairError<T = void>(entity: EntityHandle, expected: string): Result<T, SceneError> {
  return err(
    new SceneError({
      code: 'hierarchy-broken',
      expected,
      hint: 'attach both Transform and GlobalTransform at scene authoring or import time, then retry propagation',
      detail: { entity, parent: entity },
    }),
  );
}

function queriesReady(scratch: Scratch): boolean {
  return (
    scratch.flatQuery !== undefined &&
    scratch.flatAddedQuery !== undefined &&
    scratch.hierarchyQuery !== undefined &&
    scratch.transformQuery !== undefined &&
    scratch.hierarchyWriter !== undefined &&
    scratch.transformWriter !== undefined &&
    scratch.missingGlobalQuery !== undefined &&
    scratch.missingTransformQuery !== undefined
  );
}

function ensureQueries(world: World, scratch: Scratch): Result<void, SceneError> {
  if (queriesReady(scratch)) return ok(undefined);
  const flatOutput = world.query({
    read: [Transform],
    write: [GlobalTransform],
    without: [ChildOf, Children],
    changed: [Transform],
  });
  const flatAdded = world.query({
    read: [Transform],
    write: [GlobalTransform],
    without: [ChildOf, Children],
    added: [GlobalTransform],
  });
  scratch.dirtyTransforms ??= world.query({ changed: [Transform] }).unwrap();
  scratch.dirtyParents ??= world.query({ changed: [ChildOf] }).unwrap();
  scratch.addedGlobals ??= world.query({ added: [GlobalTransform] }).unwrap();
  scratch.dirtyGlobals ??= world.query({ changed: [GlobalTransform] }).unwrap();
  scratch.dirtyRoots ??= world
    .query({ with: [Children], without: [ChildOf], changed: [TransformTreeChanged] })
    .unwrap();
  scratch.allRoots ??= world.query({ with: [Children], without: [ChildOf] }).unwrap();
  const hierarchy = world.query({
    read: [Transform, ChildOf],
    write: [GlobalTransform],
  });
  const transform = world.query({
    read: [Transform],
    write: [GlobalTransform],
  });
  const missingGlobal = world.query({
    with: [Transform],
    without: [GlobalTransform],
  });
  const missingTransform = world.query({
    with: [GlobalTransform],
    without: [Transform],
  });
  if (
    !flatOutput.ok ||
    !flatAdded.ok ||
    !hierarchy.ok ||
    !transform.ok ||
    !missingGlobal.ok ||
    !missingTransform.ok
  ) {
    return pairError(0 as EntityHandle, 'valid Transform and GlobalTransform pair queries');
  }
  const hierarchyWriter = getDerivedWriter(hierarchy.value, GlobalTransform);
  const transformWriter = getDerivedWriter(transform.value, GlobalTransform);
  if (!hierarchyWriter.ok || !transformWriter.ok) {
    return pairError(0 as EntityHandle, 'dense Transform and ChildOf derived bindings');
  }
  scratch.flatQuery = flatOutput.value as FlatQuery;
  scratch.flatAddedQuery = flatAdded.value as FlatQuery;
  scratch.hierarchyQuery = hierarchy.value as HierarchyQuery;
  scratch.transformQuery = transform.value as TransformQuery;
  scratch.hierarchyWriter = hierarchyWriter.value as HierarchyWriter;
  scratch.transformWriter = transformWriter.value as TransformWriter;
  scratch.missingGlobalQuery = missingGlobal.value as MissingGlobalQuery;
  scratch.missingTransformQuery = missingTransform.value as MissingTransformQuery;
  return ok(undefined);
}

function validateTransformPairs(world: World, scratch: Scratch): Result<void, SceneError> {
  const queryResult = ensureQueries(world, scratch);
  if (!queryResult.ok) return queryResult;
  const missingGlobal = scratch.missingGlobalQuery;
  const missingTransform = scratch.missingTransformQuery;
  if (missingGlobal === undefined || missingTransform === undefined) {
    return pairError(0 as EntityHandle, 'valid Transform and GlobalTransform pair queries');
  }
  for (const span of missingGlobal.spans().unwrap()) {
    if (span.length > 0)
      return pairError(
        span.entities[0] as EntityHandle,
        'each Transform entity to carry a GlobalTransform pair',
      );
  }
  for (const span of missingTransform.spans().unwrap()) {
    if (span.length > 0)
      return pairError(
        span.entities[0] as EntityHandle,
        'each GlobalTransform entity to carry a Transform pair',
      );
  }
  return ok(undefined);
}

function scratchFor(world: World): Scratch {
  const existing = SCRATCH.get(world);
  if (existing !== undefined) return existing;
  const created: Scratch = {
    world,
    hierarchyStackEntities: new Float64Array(64),
    hierarchyStackBindings: new Int32Array(64),
    hierarchyStackRows: new Int32Array(64),
    hierarchyStackChanged: new Uint8Array(64),
    hierarchyChildCursor: { bindingIndex: -1, row: -1 },
    hierarchyTouched: [],
    flatCursor: { bindingIndex: -1, row: -1 },
    flatTouched: [],
    seeds: [],
    detachedFlags: new Uint8Array(1024),
    detachedSlots: [],
    roots: [],
    rootRows: [],
    lastRun: 0,
    treeLookup: createEntityLookup(
      world,
      [TransformTreeChanged, ChildOf, Children, Transform, GlobalTransform],
      [[1, 'parent']],
    ),
    childrenWords: new Uint32Array(0),
    childrenBase: 0,
    childrenLookup: createEntityLookup(world, [Children, GlobalTransform], [[0, 'entities']]),
    editedGlobals: [],
    lostPairs: [],
    transformSpans: [],
    treeTables: [],
    treeRows: 0,
    parentSpans: [],
    addedSpans: [],
    dense: false,
    markOrphans: { value: 0 },
    removedTransforms: { value: 0 },
    removedGlobals: { value: 0 },
    walkStamp: new Int32Array(1024),
    walkId: 0,
    fallbackRoots: [],
    cutMembers: [],
    walkError: undefined,
    syncOrphans: { value: 0 },
  };
  SCRATCH.set(world, created);
  return created;
}

function composeFlatColumns(
  positions: ArrayLike<number>,
  rotations: ArrayLike<number>,
  scales: ArrayLike<number>,
  worlds: Float32Array,
  count: number,
  worldBase: number,
  sourceRow = 0,
): void {
  for (let row = 0; row < count; row += 1) {
    const position = (sourceRow + row) * 3;
    const rotation = (sourceRow + row) * 4;
    const world = (worldBase + row) * 16;
    const x = rotations[rotation] ?? 0;
    const y = rotations[rotation + 1] ?? 0;
    const z = rotations[rotation + 2] ?? 0;
    const w = rotations[rotation + 3] ?? 1;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = scales[position] ?? 1;
    const sy = scales[position + 1] ?? 1;
    const sz = scales[position + 2] ?? 1;

    worlds[world] = (1 - (yy + zz)) * sx;
    worlds[world + 1] = (xy + wz) * sx;
    worlds[world + 2] = (xz - wy) * sx;
    worlds[world + 3] = 0;
    worlds[world + 4] = (xy - wz) * sy;
    worlds[world + 5] = (1 - (xx + zz)) * sy;
    worlds[world + 6] = (yz + wx) * sy;
    worlds[world + 7] = 0;
    worlds[world + 8] = (xz + wy) * sz;
    worlds[world + 9] = (yz - wx) * sz;
    worlds[world + 10] = (1 - (xx + yy)) * sz;
    worlds[world + 11] = 0;
    worlds[world + 12] = positions[position] ?? 0;
    worlds[world + 13] = positions[position + 1] ?? 0;
    worlds[world + 14] = positions[position + 2] ?? 0;
    worlds[world + 15] = 1;
  }
}

function composeFlatRange(
  binding: TransformBinding,
  base: number,
  start: number,
  count: number,
  context: unknown,
): void {
  const local = context as TransformColumnShape;
  composeFlatColumns(local.pos, local.quat, local.scale, worldColumn(binding), count, base + start);
}

interface TransformColumnShape {
  readonly pos: ArrayLike<number>;
  readonly quat: ArrayLike<number>;
  readonly scale: ArrayLike<number>;
}

interface OutputColumnShape {
  readonly world: Float32Array;
}

function transformColumns(binding: TransformBinding | HierarchyBinding): TransformColumnShape {
  return binding.read as unknown as TransformColumnShape;
}

function worldColumn(binding: TransformBinding | HierarchyBinding): Float32Array {
  return (binding.write as unknown as OutputColumnShape).world;
}

function hierarchyError(
  code: 'hierarchy-broken' | 'hierarchy-cycle',
  entity: EntityHandle,
  parent: EntityHandle,
  expected: string,
  hint: string,
): SceneError {
  return new SceneError({ code, expected, hint, detail: { entity, parent } });
}

function composeBindingRow(
  binding: TransformBinding | HierarchyBinding,
  row: number,
  parentWorld: Float32Array | undefined,
  parentRow: number,
  touched: number[],
  bindingIndex: number,
): void {
  // Hierarchy bindings carry the parent column; flat structural-root repair
  // uses the same numeric kernel but is intentionally counted separately.
  const local = transformColumns(binding);
  if (propagationTrace !== undefined && 'parent' in (local as object))
    countPropagation('hierarchyRowsEvaluated');
  const positions = local.pos;
  const rotations = local.quat;
  const scales = local.scale;
  const worlds = worldColumn(binding);
  // One fused pass: compose Local, multiply by the parent's world matrix and
  // compare in registers. Each step rounds to f32 where the matrix path stored
  // to a Float32Array, so the result matches it bit for bit.
  const fround = Math.fround;
  const position = row * 3;
  const rotation = row * 4;
  const x = rotations[rotation] as number;
  const y = rotations[rotation + 1] as number;
  const z = rotations[rotation + 2] as number;
  const w = rotations[rotation + 3] as number;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = scales[position] as number;
  const sy = scales[position + 1] as number;
  const sz = scales[position + 2] as number;
  const b00 = fround((1 - (yy + zz)) * sx);
  const b01 = fround((xy + wz) * sx);
  const b02 = fround((xz - wy) * sx);
  const b10 = fround((xy - wz) * sy);
  const b11 = fround((1 - (xx + zz)) * sy);
  const b12 = fround((yz + wx) * sy);
  const b20 = fround((xz + wy) * sz);
  const b21 = fround((yz - wx) * sz);
  const b22 = fround((1 - (xx + yy)) * sz);
  const b30 = fround(positions[position] as number);
  const b31 = fround(positions[position + 1] as number);
  const b32 = fround(positions[position + 2] as number);
  let m0 = b00;
  let m1 = b01;
  let m2 = b02;
  const m3 = 0;
  let m4 = b10;
  let m5 = b11;
  let m6 = b12;
  const m7 = 0;
  let m8 = b20;
  let m9 = b21;
  let m10 = b22;
  const m11 = 0;
  let m12 = b30;
  let m13 = b31;
  let m14 = b32;
  const m15 = 1;
  if (parentWorld !== undefined) {
    // Global = Parent * Local for affine matrices (last column 0, 0, 0, 1),
    // column-major, in mat4.multiply's term order.
    const p = parentRow * 16;
    const a00 = parentWorld[p] as number;
    const a01 = parentWorld[p + 1] as number;
    const a02 = parentWorld[p + 2] as number;
    const a10 = parentWorld[p + 4] as number;
    const a11 = parentWorld[p + 5] as number;
    const a12 = parentWorld[p + 6] as number;
    const a20 = parentWorld[p + 8] as number;
    const a21 = parentWorld[p + 9] as number;
    const a22 = parentWorld[p + 10] as number;
    const a30 = parentWorld[p + 12] as number;
    const a31 = parentWorld[p + 13] as number;
    const a32 = parentWorld[p + 14] as number;
    m0 = fround(a00 * b00 + a10 * b01 + a20 * b02);
    m1 = fround(a01 * b00 + a11 * b01 + a21 * b02);
    m2 = fround(a02 * b00 + a12 * b01 + a22 * b02);
    m4 = fround(a00 * b10 + a10 * b11 + a20 * b12);
    m5 = fround(a01 * b10 + a11 * b11 + a21 * b12);
    m6 = fround(a02 * b10 + a12 * b11 + a22 * b12);
    m8 = fround(a00 * b20 + a10 * b21 + a20 * b22);
    m9 = fround(a01 * b20 + a11 * b21 + a21 * b22);
    m10 = fround(a02 * b20 + a12 * b21 + a22 * b22);
    m12 = fround(a00 * b30 + a10 * b31 + a20 * b32 + a30);
    m13 = fround(a01 * b30 + a11 * b31 + a21 * b32 + a31);
    m14 = fround(a02 * b30 + a12 * b31 + a22 * b32 + a32);
  }
  const o = row * 16;
  touched.push(bindingIndex, row);
  worlds[o] = m0;
  worlds[o + 1] = m1;
  worlds[o + 2] = m2;
  worlds[o + 3] = m3;
  worlds[o + 4] = m4;
  worlds[o + 5] = m5;
  worlds[o + 6] = m6;
  worlds[o + 7] = m7;
  worlds[o + 8] = m8;
  worlds[o + 9] = m9;
  worlds[o + 10] = m10;
  worlds[o + 11] = m11;
  worlds[o + 12] = m12;
  worlds[o + 13] = m13;
  worlds[o + 14] = m14;
  worlds[o + 15] = m15;
}

function releaseScratch(world: World): void {
  const scratch = SCRATCH.get(world);
  if (scratch === undefined) return;
  SCRATCH.delete(world);
}

function derivedWriteError(cause: EcsError, bindingIndex: number): SceneError {
  return new SceneError({
    code: 'hierarchy-broken',
    expected: 'derived GlobalTransform range publication to succeed',
    hint: cause.hint ?? 'retry propagation on a healthy World',
    detail: {
      kind: 'derived-write',
      entity: 0 as EntityHandle,
      parent: 0 as EntityHandle,
      bindingIndex,
      base: 0,
      start: 0,
      count: 0,
      cause,
    },
  });
}

/**
 * Locate a child once for the whole edge: its hierarchy binding and row land
 * in `cursor`, and `scratch.treeLookup` holds its tree marker and parent.
 */
function findHierarchyLocation(
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  entity: EntityHandle,
  cursor: DerivedRangeCursor,
  scratch: Scratch,
): HierarchyBinding | undefined {
  countPropagation('hierarchyEntityLookups');
  const lookup = scratch.treeLookup;
  if (!lookup.get(entity)) return undefined;
  const bindingIndex = writer.bindingOfTable(lookup.tableId);
  const binding = bindings[bindingIndex];
  const row = lookup.row;
  if (binding === undefined || row >= binding.rowCapacity) return undefined;
  cursor.bindingIndex = bindingIndex;
  cursor.row = row;
  return binding;
}

function countPublishedRows(touched: readonly number[], ranges: number): void {
  const trace = propagationTrace;
  if (trace === undefined) return;
  trace.hierarchyPublishedRows += touched.length / 2;
  trace.hierarchyPublishedRuns += ranges;
}

// A mismatched Children entry is an error unless its row was detached.
function noteMismatch(
  scratch: Scratch,
  current: SceneError | undefined,
  child: EntityHandle,
  parent: EntityHandle,
): SceneError | undefined {
  if (scratch.detachedFlags[scratch.treeLookup.slot] === 2) return current;
  return noteHierarchyError(
    current,
    hierarchyError(
      'hierarchy-broken',
      child,
      parent,
      'each Children entry to name its parent in ChildOf',
      'repair the hierarchy with world.reparent or ChildOf edits; a mismatched entry also means a cycle',
    ),
  );
}

function noteHierarchyError(current: SceneError | undefined, next: SceneError): SceneError {
  if (current === undefined) return next;
  const currentEntity = Number(current.detail?.entity ?? Number.MAX_SAFE_INTEGER);
  const nextEntity = Number(next.detail?.entity ?? Number.MAX_SAFE_INTEGER);
  return nextEntity < currentEntity ||
    (nextEntity === currentEntity && next.code.localeCompare(current.code) < 0)
    ? next
    : current;
}

/**
 * Flat rows (no ChildOf, no Children) whose Transform changed or whose
 * GlobalTransform was just added: GlobalTransform = Transform.
 */
function syncFlatQuery(scratch: Scratch, query: FlatQuery | undefined): Result<void, SceneError> {
  if (query === undefined)
    return pairError(0 as EntityHandle, 'a valid flat Transform write query');
  const spans = query.spans();
  if (!spans.ok) return pairError(0 as EntityHandle, 'dense numeric Transform spans');
  const writer = scratch.transformWriter;
  let bindingIndex = 0;
  try {
    for (const span of spans.value) {
      const local = span.get(Transform);
      const first = span.entities[0];
      if (
        first === undefined ||
        writer === undefined ||
        !writer.locateEntity(first as EntityHandle, scratch.flatCursor)
      )
        return pairError(first as EntityHandle, 'a live dense Transform range');
      const cursor = scratch.flatCursor;
      const written = writer.writeRange(
        cursor.bindingIndex,
        cursor.row,
        0,
        span.length,
        composeFlatRange,
        local,
      );
      if (!written.ok) return err(derivedWriteError(written.error, cursor.bindingIndex));
      bindingIndex += 1;
    }
  } catch (cause) {
    return err(derivedWriteError(cause as EcsError, bindingIndex));
  }
  return ok(undefined);
}

/**
 * Write flat rows from the Transform binding with no parent, publishing only
 * the rows it recomputed. `accept` filters each located entity.
 */
function writeLocalRows(
  scratch: Scratch,
  entities: readonly EntityHandle[],
  accept: (entity: EntityHandle) => boolean,
  located: number[] | undefined,
  write: (entity: EntityHandle) => boolean = () => true,
): Result<void, SceneError> {
  const writer = scratch.transformWriter;
  if (writer === undefined)
    return pairError(0 as EntityHandle, 'dense Transform and GlobalTransform derived bindings');
  const bindings = writer.bindings as readonly TransformBinding[];
  const cursor = scratch.flatCursor;
  const touched = scratch.flatTouched;
  touched.length = 0;
  const published = writer.writeRows(touched, () => {
    for (const entity of entities) {
      if (!writer.locateEntity(entity, cursor) || !accept(entity)) continue;
      const binding = bindings[cursor.bindingIndex];
      if (binding === undefined) continue;
      if (write(entity))
        composeBindingRow(binding, cursor.row, undefined, 0, touched, cursor.bindingIndex);
      located?.push(entity, cursor.bindingIndex, cursor.row);
    }
  });
  touched.length = 0;
  return published.ok ? ok(undefined) : err(derivedWriteError(published.error, -1));
}

function collectEntities(query: Query<readonly []> | undefined, out: EntityHandle[]): void {
  for (const span of query?.spans().unwrap() ?? [])
    for (let row = 0; row < span.length; row++) out.push(span.entities[row] as EntityHandle);
}

function readOrphans(world: World, cursor: RemovedComponentsCursor, out: EntityHandle[]): void {
  world[worldRead].readRemoved(ChildOf, cursor, (entity) => {
    out.push(entity);
  });
}

/**
 * Locate one entity's Children in place and return its count; entries are
 * `childrenWords[childrenBase + i]`. Nothing here edits Children, so the
 * location stays valid while the caller walks it.
 */
function readChildren(scratch: Scratch, tableId: number, row: number): number {
  const lookup = scratch.childrenLookup;
  if (!lookup.at(tableId, row)) return 0;
  const location = lookup.columns.fields[0]?.view;
  if (location === undefined) return 0;
  const base = lookup.row * 3;
  const count = location[base + 2] as number;
  if (count === 0) return 0;
  scratch.childrenWords = lookup.arrays.u32(location[base] as number);
  scratch.childrenBase = (location[base + 1] as number) >>> 2;
  return count;
}

/** Reads the child `findHierarchyLocation` just located. */
function childTreeChanged(scratch: Scratch, since: number): boolean {
  if (scratch.dense) return true;
  const lookup = scratch.treeLookup;
  return (lookup.columns.changed[0]?.epochs[lookup.row] ?? 0) > since;
}

/** Share of the hierarchy's rows that must have changed to flag only the roots. */
const DENSE_NUMERATOR = 1;
const DENSE_DENOMINATOR = 2;

type SpanItem =
  ReturnType<ReturnType<Query<readonly []>['spans']>['unwrap']> extends Iterable<infer Item>
    ? Item
    : never;
type SpanList = readonly SpanItem[];

/** A change-filtered query lists each window once, so its spans are kept. */
function collectSpans(query: Query<readonly []> | undefined, out: SpanItem[]): SpanItem[] {
  out.length = 0;
  for (const span of query?.spans().unwrap() ?? []) out.push(span);
  return out;
}

function listRows(spans: SpanList): number {
  let rows = 0;
  for (const span of spans) rows += span.length;
  return rows;
}

/**
 * Whether this run can skip the per-seed walks: the hierarchy has not changed
 * shape since the previous run and most of its rows were rewritten, so
 * flagging every root and entering every listed child costs less than
 * flagging the ancestors of each seed. A change-filtered query lists its
 * spans once per window, so the caller passes the lists it will walk.
 */
function denseRun(
  scratch: Scratch,
  transformSpans: SpanList,
  parentSpans: SpanList,
  addedSpans: SpanList,
): boolean {
  if (scratch.detachedSlots.length > 0 || scratch.lostPairs.length > 0) return false;
  if (scratch.editedGlobals.length > 0 || scratch.seeds.length > 0) return false;
  if (listRows(parentSpans) > 0 || listRows(addedSpans) > 0) {
    scratch.treeRows = 0;
    return false;
  }
  // The member count only steers the choice, so a stale one is safe: it is
  // recounted whenever the changed rows could reach half of it.
  if (scratch.treeRows > 0 && listRows(transformSpans) * DENSE_DENOMINATOR < scratch.treeRows)
    return false;
  const tables = scratch.treeTables;
  tables.length = 0;
  let members = 0;
  for (const span of scratch.hierarchyQuery?.spans().unwrap() ?? []) {
    tables.push(span.tableId);
    members += span.length;
  }
  for (const span of scratch.allRoots?.spans().unwrap() ?? []) {
    tables.push(span.tableId);
    members += span.length;
  }
  scratch.treeRows = members;
  let dirty = 0;
  for (const span of transformSpans) if (tables.includes(span.tableId)) dirty += span.length;
  if (dirty === 0) return false;
  return dirty * DENSE_DENOMINATOR >= members * DENSE_NUMERATOR;
}

/**
 * Reads everything the run depends on, once: removals and the change-filtered
 * span lists. Returns the run's result when it was dense and is already done,
 * and undefined when the per-seed walks must follow.
 */
function readRunInputs(world: World, scratch: Scratch): Result<void, SceneError> | undefined {
  // Removals are read before any walk, so the dense check sees every change.
  const orphans = scratch.seeds;
  orphans.length = 0;
  readOrphans(world, scratch.markOrphans, orphans);
  const lost = scratch.lostPairs;
  lost.length = 0;
  const readLost = (entity: EntityHandle): void => {
    lost.push(entity);
  };
  world[worldRead].readRemoved(Transform, scratch.removedTransforms, readLost);
  world[worldRead].readRemoved(GlobalTransform, scratch.removedGlobals, readLost);
  const transformSpans = collectSpans(scratch.dirtyTransforms, scratch.transformSpans);
  const parentSpans = collectSpans(scratch.dirtyParents, scratch.parentSpans);
  const addedSpans = collectSpans(scratch.addedGlobals, scratch.addedSpans);
  if (!denseRun(scratch, transformSpans, parentSpans, addedSpans)) return undefined;
  scratch.dense = true;
  const flagged = flagAllRoots(scratch);
  return flagged === undefined ? ok(undefined) : err(flagged);
}

function setDetachedFlag(scratch: Scratch, slot: number, flag: 1 | 2): void {
  if (slot >= scratch.detachedFlags.length) {
    const grown = new Uint8Array(Math.max(slot + 1, scratch.detachedFlags.length * 2));
    grown.set(scratch.detachedFlags);
    scratch.detachedFlags = grown;
  }
  scratch.detachedFlags[slot] = flag;
  scratch.detachedSlots.push(slot);
}

/** Flag every root once; the walk then enters each listed child. */
function flagAllRoots(scratch: Scratch): SceneError | undefined {
  const lookup = scratch.treeLookup;
  let epoch = 0;
  for (const span of scratch.allRoots?.spans().unwrap() ?? []) {
    for (let row = 0; row < span.length; row++) {
      if (!lookup.get(span.entities[row] as EntityHandle)) continue;
      if (lookup.columns.changed[0] === undefined || lookup.columns.changed[3] === undefined)
        continue;
      if (epoch === 0) {
        const reserved = lookup.nextEpoch();
        if (!reserved.ok) return derivedWriteError(reserved.error, -1);
        epoch = reserved.value;
      }
      lookup.markChanged(0, epoch);
    }
  }
  return undefined;
}

/**
 * Flag TransformTreeChanged on every ancestor of a changed Transform, a
 * changed ChildOf, a new GlobalTransform or an orphaned entity. A marker
 * already flagged since the last run (and not merely added) means the rest of
 * the path is flagged too.
 */
function markDirtyTrees(
  world: World,
  scratch: Scratch,
  since: number,
  runStart: number,
): Result<void, SceneError> {
  const lookup = scratch.treeLookup;
  // Every marker flagged by this pass shares one epoch, reserved on first use.
  let epoch = 0;
  // Siblings arrive together; a parent already walked from a previous seed
  // would stop its own walk at once.
  let walkedParent: EntityHandle | undefined;
  let failure: SceneError | undefined;
  // `tableId` >= 0 names the seed's already-known table row.
  const fallbackRoots = scratch.fallbackRoots;
  fallbackRoots.length = 0;
  const cutMembers = scratch.cutMembers;
  cutMembers.length = 0;
  scratch.walkError = undefined;
  scratch.dense = false;
  // A cut row keeps its subtree finite: it is re-derived as a local root.
  const cut = (
    code: 'hierarchy-broken' | 'hierarchy-cycle',
    child: EntityHandle,
    parent: EntityHandle,
  ): void => {
    scratch.walkError = noteHierarchyError(
      scratch.walkError,
      code === 'hierarchy-cycle'
        ? hierarchyError(
            code,
            child,
            parent,
            'a ChildOf chain that ends at a root',
            'break the cycle with world.reparent or by removing one ChildOf',
          )
        : hierarchyError(
            code,
            child,
            parent,
            'each ChildOf parent to be alive with Transform and GlobalTransform',
            'reparent or detach the child before despawning the parent or removing its transform',
          ),
    );
    fallbackRoots.push(child);
  };
  // Every member of a cycle is cut; only `closing` is re-derived as a root, so
  // the members below it are reached once from it and not reported again.
  const cutCycle = (closing: EntityHandle, parent: EntityHandle, steps: number): void => {
    countPropagation('hierarchyResidualParentProbes', steps);
    cut('hierarchy-cycle', closing, parent);
    let member = parent;
    for (let guard = 0; member !== closing && guard < steps; guard++) {
      cutMembers.push(member);
      const above = world[worldRead].getFieldValue(member, ChildOf, 'parent');
      if (above === undefined) break;
      member = above as EntityHandle;
    }
  };
  const cutBroken = (child: EntityHandle | undefined, next: EntityHandle): void => {
    if (child !== undefined) cut('hierarchy-broken', child, next);
  };
  // The walked parent was flagged by this walk: `closing` closes a cycle.
  const cutIfFlagged = (
    closing: EntityHandle,
    parent: EntityHandle,
    walkId: number,
    steps: number,
  ): void => {
    if (lookup.get(parent) && scratch.walkStamp[lookup.slot] === walkId)
      cutCycle(closing, parent, steps);
  };
  // `tableId` >= 0 names the seed's already-known table row.
  const walkUp = (entity: EntityHandle, tableId: number, seedRow: number): boolean => {
    const walkId = ++scratch.walkId;
    let next = entity;
    // The row whose ChildOf names `next`.
    let child: EntityHandle | undefined;
    let steps = 0;
    let located = tableId >= 0 && lookup.at(tableId, seedRow);
    let seed = true;
    while (true) {
      const found = located || lookup.get(next);
      located = false;
      const columns = lookup.columns;
      const row = lookup.row;
      const changedColumn = columns.changed[0];
      if (!found || changedColumn === undefined || columns.changed[3] === undefined) {
        cutBroken(child, next);
        break;
      }
      if (seed) {
        seed = false;
        // A seed with a parent is found by the walk's own-input check, so only
        // its ancestors are flagged; a parentless seed is itself a dirty root.
        const above = columns.fields[0]?.view[row];
        // The null raw id and an absent column both fail the bound check.
        if ((above as number) < ENTITY_NULL_RAW) {
          if (above === walkedParent) break;
          walkedParent = above as EntityHandle;
          child = next;
          next = above as EntityHandle;
          continue;
        }
      }
      const slot = lookup.slot;
      const changed = changedColumn.epochs[row] as number;
      if (changed > runStart) {
        // Flagged by this very walk: the chain cycles back through `child`.
        if (scratch.walkStamp[slot] === walkId) cutCycle(child as EntityHandle, next, steps);
        break;
      }
      if (changed > since && !((columns.added[0]?.[row] as number) > since)) break;
      if (epoch === 0) {
        const reserved = lookup.nextEpoch();
        if (!reserved.ok) {
          failure = derivedWriteError(reserved.error, -1);
          return false;
        }
        epoch = reserved.value;
      }
      lookup.markChanged(0, epoch);
      stampWalk(scratch, slot, walkId);
      steps += 1;
      const parent = columns.fields[0]?.view[row];
      if (!((parent as number) < ENTITY_NULL_RAW)) break;
      if (parent === walkedParent) {
        cutIfFlagged(next, parent as EntityHandle, walkId, steps);
        break;
      }
      if (next === entity) walkedParent = parent as EntityHandle;
      child = next;
      next = parent as EntityHandle;
    }
    return true;
  };
  // Edited globals are read before this run writes any, so the list holds
  // only outside writes.
  const edited = scratch.editedGlobals;
  edited.length = 0;
  collectEntities(scratch.dirtyGlobals, edited);
  const dense = readRunInputs(world, scratch);
  if (dense !== undefined) return dense;
  const orphans = scratch.seeds;
  const transformSpans = scratch.transformSpans;
  const parentSpans = scratch.parentSpans;
  const addedSpans = scratch.addedSpans;
  for (const entity of edited) if (!walkUp(entity, -1, 0)) return err(failure as SceneError);
  // Seeds are walked straight from their query spans; no seed array is built.
  for (const spans of [transformSpans, parentSpans, addedSpans]) {
    for (const span of spans) {
      const entities = span.entities;
      const tableId = span.tableId;
      const rowStart = span.rowStart;
      // One location per span: a seed whose ChildOf parent was just walked
      // would stop at its first step, so it is skipped from the column.
      const parents = lookup.at(tableId, rowStart) ? lookup.columns.fields[0]?.view : undefined;
      for (let row = 0; row < span.length; row++) {
        if (parents !== undefined && parents[rowStart + row] === walkedParent) continue;
        if (!walkUp(entities[row] as EntityHandle, tableId, rowStart + row))
          return err(failure as SceneError);
      }
    }
  }
  for (const slot of scratch.detachedSlots) scratch.detachedFlags[slot] = 0;
  scratch.detachedSlots.length = 0;
  for (const entity of orphans) {
    if (scratch.treeLookup.get(entity)) {
      setDetachedFlag(scratch, scratch.treeLookup.slot, 1);
    }
    if (!walkUp(entity, -1, 0)) {
      orphans.length = 0;
      return err(failure as SceneError);
    }
  }
  orphans.length = 0;
  // A parent that lost its transform pair leaves its children without a
  // parent GlobalTransform; they are cut like a stale parent.
  const read = world[worldRead];
  const lostPair = (entity: EntityHandle): void => {
    const tree = scratch.treeLookup;
    if (
      tree.get(entity) &&
      tree.columns.changed[3] !== undefined &&
      tree.columns.changed[4] !== undefined
    )
      return;
    if (!scratch.childrenLookup.get(entity)) return;
    const count = readChildren(scratch, scratch.childrenLookup.tableId, scratch.childrenLookup.row);
    for (let index = 0; index < count; index++) {
      const child = scratch.childrenWords[scratch.childrenBase + index] as EntityHandle;
      if (read.getFieldValue(child, ChildOf, 'parent') === entity)
        cut('hierarchy-broken', child, entity);
    }
  };
  for (const entity of scratch.lostPairs) lostPair(entity);
  scratch.lostPairs.length = 0;
  for (const entity of fallbackRoots) cutMembers.push(entity);
  for (const entity of cutMembers) {
    if (!scratch.treeLookup.get(entity)) continue;
    // 2 marks a cut row: its own error already names the edge.
    setDetachedFlag(scratch, scratch.treeLookup.slot, 2);
  }
  cutMembers.length = 0;
  return ok(undefined);
}

function growHierarchyStack(scratch: Scratch, needed: number): void {
  if (needed <= scratch.hierarchyStackRows.length) return;
  const capacity = Math.max(needed, scratch.hierarchyStackRows.length * 2);
  const entities = new Float64Array(capacity);
  entities.set(scratch.hierarchyStackEntities);
  const bindings = new Int32Array(capacity);
  bindings.set(scratch.hierarchyStackBindings);
  const rows = new Int32Array(capacity);
  rows.set(scratch.hierarchyStackRows);
  const changed = new Uint8Array(capacity);
  changed.set(scratch.hierarchyStackChanged);
  scratch.hierarchyStackEntities = entities;
  scratch.hierarchyStackBindings = bindings;
  scratch.hierarchyStackRows = rows;
  scratch.hierarchyStackChanged = changed;
}

/**
 * Re-derive every flagged tree from its root. A child is skipped when neither
 * its own marker nor its parent's GlobalTransform changed; a child whose
 * ChildOf does not name the parent that lists it is reported and not entered.
 */
function propagateParentTransforms(
  world: World,
  scratch: Scratch,
  since: number,
): Result<void, SceneError> {
  const hierarchyWriter = scratch.hierarchyWriter;
  const transformWriter = scratch.transformWriter;
  if (hierarchyWriter === undefined || transformWriter === undefined) {
    return err(
      new SceneError({
        code: 'hierarchy-broken',
        expected: 'paired Transform and GlobalTransform derived bindings',
        hint: 'register the scene components before running TransformPropagation',
      }),
    );
  }
  const roots = scratch.roots;
  roots.length = 0;
  collectEntities(scratch.dirtyRoots, roots);
  for (const entity of scratch.fallbackRoots) roots.push(entity);
  scratch.fallbackRoots.length = 0;
  if (roots.length === 0) return ok(undefined);
  const rootRows = scratch.rootRows;
  rootRows.length = 0;
  const read = world[worldRead];
  const rootChanged = (entity: EntityHandle): boolean =>
    (scratch.treeLookup.get(entity) &&
      (scratch.detachedFlags[scratch.treeLookup.slot] ?? 0) !== 0) ||
    read.getChangedEpoch(entity, Transform) > since ||
    read.getChangedEpoch(entity, GlobalTransform) > since ||
    read.getAddedEpoch(entity, GlobalTransform) > since;
  const rootWrite = writeLocalRows(scratch, roots, () => true, rootRows, rootChanged);
  if (!rootWrite.ok) return rootWrite;
  const bindings = hierarchyWriter.bindings as readonly HierarchyBinding[];
  const transformBindings = transformWriter.bindings as readonly TransformBinding[];
  const cursor = scratch.hierarchyChildCursor;
  const touched = scratch.hierarchyTouched;
  touched.length = 0;
  let firstError: SceneError | undefined;
  const published = hierarchyWriter.writeRows(touched, () => {
    for (let located = 0; located < rootRows.length; located += 3) {
      const root = rootRows[located] as EntityHandle;
      const rootBinding = transformBindings[rootRows[located + 1] as number];
      const rootRow = rootRows[located + 2] as number;
      if (rootBinding === undefined) continue;
      countPropagation('hierarchyRootInvocations');
      countPropagation('hierarchyRootCursorReuses');
      scratch.hierarchyStackEntities[0] = root;
      scratch.hierarchyStackBindings[0] = -1 - (rootRows[located + 1] as number);
      scratch.hierarchyStackRows[0] = rootRow;
      scratch.hierarchyStackChanged[0] = Number(rootChanged(root));
      let depth = 1;
      while (depth > 0) {
        depth -= 1;
        const parent = scratch.hierarchyStackEntities[depth] as EntityHandle;
        const encoded = scratch.hierarchyStackBindings[depth] as number;
        const parentBinding = (
          encoded >= 0 ? bindings[encoded] : transformBindings[-1 - encoded]
        ) as TransformBinding | HierarchyBinding;
        const parentRow = scratch.hierarchyStackRows[depth] as number;
        const ownChanged = scratch.hierarchyStackChanged[depth] === 1;
        const count = readChildren(scratch, parentBinding.tableId, parentRow);
        if (count === 0) continue;
        const parentWorld = worldColumn(parentBinding);
        const parentGlobalChanged = scratch.childrenLookup.columns.changed[1];
        growHierarchyStack(scratch, depth + count);
        const stackEntities = scratch.hierarchyStackEntities;
        const stackBindings = scratch.hierarchyStackBindings;
        const stackRows = scratch.hierarchyStackRows;
        const stackChanged = scratch.hierarchyStackChanged;
        const parentChanged =
          ownChanged || (parentGlobalChanged?.epochs[scratch.childrenLookup.row] as number) > since;
        const children = scratch.childrenWords;
        const first = scratch.childrenBase;
        for (let index = 0; index < count; index++) {
          const child = children[first + index] as EntityHandle;
          // A cut cycle member may still list itself further down.
          if (child === root) continue;
          countPropagation('hierarchyEdgesVisited');
          const binding = findHierarchyLocation(hierarchyWriter, bindings, child, cursor, scratch);
          if (binding === undefined) continue;
          const row = cursor.row;
          const bindingIndex = cursor.bindingIndex;
          const columns = scratch.treeLookup.columns;
          // A changed parent recomputes every child, so the child's own
          // epochs matter only when the parent did not change.
          let ownChange = false;
          if (!parentChanged) {
            // An absent column reads undefined, which never compares greater.
            ownChange =
              (columns.changed[3]?.epochs[row] as number) > since ||
              (columns.changed[1]?.epochs[row] as number) > since ||
              (columns.changed[4]?.epochs[row] as number) > since ||
              (columns.added[4]?.[row] as number) > since;
            if (!ownChange && !childTreeChanged(scratch, since)) continue;
          }
          if (scratch.treeLookup.columns.fields[0]?.view[row] !== parent) {
            firstError = noteMismatch(scratch, firstError, child, parent);
            continue;
          }
          const recompute = parentChanged || ownChange;
          if (recompute)
            composeBindingRow(binding, row, parentWorld, parentRow, touched, bindingIndex);
          if (columns.changed[2] === undefined) continue;
          stackEntities[depth] = child;
          stackBindings[depth] = bindingIndex;
          stackRows[depth] = row;
          stackChanged[depth] = Number(recompute);
          depth += 1;
        }
      }
    }
  });
  if (!published.ok)
    firstError = noteHierarchyError(firstError, derivedWriteError(published.error, -1));
  else countPublishedRows(touched, published.value);
  touched.length = 0;
  return firstError === undefined ? ok(undefined) : err(firstError);
}

/** Flat rows: changed or newly paired ones, then orphans not already covered. */
function syncSimpleTransforms(
  world: World,
  scratch: Scratch,
  since: number,
): Result<void, SceneError> {
  const changed = syncFlatQuery(scratch, scratch.flatQuery);
  if (!changed.ok) return changed;
  const added = syncFlatQuery(scratch, scratch.flatAddedQuery);
  if (!added.ok) return added;
  const orphans = scratch.seeds;
  orphans.length = 0;
  readOrphans(world, scratch.syncOrphans, orphans);
  // Flat rows whose GlobalTransform was written from outside, re-derived like orphans.
  for (const entity of scratch.editedGlobals) orphans.push(entity);
  scratch.editedGlobals.length = 0;
  if (orphans.length === 0) return ok(undefined);
  const read = world[worldRead];
  const result = writeLocalRows(
    scratch,
    orphans,
    (entity) => {
      if (
        read.getFieldValue(entity, ChildOf, 'parent') !== undefined ||
        read.getArrayLength(entity, Children, 'entities') !== undefined ||
        read.getChangedEpoch(entity, Transform) > since ||
        read.getAddedEpoch(entity, GlobalTransform) > since
      )
        return false;
      countPropagation('flatStructuralRootRows');
      return true;
    },
    undefined,
  );
  orphans.length = 0;
  return result;
}

// Every change filter observes the same window: writes after this owner's
// previous run, excluding the markers and globals that run wrote itself.
function finishRun(world: World, scratch: Scratch): void {
  scratch.dirtyTransforms?.markObserved();
  scratch.dirtyParents?.markObserved();
  scratch.addedGlobals?.markObserved();
  scratch.dirtyGlobals?.markObserved();
  scratch.dirtyRoots?.markObserved();
  scratch.flatQuery?.markObserved();
  scratch.flatAddedQuery?.markObserved();
  scratch.lastRun = world[worldRead].getMutationEpoch();
}

export function propagateTransforms(world: World): Result<void, SceneError> {
  const scratch = scratchFor(world);
  const pairs = validateTransformPairs(world, scratch);
  if (!pairs.ok) return pairs;
  const since = scratch.lastRun;
  const runStart = world[worldRead].getMutationEpoch();
  const marked = markDirtyTrees(world, scratch, since, runStart);
  if (!marked.ok) return marked;
  const hierarchy = propagateParentTransforms(world, scratch, since);
  const simple = syncSimpleTransforms(world, scratch, since);
  finishRun(world, scratch);
  const walked = scratch.walkError;
  scratch.walkError = undefined;
  if (!hierarchy.ok)
    return err(
      walked === undefined ? hierarchy.error : noteHierarchyError(walked, hierarchy.error),
    );
  if (walked !== undefined) return err(walked);
  return simple;
}

export const PropagateTransforms: System<readonly []> = defineSystem({
  name: 'propagateTransforms',
  after: [FixedUpdate],
  queries: [],
  fn: (world) => {
    const result = propagateTransforms(world);
    if (!result.ok) throw result.error;
    publishPresentationTransforms(world);
    // This owner's presentation writes are not changes for the next run.
    finishRun(world, scratchFor(world));
  },
});

export const PropagateTransformsFixed: System<readonly []> = defineSystem({
  name: 'propagateTransformsFixed',
  queries: [],
  fn: (world) => {
    const result = propagateTransforms(world);
    if (!result.ok) throw result.error;
  },
});

export function registerPropagateTransforms(
  world: World,
  options: { before?: import('@forgeax/engine-ecs').SystemOrderReference } = {},
): () => void {
  const existing = REGISTRATION_LEASES.get(world);
  if (existing !== undefined) {
    existing.refs += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      existing.refs -= 1;
      if (existing.refs === 0) {
        existing.releasePresentation();
        world.removeSystem(FixedUpdate, PropagateTransformsFixed);
        world.removeSystem(Update, PropagateTransforms);
        REGISTRATION_LEASES.delete(world);
        releaseScratch(world);
      }
    };
  }
  world.addSystems(Update, TransformSet, [PropagateTransforms]).unwrap();
  if (options.before !== undefined)
    world
      .replaceSystem(Update, PropagateTransforms, {
        ...PropagateTransforms,
        before: [options.before],
      })
      .unwrap();
  world.addSystems(FixedUpdate, TransformFixedSet, [PropagateTransformsFixed]).unwrap();
  REGISTRATION_LEASES.set(world, {
    refs: 1,
    releasePresentation: registerTransformInterpolation(world),
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const lease = REGISTRATION_LEASES.get(world);
    if (lease === undefined) return;
    lease.refs -= 1;
    if (lease.refs !== 0) return;
    lease.releasePresentation();
    world.removeSystem(FixedUpdate, PropagateTransformsFixed);
    world.removeSystem(Update, PropagateTransforms);
    REGISTRATION_LEASES.delete(world);
    releaseScratch(world);
  };
}
