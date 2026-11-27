import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';

/** Placement qualification; the Mesh continues to own all canonical geometry. */
export type SdfSurfaceCoverage =
  | 'opaque'
  | 'unknown'
  | 'unavailable'
  | { readonly kind: 'partial'; readonly opaquePrimitives: Uint32Array };

/** One accepted state owns its copies; equal source-array aliases share that owned copy. */
export function snapshotSdfSurfaceCoverage(
  coverage: SdfSurfaceCoverage | undefined,
  copies: WeakMap<Uint32Array, Uint32Array>,
): SdfSurfaceCoverage {
  if (coverage === undefined || typeof coverage === 'string') return coverage ?? 'opaque';
  let bits = copies.get(coverage.opaquePrimitives);
  if (bits === undefined) {
    bits = coverage.opaquePrimitives.slice();
    copies.set(coverage.opaquePrimitives, bits);
  }
  return Object.freeze({ kind: 'partial', opaquePrimitives: bits });
}

/** Derive once from the admitted whole-Mesh section namespace and effective materials. */
export function deriveSdfSurfaceCoverage(
  mesh: Pick<MeshAsset, 'submeshes' | 'indices'>,
  materials: readonly { readonly alphaCoverageOmitted: boolean }[],
  primitiveCount: number,
): Result<SdfSurfaceCoverage, RayReferenceError> {
  if (materials.length !== mesh.submeshes.length || primitiveCount < 1)
    return rayReferenceFailure('surface coverage requires every actual Mesh section');
  let end = 0;
  const ranges: { first: number; end: number; opaque: boolean }[] = [];
  for (const [index, section] of mesh.submeshes.entries()) {
    const first = mesh.indices === undefined ? end : section.indexOffset / 3;
    const count = (mesh.indices === undefined ? section.vertexCount : section.indexCount) / 3;
    const material = materials[index];
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(count) ||
      first !== end ||
      count < 1 ||
      first + count > primitiveCount ||
      section.topology !== 'triangle-list' ||
      typeof material?.alphaCoverageOmitted !== 'boolean'
    )
      return rayReferenceFailure(
        'surface coverage must partition the canonical primitive namespace',
      );
    end = first + count;
    ranges.push({ first, end, opaque: !material.alphaCoverageOmitted });
  }
  if (end !== primitiveCount)
    return rayReferenceFailure(
      'surface coverage must retain the complete canonical primitive namespace',
    );
  if (ranges.every((range) => range.opaque)) return ok('opaque');
  if (ranges.every((range) => !range.opaque)) return ok('unknown');
  const bits = new Uint32Array(Math.ceil(primitiveCount / 32));
  for (const range of ranges) if (range.opaque) markOpaque(bits, range.first, range.end);
  return ok({ kind: 'partial', opaquePrimitives: bits });
}

function markOpaque(bits: Uint32Array, first: number, end: number): void {
  while (first < end) {
    const offset = first & 31;
    const count = Math.min(end - first, 32 - offset);
    const word = first >>> 5;
    bits[word] = ((bits[word] ?? 0) | ((0xffffffff >>> (32 - count)) << offset)) >>> 0;
    first += count;
  }
}

export function sameSdfSurfaceCoverage(
  left: SdfSurfaceCoverage | undefined,
  right: SdfSurfaceCoverage | undefined,
): boolean {
  const a = left ?? 'opaque',
    b = right ?? 'opaque';
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return false;
  return (
    a.opaquePrimitives.length === b.opaquePrimitives.length &&
    a.opaquePrimitives.every((word, index) => word === b.opaquePrimitives[index])
  );
}

export interface SdfSurfaceCoveragePattern {
  /** Explicit all-opaque, all-unknown, or partial. No absent GPU record is opaque. */
  readonly mode: 0 | 1 | 2;
  readonly bits: Uint32Array | undefined;
}

