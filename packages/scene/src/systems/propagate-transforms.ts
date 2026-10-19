import {
  defineSystem,
  defineSystemSet,
  type EcsError,
  ENTITY_NULL_RAW,
  type EntityHandle,
  FixedUpdate,
  type Query,
  type SystemHandle,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import {
  type DerivedColumnBinding,
  type DerivedRangeCursor,
  type DerivedRangeWriter,
  getDerivedWriter,
} from '@forgeax/engine-ecs/internal';
import { createStateProjection, type StateProjection } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import { GlobalTransform, Transform } from '../components/transform';
import { SceneError } from '../errors';
import { publishPresentationTransforms, registerTransformInterpolation } from '../presentation';

export const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;
export const PROPAGATE_TRANSFORMS_FIXED_SYSTEM = 'propagateTransformsFixed' as const;
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
let hierarchyRootCursorAllocationCount = 0;
let propagationTraceRootCursorAllocationStart = 0;

function createHierarchyRootCursor(): DerivedRangeCursor {
  hierarchyRootCursorAllocationCount += 1;
  return { bindingIndex: -1, row: -1 };
}

export function beginTransformPropagationTrace(): void {
  propagationTraceRootCursorAllocationStart = hierarchyRootCursorAllocationCount;
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
  const rootCursorAllocations =
    hierarchyRootCursorAllocationCount - propagationTraceRootCursorAllocationStart;
  propagationTraceRootCursorAllocationStart = hierarchyRootCursorAllocationCount;
  if (trace !== undefined) {
    trace.hierarchyRootCursorAllocations = rootCursorAllocations;
    return trace;
  }
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

function countPropagation(name: keyof TransformPropagationTrace): void {
  const trace = propagationTrace;
  if (trace !== undefined) trace[name] += 1;
}

interface Scratch {
  position: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
  shear: Float32Array;
  local: Mat4;
  parent: Mat4;
  candidate: Mat4;
  hierarchyStackEntities: EntityHandle[];
  hierarchyStackChildren: number[];
  hierarchyProbeEntities: EntityHandle[];
  hierarchyCurrentCursor: DerivedRangeCursor;
  hierarchyParentCursor: DerivedRangeCursor;
  hierarchyChildCursor: DerivedRangeCursor;
  hierarchyResidualCursor: DerivedRangeCursor;
  hierarchyResidualParentCursor: DerivedRangeCursor;
  hierarchyRootCursor: DerivedRangeCursor;
  hierarchyStates: Uint8Array[];
  hierarchyChanged: Uint8Array[];
  hierarchyBindingTables: number[];
  hierarchyBindingRows: number[];
  flatChanged: Uint8Array[];
  flatBindingTables: number[];
  flatBindingRows: number[];
  flatCursor: DerivedRangeCursor;
  flatTouched: number[];
  flatPublished: Uint8Array;
  /**
   * False until one full hierarchy pass succeeds, and again after any error.
   * While true, every hierarchy row's world matrix is proven against its
   * parent, so later frames only re-walk subtrees reached by change evidence.
   */
  hierarchyValid: boolean;
  structure?: StateProjection;
  dirtyTransforms?: Query<readonly []>;
  dirtyParents?: Query<readonly []>;
  dirtyGlobals?: Query<readonly []>;
  flatQuery?: FlatQuery;
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

function ensureQueries(world: World, scratch: Scratch): Result<void, SceneError> {
  if (
    scratch.flatQuery !== undefined &&
    scratch.hierarchyQuery !== undefined &&
    scratch.transformQuery !== undefined &&
    scratch.hierarchyWriter !== undefined &&
    scratch.transformWriter !== undefined &&
    scratch.missingGlobalQuery !== undefined &&
    scratch.missingTransformQuery !== undefined
  ) {
    return ok(undefined);
  }
  const flatOutput = world.query({
    read: [Transform],
    write: [GlobalTransform],
    without: [ChildOf],
    changed: [Transform],
  });
  scratch.dirtyTransforms ??= world.query({ changed: [Transform] }).unwrap();
  scratch.dirtyParents ??= world.query({ changed: [ChildOf] }).unwrap();
  scratch.dirtyGlobals ??= world.query({ changed: [GlobalTransform] }).unwrap();
  const hierarchy = world.query({ read: [Transform, ChildOf], write: [GlobalTransform] });
  const transform = world.query({ read: [Transform], write: [GlobalTransform] });
  const missingGlobal = world.query({ with: [Transform], without: [GlobalTransform] });
  const missingTransform = world.query({ with: [GlobalTransform], without: [Transform] });
  if (
    !flatOutput.ok ||
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
  for (const row of missingGlobal) {
    return pairError(row.entity, 'each Transform entity to carry a GlobalTransform pair');
  }
  for (const row of missingTransform) {
    return pairError(row.entity, 'each GlobalTransform entity to carry a Transform pair');
  }
  return ok(undefined);
}

function scratchFor(world: World): Scratch {
  const existing = SCRATCH.get(world);
  if (existing !== undefined) return existing;
  const created = {
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    shear: new Float32Array(3),
    local: mat4.create(),
    parent: mat4.create(),
    candidate: mat4.create(),
    hierarchyStackEntities: [] as EntityHandle[],
    hierarchyStackChildren: [] as number[],
    hierarchyProbeEntities: [] as EntityHandle[],
    hierarchyCurrentCursor: { bindingIndex: -1, row: -1 },
    hierarchyParentCursor: { bindingIndex: -1, row: -1 },
    hierarchyChildCursor: { bindingIndex: -1, row: -1 },
    hierarchyResidualCursor: { bindingIndex: -1, row: -1 },
    hierarchyResidualParentCursor: { bindingIndex: -1, row: -1 },
    hierarchyRootCursor: createHierarchyRootCursor(),
    hierarchyStates: [],
    hierarchyChanged: [],
    hierarchyBindingTables: [],
    hierarchyBindingRows: [],
    flatChanged: [],
    flatBindingTables: [],
    flatBindingRows: [],
    flatCursor: { bindingIndex: -1, row: -1 },
    flatTouched: [] as number[],
    flatPublished: new Uint8Array(0),
    hierarchyValid: false,
  };
  SCRATCH.set(world, created);
  return created;
}

function composeColumns(
  position: ArrayLike<number>,
  rotation: ArrayLike<number>,
  scale: ArrayLike<number>,
  shear: ArrayLike<number>,
  out: Mat4,
  scratch: Scratch,
  positionStart = 0,
  rotationStart = 0,
): void {
  scratch.position[0] = position[positionStart] ?? 0;
  scratch.position[1] = position[positionStart + 1] ?? 0;
  scratch.position[2] = position[positionStart + 2] ?? 0;
  scratch.rotation[0] = rotation[rotationStart] ?? 0;
  scratch.rotation[1] = rotation[rotationStart + 1] ?? 0;
  scratch.rotation[2] = rotation[rotationStart + 2] ?? 0;
  scratch.rotation[3] = rotation[rotationStart + 3] ?? 1;
  scratch.scale[0] = scale[positionStart] ?? 1;
  scratch.scale[1] = scale[positionStart + 1] ?? 1;
  scratch.scale[2] = scale[positionStart + 2] ?? 1;
  scratch.shear[0] = shear[positionStart] ?? 0;
  scratch.shear[1] = shear[positionStart + 1] ?? 0;
  scratch.shear[2] = shear[positionStart + 2] ?? 0;
  mat4.compose(out, scratch.position, scratch.rotation, scratch.scale, scratch.shear);
}

function composeFlatColumns(
  positions: ArrayLike<number>,
  rotations: ArrayLike<number>,
  scales: ArrayLike<number>,
  shears: ArrayLike<number>,
  worlds: Float32Array,
  count: number,
  worldBase: number,
): void {
  for (let row = 0; row < count; row += 1) {
    const position = row * 3;
    const rotation = row * 4;
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
    const hxy = shears[position] ?? 0,
      hxz = shears[position + 1] ?? 0,
      hyz = shears[position + 2] ?? 0;
    if (hxy !== 0 || hxz !== 0 || hyz !== 0) {
      worlds[world + 4] = (xy - wz + (1 - (yy + zz)) * hxy) * sy;
      worlds[world + 5] = (1 - (xx + zz) + (xy + wz) * hxy) * sy;
      worlds[world + 6] = (yz + wx + (xz - wy) * hxy) * sy;
      worlds[world + 8] = (xz + wy + (1 - (yy + zz)) * hxz + (xy - wz) * hyz) * sz;
      worlds[world + 9] = (yz - wx + (xy + wz) * hxz + (1 - (xx + zz)) * hyz) * sz;
      worlds[world + 10] = (1 - (xx + yy) + (xz - wy) * hxz + (yz + wx) * hyz) * sz;
    }
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
  composeFlatColumns(
    local.pos,
    local.quat,
    local.scale,
    local.shear,
    worldColumn(binding),
    count,
    base + start,
  );
}

function propagateFlat(
  world: World,
  scratch: Scratch,
  candidates: readonly EntityHandle[],
  globalEdited: readonly EntityHandle[],
): Result<EntityHandle[], SceneError> {
  const query = scratch.flatQuery;
  if (query === undefined)
    return err(
      new SceneError({
        code: 'hierarchy-broken',
        expected: 'a valid changed Transform write query',
        hint: 'register the scene components before running TransformPropagation',
      }),
    );
  const spans = query.spans();
  if (!spans.ok) return pairError(0 as EntityHandle, 'dense numeric Transform spans');
  let bindingIndex = 0;
  try {
    for (const span of spans.value) {
      const local = span.get(Transform);
      const first = span.entities[0];
      const writer = scratch.transformWriter;
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
    const error = cause as EcsError;
    return err(derivedWriteError(error, bindingIndex));
  }

  // A structural relation change can turn an unchanged Transform row into a
  // flat root (most importantly ChildOf removal), and an external
  // GlobalTransform write can corrupt a flat root. The changed Transform query
  // above observes neither, so re-derive only those candidate roots and
  // report the ones whose world matrix changed so their subtrees re-walk.
  const transformWriter = scratch.transformWriter;
  if (transformWriter === undefined) {
    return pairError(0 as EntityHandle, 'dense Transform and GlobalTransform derived bindings');
  }
  const changedRoots: EntityHandle[] = [];
  if (candidates.length === 0 && globalEdited.length === 0) return ok(changedRoots);
  const transformBindings = transformWriter.bindings as readonly TransformBinding[];
  ensureFlatBuffers(scratch, transformBindings);
  const cursor = scratch.flatCursor;
  const touched = scratch.flatTouched;
  touched.length = 0;
  const visit = (entity: EntityHandle): void => {
    if (!transformWriter.locateEntity(entity, cursor)) return;
    const parentRaw = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
    if (parentRaw !== undefined && parentRaw !== ENTITY_NULL_RAW) return;
    const binding = transformBindings[cursor.bindingIndex];
    const changed = scratch.flatChanged[cursor.bindingIndex];
    if (binding === undefined || changed === undefined || changed[cursor.row] !== 0) return;
    countPropagation('flatStructuralRootRows');
    composeBindingRow(binding, cursor.row, undefined, 0, scratch, changed);
    if (changed[cursor.row] === 0) return;
    touched.push(cursor.bindingIndex, cursor.row);
    changedRoots.push(entity);
  };
  for (const entity of candidates) visit(entity);
  for (const entity of globalEdited) visit(entity);
  let result: Result<EntityHandle[], SceneError> = ok(changedRoots);
  const published = scratch.flatPublished;
  for (let index = 0; index < touched.length; index += 2) {
    const touchedBinding = touched[index] as number;
    const changed = scratch.flatChanged[touchedBinding];
    if (changed === undefined || published[touchedBinding] !== 0) continue;
    published[touchedBinding] = 1;
    const publication = transformWriter.publishChangedRows(touchedBinding, changed);
    if (!publication.ok && result.ok) {
      result = err(derivedWriteError(publication.error, touchedBinding));
    }
  }
  for (let index = 0; index < touched.length; index += 2) {
    const changed = scratch.flatChanged[touched[index] as number];
    if (changed !== undefined) changed[touched[index + 1] as number] = 0;
  }
  touched.length = 0;
  published.fill(0);
  return result;
}

interface TransformColumnShape {
  readonly pos: ArrayLike<number>;
  readonly quat: ArrayLike<number>;
  readonly scale: ArrayLike<number>;
  readonly shear: ArrayLike<number>;
}

interface OutputColumnShape {
  readonly world: Float32Array;
}

interface HierarchyColumnShape extends TransformColumnShape {
  readonly parent: ArrayLike<number>;
}

function transformColumns(binding: TransformBinding | HierarchyBinding): TransformColumnShape {
  return binding.read as unknown as TransformColumnShape;
}

function hierarchyColumns(binding: HierarchyBinding): HierarchyColumnShape {
  return binding.read as unknown as HierarchyColumnShape;
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

function writeCandidate(
  binding: TransformBinding | HierarchyBinding,
  row: number,
  candidate: Mat4,
  changed: Uint8Array,
): void {
  const worlds = worldColumn(binding);
  const base = row * 16;
  for (let index = 0; index < 16; index += 1) {
    if (worlds[base + index] !== candidate[index]) {
      worlds.set(candidate, base);
      changed[row] = 1;
      return;
    }
  }
}

function composeBindingRow(
  binding: TransformBinding | HierarchyBinding,
  row: number,
  parentBinding: TransformBinding | undefined,
  parentRow: number,
  scratch: Scratch,
  changed: Uint8Array,
): void {
  // Hierarchy bindings carry the parent column; flat structural-root repair
  // uses the same numeric kernel but is intentionally counted separately.
  if ('parent' in (binding.read as object)) countPropagation('hierarchyRowsEvaluated');
  const local = transformColumns(binding);
  const offset = row * 3;
  composeColumns(
    local.pos,
    local.quat,
    local.scale,
    local.shear,
    scratch.local,
    scratch,
    offset,
    row * 4,
  );
  if (parentBinding === undefined) {
    scratch.candidate.set(scratch.local);
  } else {
    const parentWorld = worldColumn(parentBinding);
    const parentOffset = parentRow * 16;
    for (let index = 0; index < 16; index += 1) {
      scratch.parent[index] = parentWorld[parentOffset + index] ?? 0;
    }
    // Column-major composition is intentionally identical to the previous
    // matrix path: Global = Parent * Local, with no TRS decomposition.
    mat4.multiply(scratch.candidate, scratch.parent, scratch.local);
  }
  writeCandidate(binding, row, scratch.candidate, changed);
}

function ensureHierarchyBuffers(scratch: Scratch, bindings: readonly HierarchyBinding[]): void {
  let same = scratch.hierarchyBindingTables.length === bindings.length;
  if (same) {
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index];
      if (
        binding === undefined ||
        scratch.hierarchyBindingTables[index] !== binding.tableId ||
        scratch.hierarchyBindingRows[index] !== binding.rowCapacity
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) return;
  scratch.hierarchyBindingTables = bindings.map((binding) => binding.tableId);
  scratch.hierarchyBindingRows = bindings.map((binding) => binding.rowCapacity);
  scratch.hierarchyStates = bindings.map((binding) => new Uint8Array(binding.rowCapacity));
  scratch.hierarchyChanged = bindings.map((binding) => new Uint8Array(binding.rowCapacity));
}

function resetHierarchyBuffers(scratch: Scratch): void {
  for (let index = 0; index < scratch.hierarchyStates.length; index += 1) {
    scratch.hierarchyStates[index]?.fill(0);
    scratch.hierarchyChanged[index]?.fill(0);
  }
}

function ensureFlatBuffers(scratch: Scratch, bindings: readonly TransformBinding[]): void {
  let same = scratch.flatBindingTables.length === bindings.length;
  if (same) {
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index];
      if (
        binding === undefined ||
        scratch.flatBindingTables[index] !== binding.tableId ||
        scratch.flatBindingRows[index] !== binding.rowCapacity
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) return;
  scratch.flatBindingTables = bindings.map((binding) => binding.tableId);
  scratch.flatBindingRows = bindings.map((binding) => binding.rowCapacity);
  scratch.flatChanged = bindings.map((binding) => new Uint8Array(binding.rowCapacity));
  scratch.flatPublished = new Uint8Array(bindings.length);
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

function findHierarchyLocation(
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  entity: EntityHandle,
  cursor: DerivedRangeCursor,
): HierarchyBinding | undefined {
  countPropagation('hierarchyEntityLookups');
  if (!writer.locateEntity(entity, cursor)) return undefined;
  return bindings[cursor.bindingIndex];
}

function findTransformLocation(
  writer: TransformWriter,
  bindings: readonly TransformBinding[],
  entity: EntityHandle,
  cursor: DerivedRangeCursor,
): TransformBinding | undefined {
  countPropagation('hierarchyEntityLookups');
  if (!writer.locateEntity(entity, cursor)) return undefined;
  return bindings[cursor.bindingIndex];
}

function countPublishedRows(changed: Uint8Array): void {
  const trace = propagationTrace;
  if (trace === undefined) return;
  let runOpen = false;
  for (let row = 0; row < changed.length; row += 1) {
    if ((changed[row] ?? 0) !== 0) {
      trace.hierarchyPublishedRows += 1;
      if (!runOpen) {
        trace.hierarchyPublishedRuns += 1;
        runOpen = true;
      }
    } else {
      runOpen = false;
    }
  }
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

function composeLocalHierarchyEntity(
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  entity: EntityHandle,
  scratch: Scratch,
  changed: Uint8Array[],
): boolean {
  const cursor = scratch.hierarchyCurrentCursor;
  const binding = findHierarchyLocation(writer, bindings, entity, cursor);
  if (binding === undefined) return false;
  composeBindingRow(
    binding,
    cursor.row,
    undefined,
    0,
    scratch,
    changed[cursor.bindingIndex] as Uint8Array,
  );
  const states = scratch.hierarchyStates[cursor.bindingIndex];
  if (states !== undefined) states[cursor.row] = 3;
  return true;
}

function handleActiveCycle(
  repeated: EntityHandle,
  stackEntities: EntityHandle[],
  stackChildren: number[],
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  scratch: Scratch,
  changed: Uint8Array[],
  report: (error: SceneError) => void,
): void {
  let cycleStart = -1;
  for (let index = 0; index < stackEntities.length; index += 1) {
    if (stackEntities[index] === repeated) {
      cycleStart = index;
      break;
    }
  }
  if (cycleStart < 0) return;
  const repeatedCursor: DerivedRangeCursor = { bindingIndex: -1, row: -1 };
  const repeatedBinding = findHierarchyLocation(writer, bindings, repeated, repeatedCursor);
  const repeatedParent =
    repeatedBinding === undefined
      ? repeated
      : ((hierarchyColumns(repeatedBinding).parent[repeatedCursor.row] ??
          ENTITY_NULL_RAW) as number as EntityHandle);
  report(
    hierarchyError(
      'hierarchy-cycle',
      repeated,
      repeatedParent,
      'a parent-before-child Transform hierarchy',
      'repair the ChildOf cycle and retry TransformPropagation',
    ),
  );
  for (let index = cycleStart; index < stackEntities.length; index += 1) {
    const cycleEntity = stackEntities[index];
    if (cycleEntity === undefined) continue;
    composeLocalHierarchyEntity(writer, bindings, cycleEntity, scratch, changed);
    stackChildren[index] = 0;
  }
}

function walkChildren(
  world: World,
  root: EntityHandle,
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  transformWriter: TransformWriter,
  transformBindings: readonly TransformBinding[],
  scratch: Scratch,
  report: (error: SceneError) => void,
  allowCompletedRoot: boolean,
  refresh = false,
): void {
  countPropagation('hierarchyRootInvocations');
  const stackEntities = scratch.hierarchyStackEntities;
  const stackChildren = scratch.hierarchyStackChildren;
  stackEntities.length = 0;
  stackChildren.length = 0;

  // The cursor is scratch-owned and reused for every root, so a hot root walk
  // allocates nothing. Residual recovery may be entered once for each member
  // of a malformed parent path; state 4 means a previous fallback walk already
  // expanded this root and all reachable Children edges, so do not repeat it.
  const rootCursor = scratch.hierarchyRootCursor;
  if (!allowCompletedRoot) countPropagation('hierarchyRootCursorReuses');
  if (findHierarchyLocation(writer, bindings, root, rootCursor) !== undefined) {
    const state = scratch.hierarchyStates[rootCursor.bindingIndex]?.[rootCursor.row] ?? 0;
    if (allowCompletedRoot ? state === 4 : state !== 0 && !refresh) return;
  }
  stackEntities.push(root);
  stackChildren.push(-1);

  const currentCursor = scratch.hierarchyCurrentCursor;
  const parentCursor = scratch.hierarchyParentCursor;
  const childCursor = scratch.hierarchyChildCursor;
  while (stackEntities.length > 0) {
    const top = stackEntities.length - 1;
    const current = stackEntities[top];
    if (current === undefined) {
      stackEntities.pop();
      stackChildren.pop();
      continue;
    }
    const hierarchyBinding = findHierarchyLocation(writer, bindings, current, currentCursor);
    const nextChild = stackChildren[top] ?? -1;
    if (nextChild < 0) {
      if (hierarchyBinding !== undefined) {
        const states = scratch.hierarchyStates[currentCursor.bindingIndex];
        if (refresh && states !== undefined) states[currentCursor.row] = 0;
        if ((states?.[currentCursor.row] ?? 0) === 0) {
          if (states !== undefined) states[currentCursor.row] = 1;
          const parentRaw = (hierarchyColumns(hierarchyBinding).parent[currentCursor.row] ??
            ENTITY_NULL_RAW) as number;
          // Every non-cycle outcome composes this row exactly once: under its
          // parent when the parent is complete, otherwise as a local root.
          let parentSource: TransformBinding | undefined;
          let cycle = false;
          if (parentRaw !== ENTITY_NULL_RAW) {
            const parent = parentRaw as EntityHandle;
            const parentBinding = findTransformLocation(
              transformWriter,
              transformBindings,
              parent,
              parentCursor,
            );
            const parentHierarchy = findHierarchyLocation(writer, bindings, parent, childCursor);
            // A parent outside the hierarchy bindings is a flat root, already complete (2).
            const parentState =
              parentHierarchy === undefined
                ? 2
                : (scratch.hierarchyStates[childCursor.bindingIndex]?.[childCursor.row] ?? 0);
            if (parentBinding === undefined) {
              report(
                hierarchyError(
                  'hierarchy-broken',
                  current,
                  parent,
                  'each ChildOf parent to carry Transform and GlobalTransform',
                  'repair the missing parent pair before retrying propagation',
                ),
              );
            } else if (parentState === 1) {
              handleActiveCycle(
                parent,
                stackEntities,
                stackChildren,
                writer,
                bindings,
                scratch,
                scratch.hierarchyChanged,
                report,
              );
              cycle = true;
            } else if (parentState === 0) {
              report(
                hierarchyError(
                  'hierarchy-broken',
                  current,
                  parent,
                  'Children to enumerate every parent-before-child edge',
                  'repair the Children mirror and retry TransformPropagation',
                ),
              );
            } else {
              parentSource = parentBinding;
            }
          }
          if (!cycle) {
            composeBindingRow(
              hierarchyBinding,
              currentCursor.row,
              parentSource,
              parentCursor.row,
              scratch,
              scratch.hierarchyChanged[currentCursor.bindingIndex] as Uint8Array,
            );
          }
          if (states !== undefined && states[currentCursor.row] === 1) {
            states[currentCursor.row] = 2;
          }
        }
      }
      stackChildren[top] = 0;
      continue;
    }

    const childrenLength = world[worldRead].getArrayLength(current, Children, 'entities') ?? 0;
    if (nextChild >= childrenLength) {
      stackEntities.pop();
      stackChildren.pop();
      if (allowCompletedRoot) {
        const completedCursor = scratch.hierarchyResidualCursor;
        const completedBinding = findHierarchyLocation(writer, bindings, current, completedCursor);
        const completedStates =
          completedBinding === undefined
            ? undefined
            : scratch.hierarchyStates[completedCursor.bindingIndex];
        if (completedStates !== undefined && completedStates[completedCursor.row] === 3) {
          completedStates[completedCursor.row] = 4;
        }
      }
      continue;
    }
    stackChildren[top] = nextChild + 1;
    countPropagation('hierarchyEdgesVisited');
    const childRaw = world[worldRead].getArrayElement(current, Children, 'entities', nextChild);
    if (childRaw === undefined || childRaw === ENTITY_NULL_RAW) {
      report(
        hierarchyError(
          'hierarchy-broken',
          current,
          current,
          'Children.entities to contain live child handles',
          'repair the Children mirror and retry TransformPropagation',
        ),
      );
      continue;
    }
    const child = childRaw as EntityHandle;
    const childBinding = findHierarchyLocation(writer, bindings, child, childCursor);
    if (childBinding === undefined) {
      report(
        hierarchyError(
          'hierarchy-broken',
          child,
          current,
          'each Children entry to carry Transform, GlobalTransform, and ChildOf',
          'repair the child component pair before retrying propagation',
        ),
      );
      continue;
    }
    const childParent = (hierarchyColumns(childBinding).parent[childCursor.row] ??
      ENTITY_NULL_RAW) as number;
    const childState = scratch.hierarchyStates[childCursor.bindingIndex]?.[childCursor.row] ?? 0;
    if (childParent !== (current as number)) {
      // Leave an unvisited child for the residual row-state pass. That pass
      // can classify the complete path (including a rootless cycle) without
      // emitting a premature mirror error that would hide the cycle cause.
      if (childState === 0) continue;
      report(
        hierarchyError(
          'hierarchy-broken',
          child,
          current,
          'Children and ChildOf to describe the same parent',
          'repair the relationship mirror and retry TransformPropagation',
        ),
      );
      continue;
    }
    if (childState === 1) {
      handleActiveCycle(
        child,
        stackEntities,
        stackChildren,
        writer,
        bindings,
        scratch,
        scratch.hierarchyChanged,
        report,
      );
    } else if (childState === 0 || refresh) {
      stackEntities.push(child);
      stackChildren.push(-1);
    }
  }
}

function fallbackResidualPath(
  world: World,
  path: readonly EntityHandle[],
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  transformWriter: TransformWriter,
  transformBindings: readonly TransformBinding[],
  scratch: Scratch,
  report: (error: SceneError) => void,
): void {
  // Root traversal owns the normal path.  A residual path is necessarily a
  // malformed Children projection (or a rootless cycle); cut the complete
  // path to local roots in one pass so no stale GlobalTransform survives the
  // diagnostic.  Keeping the path as an explicit work list also makes this
  // recovery O(path length), rather than repeatedly searching parent chains.
  for (const entity of path) {
    composeLocalHierarchyEntity(writer, bindings, entity, scratch, scratch.hierarchyChanged);
  }
  for (const entity of path) {
    walkChildren(
      world,
      entity,
      writer,
      bindings,
      transformWriter,
      transformBindings,
      scratch,
      report,
      true,
    );
  }
}

function resolveResidualPath(
  world: World,
  entity: EntityHandle,
  writer: HierarchyWriter,
  bindings: readonly HierarchyBinding[],
  transformWriter: TransformWriter,
  transformBindings: readonly TransformBinding[],
  scratch: Scratch,
  report: (error: SceneError) => void,
): void {
  const path = scratch.hierarchyProbeEntities;
  path.length = 0;
  const cursor = scratch.hierarchyResidualCursor;
  const parentTransformCursor = scratch.hierarchyParentCursor;
  const parentHierarchyCursor = scratch.hierarchyResidualParentCursor;
  let current = entity;
  while (true) {
    countPropagation('hierarchyResidualParentProbes');
    const binding = findHierarchyLocation(writer, bindings, current, cursor);
    if (binding === undefined) break;
    const states = scratch.hierarchyStates[cursor.bindingIndex];
    const state = states?.[cursor.row] ?? 0;
    if (state !== 0) {
      const columns = hierarchyColumns(binding);
      const parentRaw = (columns.parent[cursor.row] ?? ENTITY_NULL_RAW) as number;
      report(
        hierarchyError(
          'hierarchy-cycle',
          current,
          parentRaw === ENTITY_NULL_RAW ? current : (parentRaw as EntityHandle),
          'a parent-before-child Transform hierarchy',
          'repair the ChildOf cycle and retry TransformPropagation',
        ),
      );
      fallbackResidualPath(
        world,
        path,
        writer,
        bindings,
        transformWriter,
        transformBindings,
        scratch,
        report,
      );
      return;
    }

    if (states !== undefined) states[cursor.row] = 1;
    path.push(current);
    const parentRaw = (hierarchyColumns(binding).parent[cursor.row] ?? ENTITY_NULL_RAW) as number;
    if (parentRaw === ENTITY_NULL_RAW) {
      // Every null-parent row is enumerated as a root above.  Reaching one
      // here means the materialized Children graph failed to expose the
      // parent-first edge; preserve the explicit malformed-graph error.
      report(
        hierarchyError(
          'hierarchy-broken',
          current,
          current,
          'Children to enumerate every parent-before-child edge',
          'repair the Children mirror and retry TransformPropagation',
        ),
      );
      fallbackResidualPath(
        world,
        path,
        writer,
        bindings,
        transformWriter,
        transformBindings,
        scratch,
        report,
      );
      return;
    }

    const parent = parentRaw as EntityHandle;
    const parentTransform = findTransformLocation(
      transformWriter,
      transformBindings,
      parent,
      parentTransformCursor,
    );
    const parentHierarchy = findHierarchyLocation(writer, bindings, parent, parentHierarchyCursor);
    if (parentHierarchy === undefined) {
      report(
        hierarchyError(
          'hierarchy-broken',
          current,
          parent,
          parentTransform === undefined
            ? 'each ChildOf parent to carry Transform and GlobalTransform'
            : 'Children to enumerate every parent-before-child edge',
          parentTransform === undefined
            ? 'repair the missing parent pair before retrying propagation'
            : 'repair the Children mirror and retry TransformPropagation',
        ),
      );
      fallbackResidualPath(
        world,
        path,
        writer,
        bindings,
        transformWriter,
        transformBindings,
        scratch,
        report,
      );
      return;
    }

    const parentState =
      scratch.hierarchyStates[parentHierarchyCursor.bindingIndex]?.[parentHierarchyCursor.row] ?? 0;
    if (parentState === 0) {
      current = parent;
      continue;
    }
    if (parentState === 1) {
      report(
        hierarchyError(
          'hierarchy-cycle',
          parent,
          current,
          'a parent-before-child Transform hierarchy',
          'repair the ChildOf cycle and retry TransformPropagation',
        ),
      );
    } else {
      report(
        hierarchyError(
          'hierarchy-broken',
          current,
          parent,
          'Children to enumerate every parent-before-child edge',
          'repair the Children mirror and retry TransformPropagation',
        ),
      );
    }
    fallbackResidualPath(
      world,
      path,
      writer,
      bindings,
      transformWriter,
      transformBindings,
      scratch,
      report,
    );
    return;
  }
}

/**
 * A value write to ChildOf (reparent) is trusted for incremental propagation
 * only when the ECS-maintained Children mirror already lists the edge. Public
 * writes always satisfy this; a malformed edge falls back to the full pass so
 * its diagnostic is identical to a cold evaluation.
 */
function parentEdgeMirrored(
  world: World,
  child: EntityHandle,
  transformWriter: TransformWriter,
  cursor: DerivedRangeCursor,
): boolean {
  const parentRaw = world[worldRead].getFieldValue(child, ChildOf, 'parent');
  if (parentRaw === undefined || parentRaw === ENTITY_NULL_RAW) return true;
  const parent = parentRaw as EntityHandle;
  if (!transformWriter.locateEntity(parent, cursor)) return false;
  const length = world[worldRead].getArrayLength(parent, Children, 'entities') ?? 0;
  for (let index = 0; index < length; index += 1) {
    if (world[worldRead].getArrayElement(parent, Children, 'entities', index) === child)
      return true;
  }
  return false;
}

/**
 * Highest dirty entities: those with no dirty ancestor. The ancestor walk is
 * bounded by the hierarchy row count so a malformed parent loop cannot spin;
 * exceeding it returns undefined and the caller runs the full pass.
 */
function highestDirtyEntities(
  world: World,
  dirty: ReadonlySet<EntityHandle>,
  hierarchyRows: number,
): EntityHandle[] | undefined {
  const roots: EntityHandle[] = [];
  for (const entity of dirty) {
    let parent = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
    let covered = false;
    let hops = 0;
    while (parent !== undefined && parent !== ENTITY_NULL_RAW) {
      if (dirty.has(parent as EntityHandle)) {
        covered = true;
        break;
      }
      hops += 1;
      if (hops > hierarchyRows) return undefined;
      parent = world[worldRead].getFieldValue(parent as EntityHandle, ChildOf, 'parent');
    }
    if (!covered) roots.push(entity);
  }
  return roots;
}

interface StructuralCandidates {
  /** Live Transform entities whose storage block changed membership. */
  readonly entities: readonly EntityHandle[];
  /** A candidate left the Transform pair while still holding a hierarchy edge. */
  readonly relationLeftTransform: boolean;
}

const NO_STRUCTURAL_CANDIDATES: StructuralCandidates = {
  entities: [],
  relationLeftTransform: false,
};

/**
 * Structural changes are discovered per 256-row storage block rather than by
 * rescanning every Transform row: the projection enqueues the previous and
 * current occupants of each block whose membership changed. Its first read
 * (and any read after invalidation) returns every Transform row, which is the
 * cold full pass.
 */
function readStructuralCandidates(world: World, scratch: Scratch): StructuralCandidates {
  const transformWriter = scratch.transformWriter;
  scratch.structure ??= createStateProjection(world, [], [Transform]);
  const projection = scratch.structure;
  const batch = projection.read();
  batch.accept();
  if (!batch.membershipChanged || batch.indices.length === 0 || transformWriter === undefined) {
    return NO_STRUCTURAL_CANDIDATES;
  }
  const entities: EntityHandle[] = [];
  let relationLeftTransform = false;
  const cursor = scratch.flatCursor;
  for (const index of batch.indices) {
    const entity = projection.entity(index);
    if (entity === undefined) continue;
    if (transformWriter.locateEntity(entity, cursor)) {
      entities.push(entity);
    } else if (
      world[worldRead].getFieldValue(entity, ChildOf, 'parent') !== undefined ||
      world[worldRead].getArrayLength(entity, Children, 'entities') !== undefined
    ) {
      relationLeftTransform = true;
    }
  }
  return { entities, relationLeftTransform };
}

function propagateHierarchy(
  world: World,
  scratch: Scratch,
  structural: StructuralCandidates,
  globalEdited: readonly EntityHandle[],
  flatRoots: readonly EntityHandle[],
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
  const hierarchyBindings = hierarchyWriter.bindings as readonly HierarchyBinding[];
  const transformBindings = transformWriter.bindings as readonly TransformBinding[];
  if (hierarchyBindings.length === 0) {
    // Keep the flat-only lane independent: it must not allocate hierarchy
    // markers or scan every Transform row merely to prove that no ChildOf
    // archetype exists.
    scratch.hierarchyBindingTables.length = 0;
    scratch.hierarchyBindingRows.length = 0;
    scratch.hierarchyStates.length = 0;
    scratch.hierarchyChanged.length = 0;
    scratch.hierarchyValid = true;
    return ok(undefined);
  }
  const dirty = new Set<EntityHandle>();
  for (const span of scratch.dirtyTransforms?.spans().unwrap() ?? []) {
    for (let row = 0; row < span.length; row++) dirty.add(span.entities[row] as EntityHandle);
  }
  let rebuild = !scratch.hierarchyValid || structural.relationLeftTransform;
  const structuralSet = new Set(structural.entities);
  const edgeCursor = scratch.hierarchyResidualParentCursor;
  for (const span of scratch.dirtyParents?.spans().unwrap() ?? []) {
    for (let row = 0; row < span.length; row++) {
      const entity = span.entities[row] as EntityHandle;
      dirty.add(entity);
      if (
        !rebuild &&
        !structuralSet.has(entity) &&
        !parentEdgeMirrored(world, entity, transformWriter, edgeCursor)
      ) {
        rebuild = true;
      }
    }
  }
  for (const entity of structural.entities) {
    if (world[worldRead].getFieldValue(entity, ChildOf, 'parent') !== undefined) dirty.add(entity);
  }
  for (const entity of globalEdited) dirty.add(entity);
  for (const entity of flatRoots) dirty.add(entity);
  if (!rebuild && dirty.size === 0) return ok(undefined);
  ensureHierarchyBuffers(scratch, hierarchyBindings);
  let dirtyRoots: EntityHandle[] | undefined;
  if (!rebuild) {
    let hierarchyRows = 0;
    for (const binding of hierarchyBindings) hierarchyRows += binding.rowCapacity;
    dirtyRoots = highestDirtyEntities(world, dirty, hierarchyRows);
  }
  if (dirtyRoots === undefined) {
    resetHierarchyBuffers(scratch);
  } else {
    // Rows outside the dirty subtrees keep the worlds proven by the last
    // successful pass; mark them complete so parent-first checks accept them.
    for (const states of scratch.hierarchyStates) states.fill(2);
    for (const changed of scratch.hierarchyChanged) changed.fill(0);
  }
  let firstError: SceneError | undefined;
  const report = (error: SceneError): void => {
    firstError = noteHierarchyError(firstError, error);
  };

  if (dirtyRoots !== undefined) {
    for (const entity of dirtyRoots) {
      walkChildren(
        world,
        entity,
        hierarchyWriter,
        hierarchyBindings,
        transformWriter,
        transformBindings,
        scratch,
        report,
        false,
        true,
      );
    }
  } else {
    // Start only at actual roots (flat Transform rows and null-parent
    // ChildOf rows). Descendants are discovered exclusively through the ECS
    // materialized Children lists, so every normal frame is parent-first and
    // linear in rows plus relationship edges.
    for (const binding of transformBindings) {
      const entities = binding.entities;
      for (let row = 0; row < binding.rowCapacity; row += 1) {
        const entity = (entities[row] ?? 0) as EntityHandle;
        const parentRaw = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
        if (parentRaw === undefined || parentRaw === ENTITY_NULL_RAW) {
          walkChildren(
            world,
            entity,
            hierarchyWriter,
            hierarchyBindings,
            transformWriter,
            transformBindings,
            scratch,
            report,
            false,
          );
        }
      }
    }

    // Any remaining hierarchy row is either behind a malformed/missing mirror
    // edge or belongs to a rootless cycle. Follow each residual parent chain
    // once with the same row-state machine (not a per-node parent search), then
    // cut that complete residual path to local space. This keeps malformed
    // coverage linear in residual rows and edges while normal frames remain
    // exclusively Children-driven.
    for (let bindingIndex = 0; bindingIndex < hierarchyBindings.length; bindingIndex += 1) {
      const binding = hierarchyBindings[bindingIndex];
      if (binding === undefined) continue;
      const entities = binding.entities;
      const states = scratch.hierarchyStates[bindingIndex];
      for (let row = 0; row < binding.rowCapacity; row += 1) {
        if ((states?.[row] ?? 0) !== 0) continue;
        const entity = (entities[row] ?? 0) as EntityHandle;
        resolveResidualPath(
          world,
          entity,
          hierarchyWriter,
          hierarchyBindings,
          transformWriter,
          transformBindings,
          scratch,
          report,
        );
      }
    }
  }

  for (let bindingIndex = 0; bindingIndex < hierarchyBindings.length; bindingIndex += 1) {
    const changed = scratch.hierarchyChanged[bindingIndex];
    if (changed === undefined) continue;
    countPublishedRows(changed);
    const published = hierarchyWriter.publishChangedRows(bindingIndex, changed);
    if (!published.ok) {
      const cause = published.error as EcsError;
      report(derivedWriteError(cause, bindingIndex));
    }
  }
  scratch.hierarchyValid = firstError === undefined;
  return firstError === undefined ? ok(undefined) : err(firstError);
}

export function propagateTransforms(world: World): Result<void, SceneError> {
  const scratch = scratchFor(world);
  const pairs = validateTransformPairs(world, scratch);
  if (!pairs.ok) return pairs;
  const structural = readStructuralCandidates(world, scratch);
  const globalEdited: EntityHandle[] = [];
  for (const span of scratch.dirtyGlobals?.spans().unwrap() ?? []) {
    for (let row = 0; row < span.length; row++)
      globalEdited.push(span.entities[row] as EntityHandle);
  }
  const flat = propagateFlat(world, scratch, structural.entities, globalEdited);
  if (!flat.ok) {
    scratch.structure?.invalidate();
    scratch.hierarchyValid = false;
    return flat;
  }
  const hierarchy = propagateHierarchy(world, scratch, structural, globalEdited, flat.value);
  // Consume our own derived publications, while preserving later external edits.
  for (const _span of scratch.dirtyGlobals?.spans().unwrap() ?? []) {
    /* observation only */
  }
  return hierarchy;
}

export const PropagateTransforms: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_SYSTEM,
  after: [FixedUpdate],
  queries: [],
  fn: (world) => {
    const result = propagateTransforms(world);
    if (!result.ok) throw result.error;
    publishPresentationTransforms(world);
    for (const _span of scratchFor(world).dirtyGlobals?.spans().unwrap() ?? []) {
      /* consume this owner's presentation writes */
    }
  },
});

export const PropagateTransformsFixed: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_FIXED_SYSTEM,
  queries: [],
  fn: (world) => {
    const result = propagateTransforms(world);
    if (!result.ok) throw result.error;
  },
});

export function registerPropagateTransforms(
  world: World,
  options: { beforeSystemName?: string } = {},
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
        world.removeSystem(FixedUpdate, PROPAGATE_TRANSFORMS_FIXED_SYSTEM);
        world.removeSystem(Update, PROPAGATE_TRANSFORMS_SYSTEM);
        REGISTRATION_LEASES.delete(world);
        SCRATCH.delete(world);
      }
    };
  }
  if (options.beforeSystemName === undefined) {
    world.addSystems(Update, TransformSet, [PropagateTransforms]).unwrap();
  } else {
    world
      .addSystems(Update, TransformSet, [
        {
          ...PropagateTransforms,
          before: [options.beforeSystemName],
        },
      ])
      .unwrap();
  }
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
    world.removeSystem(FixedUpdate, PROPAGATE_TRANSFORMS_FIXED_SYSTEM);
    world.removeSystem(Update, PROPAGATE_TRANSFORMS_SYSTEM);
    REGISTRATION_LEASES.delete(world);
    SCRATCH.delete(world);
  };
}
