import { type MeshDistanceField, validateMeshDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { packSampledField, SdfFieldUpload } from './sdf-field-storage';
import {
  readSdfSceneCandidateDirectory,
  type SdfSceneCandidateDirectory,
} from './sdf-scene-candidates';
import {
  planSdfSurfaceCoverage,
  type SdfSurfaceCoverage,
  writeSdfSurfaceCoverage,
} from './sdf-surface-coverage';
import type { SdfPlacementBounds, SdfTransformCertificate } from './sdf-transform-certificate';

/** Private GPU layout, independent of the published field codec and cook generation. */
const {
  version: SDF_SURFACE_POOL_VERSION,
  magic: SDF_SURFACE_POOL_MAGIC,
  maxBytes: SDF_SURFACE_POOL_MAX_BYTES,
  rowWords: SDF_SURFACE_ROW_WORDS,
  sceneWords: SCENE_WORDS,
  maxRows: MAX_ROWS,
} = SDF_SURFACE_POOL_LAYOUT;
const align = (words: number) => Math.ceil(words / 4) * 4;
type SampledField = Extract<MeshDistanceField, { policy: { kind: 'sampled-visibility' } }>;

export interface SdfSurfacePoolRow {
  readonly field: SampledField;
  readonly fieldUpload?: SdfFieldUpload;
  readonly forward: ArrayLike<number>;
  readonly inverse: ArrayLike<number>;
  readonly certificate: SdfTransformCertificate;
  readonly coverage?: SdfSurfaceCoverage;
}
interface Span {
  readonly first: number;
  readonly words: number;
}
export interface SdfSurfaceMeshRegion {
  readonly first: number;
  readonly end: number;
  readonly samples: Span;
  readonly positions: Span;
  readonly indices: Span;
  readonly nodes: Span;
  readonly order: Span;
  readonly sidedness: Span;
}
export interface SdfSurfacePool {
  readonly words: Uint32Array;
  readonly headerCapacity: number;
  /** Derived Mesh regions, never per-instance transform certificates. */
  readonly meshes: ReadonlyMap<SampledField, SdfSurfaceMeshRegion>;
  readonly coverage: readonly (SdfSurfaceCoverage | undefined)[];
}

/** Retained placement facts derived from one pack; geometry remains in the shared Mesh source. */
export interface SdfSurfacePlacement {
  readonly headers: Uint32Array;
  readonly headerCapacity: number;
  readonly meshes: ReadonlyMap<SampledField, SdfSurfaceMeshRegion>;
  readonly coverage: readonly (SdfSurfaceCoverage | undefined)[];
  readonly placementBounds: readonly (SdfPlacementBounds | undefined)[];
  readonly candidates: SdfSceneCandidateDirectory | undefined;
  /** Accepted source-owner epoch, also present when the optional index is disabled. */
  readonly sourceEpoch: number | undefined;
}

export function sdfSurfacePlacement(
  pool: SdfSurfacePool,
  words: Uint32Array,
  placementBounds: readonly (SdfPlacementBounds | undefined)[],
  candidates: SdfSceneCandidateDirectory | undefined,
  sourceEpoch: number | undefined,
): SdfSurfacePlacement {
  return {
    headers: words.slice(0, SCENE_WORDS + pool.headerCapacity * SDF_SURFACE_ROW_WORDS),
    headerCapacity: pool.headerCapacity,
    meshes: pool.meshes,
    coverage: pool.coverage,
    placementBounds,
    candidates,
    sourceEpoch,
  };
}

function capacityValid(capacity: number, bytes: number, rows: number) {
  return (
    Number.isInteger(capacity) &&
    capacity >= 1 &&
    capacity <= MAX_ROWS &&
    rows <= capacity &&
    Number.isInteger(bytes) &&
    bytes >= (SCENE_WORDS + capacity * SDF_SURFACE_ROW_WORDS) * 4 &&
    bytes <= SDF_SURFACE_POOL_MAX_BYTES &&
    bytes % 16 === 0
  );
}
function surfaceWords(field: SampledField) {
  const s = field.surface;
  return [
    s.positions.length,
    s.indices.length,
    s.nodes.byteLength / 4,
    s.primitiveOrder.length,
    s.triangleSidedness.length,
  ];
}
function planRegion(first: number, sampleWords: number, lengths: readonly number[]) {
  let next = first;
  const spans = [sampleWords, ...lengths].map((words) => {
    const span = { first: next, words };
    next = align(next + words);
    return span;
  });
  const [samples, positions, indices, nodes, order, sidedness] = spans;
  if (!samples || !positions || !indices || !nodes || !order || !sidedness)
    throw Error('Field span count');
  return { first, end: next, samples, positions, indices, nodes, order, sidedness };
}
function createRegion(
  field: SampledField,
  first: number,
  maximum: number,
  upload?: SdfFieldUpload,
) {
  const lengths = surfaceWords(field),
    geometryWords = lengths.reduce((total, words) => total + align(words), 0),
    samplePadding = align(field.bricks.length) - field.bricks.length,
    sampleBudget = maximum - first - geometryWords - samplePadding;
  if (sampleBudget < field.bricks.length + 32) return null;
  const samples =
    upload ?? packSampledField(field.values, field.bricks, field.policy.distanceBand, sampleBudget);
  if (!samples || samples.length > sampleBudget) return null;
  const region = planRegion(first, samples.length, lengths);
  return region.end <= maximum ? { region, samples } : null;
}
function rawWords(array: Float32Array | Uint32Array) {
  return new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4);
}
function copyMesh(
  words: Uint32Array,
  field: SampledField,
  region: SdfSurfaceMeshRegion,
  samples: Uint32Array | SdfFieldUpload,
) {
  const s = field.surface;
  if (samples instanceof SdfFieldUpload) samples.copyInto(words, region.samples.first);
  else words.set(samples, region.samples.first);
  words.set(rawWords(s.positions), region.positions.first);
  words.set(s.indices, region.indices.first);
  const nodes = new DataView(s.nodes.buffer, s.nodes.byteOffset, s.nodes.byteLength);
  for (let i = 0; i < region.nodes.words; i++)
    words[region.nodes.first + i] = nodes.getUint32(i * 4, true);
  words.set(s.primitiveOrder, region.order.first);
  words.set(s.triangleSidedness, region.sidedness.first);
}
/** Round a nonnegative source error outward to normal f32 or exact zero. */
function coefficientWord(value: number): number | null {
  if (!(value >= 0) || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  const buffer = new ArrayBuffer(4),
    view = new DataView(buffer);
  view.setFloat32(0, Math.max(value, 2 ** -126), true);
  let word = view.getUint32(0, true);
  if (view.getFloat32(0, true) < value) word++;
  return word < 0x7f800000 ? word : null;
}
function rowHeader(
  row: SdfSurfacePoolRow,
  region: SdfSurfaceMeshRegion,
  coverageFirst: number,
): Uint32Array | null {
  const unsigned = coefficientWord(row.field.policy.unsignedSampleError),
    relative = coefficientWord(row.certificate.localRelative),
    absolute = coefficientWord(row.certificate.localAbsolute);
  if (unsigned === null || relative === null || absolute === null) return null;
  const s = row.field.surface;
  return new Uint32Array([
    region.first,
    region.end,
    1,
    coverageFirst,
    region.samples.first,
    region.samples.words,
    unsigned,
    // The source certificate is at the original source lattice, not an
    // implicitly rounded external f64 origin/spacing. Disable only the prefix.
    Number(
      [...row.field.origin, row.field.spacing, row.field.policy.distanceBand].every(
        (value) => value === Math.fround(value),
      ),
    ),
    region.positions.first,
    s.positions.length / 3,
    region.indices.first,
    s.indices.length / 3,
    region.nodes.first,
    s.nodes.byteLength / 32,
    region.order.first,
    s.primitiveOrder.length,
    region.sidedness.first,
    s.triangleSidedness.length,
    relative,
    absolute,
  ]);
}

/** Reuse an admitted shared Mesh region while keeping placement coefficients per row. */
export function packSdfSurfaceRowHeader(
  row: SdfSurfacePoolRow,
  region: SdfSurfaceMeshRegion,
  coverageFirst: number,
): Result<Uint32Array, RayReferenceError> {
  const header = rowHeader(row, region, coverageFirst);
  return header === null
    ? rayReferenceFailure('surface pool coefficient exceeds the normal finite f32 domain')
    : ok(header);
}

function admitSurfaceRows(rows: readonly (SdfSurfacePoolRow | undefined)[]) {
  const fields = new Set<SampledField>();
  for (const row of rows) {
    if (!row) continue;
    if (row.field.policy.kind !== 'sampled-visibility')
      return rayReferenceFailure('surface pool requires a complete sampled source field');
    const certificate = row.certificate.validate(row.forward, row.inverse);
    if (!certificate.ok) return certificate;
    if (!fields.has(row.field)) {
      if (!validateMeshDistanceField(row.field).ok)
        return rayReferenceFailure('surface pool requires a complete sampled source field');
      fields.add(row.field);
    }
  }
  return ok(undefined);
}

/** CPU packing only. The caller still owns actual rendered-surface eligibility.
 * The reserved header capacity must equal the real Instance allocation, including headroom. */
export function packSdfSurfacePool(
  rows: readonly (SdfSurfacePoolRow | undefined)[],
  headerCapacity: number,
  maxBytes = SDF_SURFACE_POOL_MAX_BYTES,
): Result<SdfSurfacePool, RayReferenceError> {
  if (!capacityValid(headerCapacity, maxBytes, rows.length))
    return rayReferenceFailure(
      'surface pool requires matching 1..1024 row capacity and aligned 16 MiB budget',
      true,
    );
  const admitted = admitSurfaceRows(rows);
  if (!admitted.ok) return admitted;
  const maximum = maxBytes / 4,
    meshes = new Map<SampledField, SdfSurfaceMeshRegion>(),
    prepared: {
      field: SampledField;
      region: SdfSurfaceMeshRegion;
      samples: Uint32Array | SdfFieldUpload;
    }[] = [],
    headers: (Uint32Array | undefined)[] = [];
  const coverage = planSdfSurfaceCoverage(
    rows.map((row) =>
      row
        ? { primitiveCount: row.field.surface.indices.length / 3, coverage: row.coverage }
        : undefined,
    ),
    headerCapacity,
    maximum,
  );
  if (!coverage.ok) return coverage;
  let next = coverage.value.end;
  for (const [index, row] of rows.entries()) {
    if (!row) {
      headers.push(undefined);
      continue;
    }
    const field = row.field;
    let region = meshes.get(field);
    if (!region) {
      const upload =
        row.fieldUpload instanceof SdfFieldUpload && row.fieldUpload.field === field
          ? row.fieldUpload
          : undefined;
      // A sample upload cannot qualify canonical triangles or placement coverage.
      const packed = createRegion(field, next, maximum, upload);
      if (!packed)
        return rayReferenceFailure(
          'surface pool samples and geometry exceed the existing field budget',
          true,
        );
      region = packed.region;
      next = region.end;
      meshes.set(field, region);
      prepared.push({ field, region, samples: packed.samples });
    }
    const header = rowHeader(
      row,
      region,
      coverage.value.first + index * SDF_SURFACE_POOL_LAYOUT.coverageRecordWords,
    );
    if (!header)
      return rayReferenceFailure('surface pool coefficient exceeds the normal finite f32 domain');
    headers.push(header);
  }
  const words = new Uint32Array(next);
  words.set([SDF_SURFACE_POOL_MAGIC, SDF_SURFACE_POOL_VERSION, headerCapacity, next]);
  for (const [index, header] of headers.entries())
    if (header) words.set(header, SCENE_WORDS + index * SDF_SURFACE_ROW_WORDS);
  for (const item of prepared) copyMesh(words, item.field, item.region, item.samples);
  const retainedCoverage = writeSdfSurfaceCoverage(coverage.value, words);
  return ok({ words, headerCapacity, meshes, coverage: retainedCoverage });
}

function normalCoefficient(word: number) {
  return word === 0 || (word >= 0x00800000 && word < 0x7f800000);
}
function headerCounts(words: Uint32Array, first: number): readonly number[] | null {
  const vertices = words[first + 9] ?? 0,
    primitives = words[first + 11] ?? 0,
    nodes = words[first + 13] ?? 0,
    active = words[first + 15] ?? 0,
    flags = words[first + 17] ?? 0;
  if (
    vertices < 3 ||
    vertices > SDF_SURFACE_POOL_LAYOUT.maxVertices ||
    primitives < 1 ||
    primitives > SDF_SURFACE_POOL_LAYOUT.maxPrimitives ||
    nodes < 1 ||
    nodes > SDF_SURFACE_POOL_LAYOUT.maxNodes ||
    active < 1 ||
    active > primitives ||
    flags !== Math.ceil(primitives / 32)
  )
    return null;
  return [words[first + 5] ?? 0, vertices * 3, primitives * 3, nodes * 8, active, flags];
}
function checkedSpans(
  words: Uint32Array,
  first: number,
  lengths: readonly number[],
  reservedEnd: number,
  used: number,
) {
  const start = words[first] ?? 0,
    end = words[first + 1] ?? 0;
  if (start < reservedEnd || start % 4 || end > used || end <= start) return false;
  let next = start;
  for (const [index, length] of lengths.entries()) {
    const offset = words[first + ([4, 8, 10, 12, 14, 16][index] ?? -1)] ?? 0;
    if (offset !== next || length < 1 || length > end - next) return false;
    next = align(next + length);
  }
  return next === end;
}
function sidednessTailValid(words: Uint32Array, first: number) {
  const tailBits = (words[first + 11] ?? 0) & 31;
  if (tailBits === 0) return true;
  const offset = (words[first + 16] ?? 0) + (words[first + 17] ?? 0) - 1;
  return (words[offset] ?? 0xffffffff) >>> tailBits === 0;
}
function coveragePayloadValid(
  words: Uint32Array,
  pointer: number,
  primitiveCount: number,
  reserved: number,
  meshFirst: number,
) {
  const layout = SDF_SURFACE_POOL_LAYOUT,
    count = Math.ceil(primitiveCount / 32);
  if (
    pointer < reserved ||
    pointer % 4 !== 0 ||
    pointer > meshFirst ||
    layout.coveragePayloadWords + align(count) > meshFirst - pointer ||
    words[pointer] !== layout.coverageMagic ||
    words[pointer + 1] !== primitiveCount ||
    words[pointer + 2] !== count ||
    words[pointer + 3] !== 0
  )
    return false;
  const tail = primitiveCount & 31;
  return (
    tail === 0 ||
    (words[pointer + layout.coveragePayloadWords + count - 1] ?? 0xffffffff) >>> tail === 0
  );
}
function coverageValid(words: Uint32Array, first: number, row: number, capacity: number) {
  const layout = SDF_SURFACE_POOL_LAYOUT,
    record = SCENE_WORDS + capacity * SDF_SURFACE_ROW_WORDS + row * layout.coverageRecordWords,
    primitiveCount = words[first + 11] ?? 0,
    mode = words[record + 2] ?? 0xffffffff,
    pointer = words[record + 3] ?? 0xffffffff;
  if (
    words[first + 3] !== record ||
    words[record] !== row ||
    words[record + 1] !== primitiveCount ||
    mode > 2
  )
    return false;
  if (mode < 2) return pointer === 0;
  return coveragePayloadValid(
    words,
    pointer,
    primitiveCount,
    SCENE_WORDS + capacity * (SDF_SURFACE_ROW_WORDS + layout.coverageRecordWords),
    words[first] ?? 0,
  );
}
function sceneHeaderValid(words: Uint32Array, row: number, instanceCapacity: number) {
  const capacity = words[2] ?? 0,
    used = words[3] ?? 0;
  if (
    capacity < 1 ||
    capacity > MAX_ROWS ||
    words.length > SDF_SURFACE_POOL_MAX_BYTES / 4 ||
    capacity !== instanceCapacity ||
    words[0] !== SDF_SURFACE_POOL_MAGIC ||
    (words[1] !== SDF_SURFACE_POOL_VERSION &&
      words[1] !== SDF_SURFACE_POOL_LAYOUT.indexedVersion) ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= capacity ||
    used > words.length ||
    used <
      SCENE_WORDS + capacity * (SDF_SURFACE_ROW_WORDS + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords)
  )
    return false;
  return true;
}
/** CPU admission mirror; GPU consumers still need real raw-word/span guards.
 * Extra allocated headroom is allowed, but never treated as published source words. */
export function validateSdfSurfacePoolHeader(
  words: Uint32Array,
  row: number,
  instanceCapacity: number,
): Result<void, RayReferenceError> {
  if (!sceneHeaderValid(words, row, instanceCapacity))
    return rayReferenceFailure('invalid surface pool scene header or bound allocation');
  const capacity = words[2] ?? 0,
    directory = readSdfSceneCandidateDirectory(words);
  if (!directory.ok) return directory;
  const used = directory.value?.geometryEnd ?? words[3] ?? 0;
  const first = SCENE_WORDS + row * SDF_SURFACE_ROW_WORDS;
  if (
    words[first + 2] !== 1 ||
    (words[first + 7] ?? 0xffffffff) > 1 ||
    ![6, 18, 19].every((offset) => normalCoefficient(words[first + offset] ?? 0xffffffff))
  )
    return rayReferenceFailure('surface row is unavailable or has unknown flags or coefficients');
  const lengths = headerCounts(words, first);
  if (
    !lengths ||
    !checkedSpans(
      words,
      first,
      lengths,
      SCENE_WORDS +
        capacity * (SDF_SURFACE_ROW_WORDS + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords),
      used,
    ) ||
    !coverageValid(words, first, row, capacity) ||
    !sidednessTailValid(words, first)
  )
    return rayReferenceFailure('surface row channel counts or spans are not canonical');
  return ok(undefined);
}