/** Validate before allocation. Constants do not allocate a per-placement bitmap. */
export function sdfSurfaceCoveragePattern(
  coverage: SdfSurfaceCoverage | undefined,
  primitiveCount: number,
): Result<SdfSurfaceCoveragePattern, RayReferenceError> {
  if (
    !Number.isSafeInteger(primitiveCount) ||
    primitiveCount < 1 ||
    primitiveCount > SDF_SURFACE_POOL_LAYOUT.maxPrimitives
  )
    return rayReferenceFailure('surface coverage requires the complete canonical primitive count');
  if (coverage === undefined || coverage === 'opaque') return ok({ mode: 0, bits: undefined });
  if (coverage === 'unknown' || coverage === 'unavailable') return ok({ mode: 1, bits: undefined });
  if (coverage === null || typeof coverage !== 'object' || coverage.kind !== 'partial')
    return rayReferenceFailure('surface coverage requires an explicit placement qualification');
  const bits = coverage.opaquePrimitives,
    count = Math.ceil(primitiveCount / 32),
    tail = primitiveCount & 31;
  if (
    !(bits instanceof Uint32Array) ||
    bits.length !== count ||
    (tail !== 0 && (bits[count - 1] ?? 0xffffffff) >>> tail !== 0)
  )
    return rayReferenceFailure(
      'partial surface coverage requires exact words and a zero unused tail',
    );
  if (bits.every((word) => word === 0)) return ok({ mode: 1, bits: undefined });
  if (
    bits.every(
      (word, index) =>
        word === (index === count - 1 && tail !== 0 ? 0xffffffff >>> (32 - tail) : 0xffffffff),
    )
  )
    return ok({ mode: 0, bits: undefined });
  return ok({ mode: 2, bits });
}

interface CoverageSource {
  readonly primitiveCount: number;
  readonly coverage: SdfSurfaceCoverage | undefined;
}
interface CoveragePayload {
  readonly first: number;
  readonly primitiveCount: number;
  readonly bits: Uint32Array;
}
interface CoverageRecord {
  readonly row: number;
  readonly primitiveCount: number;
  readonly mode: 0 | 1 | 2;
  readonly payload: CoveragePayload | undefined;
  readonly coverage: SdfSurfaceCoverage;
}
export interface SdfSurfaceCoveragePlan {
  readonly first: number;
  readonly end: number;
  readonly records: readonly CoverageRecord[];
  readonly payloads: readonly CoveragePayload[];
}

/** One pool's immutable content spans, not another source or lifetime registry. */
export function planSdfSurfaceCoverage(
  rows: readonly (CoverageSource | undefined)[],
  capacity: number,
  maximum: number,
): Result<SdfSurfaceCoveragePlan, RayReferenceError> {
  const layout = SDF_SURFACE_POOL_LAYOUT;
  const first = layout.sceneWords + capacity * layout.rowWords;
  let end = first + capacity * layout.coverageRecordWords;
  const records: CoverageRecord[] = [];
  const payloads = new Map<string, CoveragePayload>();
  const keys = new WeakMap<Uint32Array, string>();
  for (const [row, source] of rows.entries()) {
    if (!source) continue;
    const pattern = sdfSurfaceCoveragePattern(source.coverage, source.primitiveCount);
    if (!pattern.ok) return pattern;
    let payload: CoveragePayload | undefined;
    const bits = pattern.value.bits;
    if (bits !== undefined) {
      let content = keys.get(bits);
      if (content === undefined) {
        content = bits.join(',');
        keys.set(bits, content);
      }
      const key = `${source.primitiveCount}:${content}`;
      payload = payloads.get(key);
      if (payload === undefined) {
        payload = { first: end, primitiveCount: source.primitiveCount, bits };
        end += layout.coveragePayloadWords + Math.ceil(bits.length / 4) * 4;
        payloads.set(key, payload);
      }
    }
    const coverage: SdfSurfaceCoverage =
      payload === undefined
        ? (source.coverage ?? 'opaque')
        : { kind: 'partial', opaquePrimitives: payload.bits };
    records.push({
      row,
      primitiveCount: source.primitiveCount,
      mode: pattern.value.mode,
      payload,
      coverage,
    });
    if (end > maximum)
      return rayReferenceFailure(
        'surface placement coverage exceeds the existing field budget',
        true,
      );
  }
  if (end > maximum)
    return rayReferenceFailure(
      'surface placement coverage exceeds the existing field budget',
      true,
    );
  return ok({ first, end, records, payloads: [...payloads.values()] });
}

/** Called only after complete coverage and shared geometry admission. */
export function writeSdfSurfaceCoverage(plan: SdfSurfaceCoveragePlan, words: Uint32Array) {
  const layout = SDF_SURFACE_POOL_LAYOUT;
  const retained: (SdfSurfaceCoverage | undefined)[] = [];
  const copies = new WeakMap<Uint32Array, Uint32Array>();
  for (const payload of plan.payloads) {
    words.set(
      [layout.coverageMagic, payload.primitiveCount, payload.bits.length, 0],
      payload.first,
    );
    words.set(payload.bits, payload.first + layout.coveragePayloadWords);
  }
  for (const record of plan.records) {
    words.set(
      [record.row, record.primitiveCount, record.mode, record.payload?.first ?? 0],
      plan.first + record.row * layout.coverageRecordWords,
    );
    retained[record.row] = snapshotSdfSurfaceCoverage(record.coverage, copies);
  }
  return retained;
}
