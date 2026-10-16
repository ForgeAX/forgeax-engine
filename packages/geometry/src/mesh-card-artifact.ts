import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { type MeshCardLayout, meshCardFailure } from './mesh-card-layout';

const MAX_ARTIFACT_BYTES = 256 * 1024;

export function validateMeshCardLayout(layout: MeshCardLayout): Result<void, AssetError> {
  const vec = (value: unknown): value is readonly [number, number, number] =>
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)));
  const dot = (a: readonly number[], b: readonly number[]) =>
    a.reduce((sum, x, i) => sum + x * (b[i] ?? NaN), 0);
  const count = (x: number) => Number.isSafeInteger(x) && x >= 0;
  if (
    !layout ||
    !/^[a-f0-9]{64}$/.test(layout.meshDigest) ||
    !/^[a-f0-9]{64}$/.test(layout.sidednessDigest) ||
    !layout.bounds ||
    !vec(layout.bounds.min) ||
    !vec(layout.bounds.max) ||
    layout.bounds.min.some((x, i) => x > (layout.bounds.max[i] ?? -Infinity)) ||
    !Array.isArray(layout.cards) ||
    layout.cards.length > 64 ||
    !layout.sampling
  )
    return meshCardFailure('invalid mesh card layout identity or bounds', null);
  const s = layout.sampling;
  if (
    !Number.isInteger(s.resolution) ||
    s.resolution < 8 ||
    s.resolution > 32 ||
    !Number.isFinite(s.spacing) ||
    s.spacing <= 0 ||
    !count(s.rays) ||
    !count(s.surfels) ||
    s.surfels > 32768 ||
    !count(s.rejectedInside) ||
    !Number.isFinite(s.weightedCoverage) ||
    s.weightedCoverage < 0 ||
    !Number.isFinite(s.representedWeight) ||
    s.representedWeight < 0 ||
    s.representedWeight > s.weightedCoverage + 1e-8 ||
    (layout.cards.length === 0 && s.representedWeight !== 0)
  )
    return meshCardFailure('invalid card sampling and coverage evidence', s);
  for (const card of layout.cards) {
    if (
      !card ||
      !vec(card.origin) ||
      !vec(card.u) ||
      !vec(card.v) ||
      !vec(card.n) ||
      ![card.width, card.height, card.depth].every(
        (x) => x > 0 && Number.isFinite(Math.fround(x)),
      ) ||
      [card.u, card.v, card.n].some((axis) => Math.abs(dot(axis, axis) - 1) > 1e-5) ||
      Math.abs(dot(card.u, card.v)) > 1e-5 ||
      Math.abs(dot(card.u, card.n)) > 1e-5 ||
      Math.abs(dot(card.v, card.n)) > 1e-5 ||
      dot(
        [
          card.u[1] * card.n[2] - card.u[2] * card.n[1],
          card.u[2] * card.n[0] - card.u[0] * card.n[2],
          card.u[0] * card.n[1] - card.u[1] * card.n[0],
        ],
        card.v,
      ) <
        1 - 1e-5
    )
      return meshCardFailure('card requires finite orthonormal axes and positive extents', card);
  }
  return ok(undefined);
}

/** Card layouts describe static triangle-list geometry; the producer and every decoder admit them by this rule. */
export function admitsMeshCardLayout(mesh: {
  readonly submeshes: readonly { readonly topology?: unknown }[];
  readonly morphTargets?: unknown;
  readonly skinIndex?: unknown;
}): boolean {
  return (
    mesh.submeshes.every((section) => section.topology === 'triangle-list') &&
    mesh.morphTargets === undefined &&
    mesh.skinIndex === undefined
  );
}

/** Pack/DDC owns byte integrity; this codec owns representation version and geometry identity. */
export function encodeMeshCardLayout(layout: MeshCardLayout): Result<Uint8Array, AssetError> {
  const valid = validateMeshCardLayout(layout);
  if (!valid.ok) return valid;
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 2, layout }));
  return bytes.byteLength <= MAX_ARTIFACT_BYTES
    ? ok(bytes)
    : meshCardFailure('card artifact exceeds 256 KiB metadata limit', bytes.byteLength);
}

export function decodeMeshCardLayout(
  bytes: Uint8Array,
  expectedMeshDigest: string,
): Result<MeshCardLayout, AssetError> {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    return meshCardFailure('card artifact exceeds 256 KiB metadata limit', bytes.byteLength);
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed.version !== 2 || parsed.layout?.meshDigest !== expectedMeshDigest)
      return meshCardFailure(
        'unsupported card artifact version or stale source geometry',
        expectedMeshDigest,
      );
    const valid = validateMeshCardLayout(parsed.layout);
    return valid.ok ? ok(parsed.layout) : valid;
  } catch {
    return meshCardFailure('malformed card artifact', null);
  }
}
