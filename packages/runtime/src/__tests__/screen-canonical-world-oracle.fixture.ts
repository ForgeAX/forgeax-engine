import { assert } from 'vitest';
import type { Fraction } from '../../../shader/src/__tests__/canonical-receiver-reconstruction.fixture';
import { exactEndpointDyadic } from '../../../shader/src/__tests__/sdf-surface-exact-endpoints.fixture';
import type { ScreenReceiverAuthoredMesh } from './screen-canonical-receiver.fixture';

function q(n: bigint, d = 1n): Fraction {
  assert(d !== 0n);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return { n: n / a, d: d / a };
}
const real = (f: number) =>
  q(exactEndpointDyadic(new Uint32Array(Float32Array.of(f).buffer)[0] ?? 0), 1n << 149n);
const add = (a: Fraction, b: Fraction) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Fraction, b: Fraction) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Fraction, b: Fraction) => q(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction) => q(a.n * b.d, a.d * b.n);
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const abs = (a: Fraction) => q(a.n < 0n ? -a.n : a.n, a.d);
type Vector = readonly [Fraction, Fraction, Fraction];
const vector = (a: readonly Fraction[]): Vector => {
  assert(a[0] && a[1] && a[2]);
  return [a[0], a[1], a[2]];
};
const minus = (a: Vector, b: Vector): Vector => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])];
const cross = (a: Vector, b: Vector): Vector => [
  sub(mul(a[1], b[2]), mul(a[2], b[1])),
  sub(mul(a[2], b[0]), mul(a[0], b[2])),
  sub(mul(a[0], b[1]), mul(a[1], b[0])),
];
const dot = (a: Vector, b: Vector) => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));

interface Intersection {
  readonly handle: number;
  readonly primitive: number;
  readonly t: Fraction;
  readonly point: Vector;
  readonly interior: boolean;
}

function triangleIntersection(a: Vector, b: Vector, c: Vector, o: Vector, d: Vector) {
  const ab = minus(b, a),
    ac = minus(c, a),
    p = cross(d, ac),
    determinant = dot(ab, p);
  if (determinant.n === 0n) return undefined;
  const s = minus(o, a),
    u = div(dot(s, p), determinant),
    r = cross(s, ab);
  const v = div(dot(d, r), determinant),
    sum = add(u, v),
    t = div(dot(ac, r), determinant);
  if (u.n < 0n || v.n < 0n || compare(sum, q(1n)) > 0n || t.n < 0n) return undefined;
  return {
    t,
    point: vector(o.map((x, axis) => add(x, mul(d[axis] as Fraction, t)))),
    interior: u.n > 0n && v.n > 0n && compare(sum, q(1n)) < 0n,
  };
}

/** Independent rational triangle roster over the exact authored translations.
 * Excludes precisely the selected primitive's construction contact, never its instance. */
export function exactCanonicalWorld(
  meshes: readonly ScreenReceiverAuthoredMesh[],
  origin: readonly Fraction[],
  direction: readonly number[],
  contact: { readonly handle: number; readonly primitive: number },
  end: number,
) {
  const o = vector(origin),
    d = vector(direction.map(real)),
    hits: Intersection[] = [];
  for (const row of meshes) {
    const indices = row.mesh.indices,
      positions = row.mesh.attributes.position as Float32Array;
    assert(indices);
    const vertex = (index: number) =>
      vector(
        [0, 1, 2].map((axis) => {
          const value = positions[index * 3 + axis],
            offset = row.position[axis];
          assert(value !== undefined && offset !== undefined);
          return add(real(value), real(offset));
        }),
      );
    for (let p = 0; p < indices.length / 3; p++) {
      if (row.handle === contact.handle && p === contact.primitive) continue;
      const i = [indices[p * 3], indices[p * 3 + 1], indices[p * 3 + 2]];
      assert(i[0] !== undefined && i[1] !== undefined && i[2] !== undefined);
      const hit = triangleIntersection(vertex(i[0]), vertex(i[1]), vertex(i[2]), o, d);
      if (hit && compare(hit.t, real(end)) <= 0n)
        hits.push({ ...hit, handle: row.handle, primitive: p });
    }
  }
  hits.sort((a, b) => {
    const order = compare(a.t, b.t);
    return order < 0n ? -1 : order > 0n ? 1 : 0;
  });
  return { hits, direction: d };
}

export function decodeScreenWorldHit(raw: ArrayBuffer, record: number) {
  const f = new Float32Array(raw, record * 32, 8),
    u = new Uint32Array(raw, record * 32, 8);
  const encoded = u[2] ?? 0;
  return {
    status: (encoded >>> 24) & 127,
    flags: encoded & 0x807fffff,
    instance: u[3] ?? 0xffffffff,
    t: f[0] ?? NaN,
    error: f[1] ?? NaN,
    position: [f[4] ?? NaN, f[5] ?? NaN, f[6] ?? NaN],
    legacyDistance: f[7] ?? NaN,
    primitive: (encoded >>> 2) & 0x1fffff,
  };
}

/** The actual point.error must enclose the independent nearest point and be
 * narrower than the real next-face separation. No arbitrary distance epsilon.
 * metrics.x is recorded but its time enclosure is not qualified by this gate. */
export function checkScreenWorldHit(
  actual: ReturnType<typeof decodeScreenWorldHit>,
  reference: ReturnType<typeof exactCanonicalWorld>,
  expectedInstance: number,
) {
  const first = reference.hits[0];
  assert(first);
  assert(actual.status === 1 && actual.instance === expectedInstance && actual.flags >>> 31 === 1);
  const tied = reference.hits.filter((hit) => compare(hit.t, first.t) === 0n);
  assert(tied.some((hit) => hit.handle === first.handle && hit.primitive === actual.primitive));
  assert(Number.isFinite(actual.error) && actual.error >= 0 && Number.isFinite(actual.t));
  const error = real(actual.error);
  first.point.forEach((p, axis) => {
    const value = actual.position[axis];
    assert(value !== undefined && Number.isFinite(value));
    assert(
      compare(abs(sub(real(value), p)), error) <= 0n,
      `Nearest point not enclosed on axis ${axis}`,
    );
  });
  assert(first.t.n > 0n, 'A different t=0 contact is outside this strict-interior gate');
  const second = reference.hits.find((hit) => compare(hit.t, first.t) > 0n);
  const nextGap = second === undefined ? first.t : sub(second.t, first.t);
  const gap = compare(nextGap, first.t) < 0n ? nextGap : first.t;
  const separationSquared = mul(mul(gap, gap), dot(reference.direction, reference.direction));
  assert(
    compare(mul(q(4n), mul(error, error)), separationSquared) < 0n,
    'Enclosure must exclude the next authored face',
  );
  return {
    timeValidation: 'not-qualified',
    handle: first.handle,
    primitive: actual.primitive,
    nextFace: second?.primitive ?? 'selected-contact',
    exactPoint: first.point.map((p) => ({ n: p.n.toString(), d: p.d.toString() })),
    exactT: { n: first.t.n.toString(), d: first.t.d.toString() },
  };
}
