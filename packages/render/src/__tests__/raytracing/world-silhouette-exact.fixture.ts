type Vector = readonly [number, number, number];
type IntegerVector = readonly [bigint, bigint, bigint];
type Dyadic = readonly [bigint, number];

export interface ExactAuthoredMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly transform: Float32Array;
  readonly id: number;
}

interface AuthoredRay {
  readonly origin: Vector;
  readonly direction: Vector;
  readonly end: number;
}

interface IntegerTriangle {
  readonly instance: number;
  readonly primitive: number;
  readonly a: IntegerVector;
  readonly ab: IntegerVector;
  readonly ac: IntegerVector;
}

interface ExactIntersection {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly frontFace: boolean;
  readonly triangle: IntegerTriangle;
}

/** Every finite binary64 input is an exact integer times a power of two. */
function dyadic(value: number): Dyadic {
  if (!Number.isFinite(value)) throw Error('Finite authored geometry is required');
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value, true);
  const bits = bytes.getBigUint64(0, true);
  const exponent = Number((bits >> 52n) & 2047n);
  let integer = bits & ((1n << 52n) - 1n);
  if (exponent !== 0) integer |= 1n << 52n;
  if (integer === 0n) return [0n, 0];
  let power = exponent === 0 ? -1074 : exponent - 1075;
  if (bits >> 63n !== 0n) integer = -integer;
  while ((integer & 1n) === 0n) {
    integer >>= 1n;
    power++;
  }
  return [integer, power];
}

function add(a: Dyadic, b: Dyadic): Dyadic {
  const power = Math.min(a[1], b[1]);
  return [(a[0] << BigInt(a[1] - power)) + (b[0] << BigInt(b[1] - power)), power];
}

function product(a: number, b: number): Dyadic {
  const x = dyadic(a);
  const y = dyadic(b);
  return [x[0] * y[0], x[1] + y[1]];
}

function component(values: Float32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw Error('Complete canonical source span is required');
  return value;
}

function transformedVertex(mesh: ExactAuthoredMesh, vertex: number): readonly Dyadic[] {
  const p = mesh.positions;
  const m = mesh.transform;
  const x = component(p, vertex * 3);
  const y = component(p, vertex * 3 + 1);
  const z = component(p, vertex * 3 + 2);
  return [0, 1, 2].map((axis) =>
    add(
      add(product(component(m, axis), x), product(component(m, axis + 4), y)),
      add(product(component(m, axis + 8), z), dyadic(component(m, axis + 12))),
    ),
  );
}

function quantize(value: Dyadic, power: number): bigint {
  if (value[1] < power) throw Error('The common quantum must cover every source bit');
  return value[0] << BigInt(value[1] - power);
}

function integerVector(values: readonly Dyadic[], power: number): IntegerVector {
  if (values.length !== 3) throw Error('Three coordinates are required');
  return values.map((value) => quantize(value, power)) as unknown as IntegerVector;
}

function subtract(a: IntegerVector, b: IntegerVector): IntegerVector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: IntegerVector, b: IntegerVector): IntegerVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: IntegerVector, b: IntegerVector): bigint {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sourceVertices(meshes: readonly ExactAuthoredMesh[]) {
  return meshes.map((mesh) => {
    if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
      throw Error('Complete triangle source arrays are required');
    }
    return Array.from({ length: mesh.positions.length / 3 }, (_, i) => transformedVertex(mesh, i));
  });
}

function commonPower(
  vertices: readonly (readonly (readonly Dyadic[])[])[],
  rays: readonly AuthoredRay[],
) {
  let power = 0;
  for (const mesh of vertices)
    for (const vertex of mesh) for (const value of vertex) power = Math.min(power, value[1]);
  for (const ray of rays)
    for (const value of [...ray.origin, ...ray.direction])
      power = Math.min(power, dyadic(value)[1]);
  return power;
}

function integerTriangles(
  meshes: readonly ExactAuthoredMesh[],
  vertices: ReturnType<typeof sourceVertices>,
  power: number,
) {
  const triangles: IntegerTriangle[] = [];
  for (const [row, mesh] of meshes.entries()) {
    const points = vertices[row]?.map((vertex) => integerVector(vertex, power));
    if (!points) throw Error('Every mesh must have canonical vertices');
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = points[mesh.indices[i] ?? -1];
      const b = points[mesh.indices[i + 1] ?? -1];
      const c = points[mesh.indices[i + 2] ?? -1];
      if (!a || !b || !c) throw Error('Canonical triangle indices must be in range');
      triangles.push({
        instance: mesh.id,
        primitive: i / 3,
        a,
        ab: subtract(b, a),
        ac: subtract(c, a),
      });
    }
  }
  return triangles;
}

function intersect(
  triangle: IntegerTriangle,
  origin: IntegerVector,
  direction: IntegerVector,
): ExactIntersection | undefined {
  const p = cross(direction, triangle.ac);
  const determinant = dot(triangle.ab, p);
  if (determinant === 0n) {
    const normal = cross(triangle.ab, triangle.ac);
    if (dot(normal, normal) !== 0n && dot(subtract(origin, triangle.a), normal) === 0n) {
      throw Error('Coplanar rays require a separate oracle contract');
    }
    return undefined;
  }
  const sign = determinant < 0n ? -1n : 1n;
  const denominator = determinant * sign;
  const s = subtract(origin, triangle.a);
  const u = dot(s, p) * sign;
  if (u < 0n || u > denominator) return undefined;
  const q = cross(s, triangle.ab);
  const v = dot(direction, q) * sign;
  if (v < 0n || u + v > denominator) return undefined;
  const numerator = dot(triangle.ac, q) * sign;
  if (numerator < 0n) return undefined;
  return { numerator, denominator, frontFace: determinant > 0n, triangle };
}

function beforeEnd(hit: ExactIntersection, end: number): boolean {
  const [integer, power] = dyadic(end);
  return power >= 0
    ? hit.numerator <= hit.denominator * (integer << BigInt(power))
    : hit.numerator << BigInt(-power) <= hit.denominator * integer;
}

function nearestIntersections(
  triangles: readonly IntegerTriangle[],
  ray: AuthoredRay,
  power: number,
) {
  const origin = integerVector(ray.origin.map(dyadic), power);
  const direction = integerVector(ray.direction.map(dyadic), power);
  let nearest: ExactIntersection[] = [];
  for (const triangle of triangles) {
    const hit = intersect(triangle, origin, direction);
    if (!hit || !beforeEnd(hit, ray.end)) continue;
    const previous = nearest[0];
    if (!previous) nearest = [hit];
    else {
      const order = hit.numerator * previous.denominator - previous.numerator * hit.denominator;
      if (order < 0n) nearest = [hit];
      else if (order === 0n) nearest.push(hit);
    }
  }
  return nearest;
}

/** Exact forward-transform and closed-triangle predicates; no inverse, field, epsilon or GPU output. */
export function exactAuthoredSurfaces(
  meshes: readonly ExactAuthoredMesh[],
  rays: readonly AuthoredRay[],
) {
  const vertices = sourceVertices(meshes);
  const power = commonPower(vertices, rays);
  const triangles = integerTriangles(meshes, vertices, power);
  return rays.map((ray) => nearestIntersections(triangles, ray, power));
}

export function assessAuthoredSurface(
  nearest: ReturnType<typeof exactAuthoredSurfaces>[number],
  state: readonly number[],
  normal: Vector,
) {
  const marker = state[1] ?? 0;
  const primitive = (marker >>> 2) & 0x1fffff;
  const face = nearest.find(
    (hit) => hit.triangle.instance === state[3] && hit.triangle.primitive === primitive,
  );
  const markerValid = state[0] === 1 && marker >>> 31 === 1 && (marker & 0x7f800002) === 0;
  const identityCorrect = markerValid && face !== undefined;
  const facingCorrect = face !== undefined && (marker & 1) === Number(face.frontFace);
  return {
    primitive,
    markerValid,
    identityCorrect,
    facingCorrect,
    normalCorrect: face !== undefined && normalCorrect(face.triangle, normal),
  };
}

function normalCorrect(triangle: IntegerTriangle, normal: Vector): boolean {
  if (!normal.every(Number.isFinite)) return false;
  const values = normal.map(dyadic);
  const power = Math.min(0, ...values.map((value) => value[1]));
  const actual = integerVector(values, power);
  const expected = cross(triangle.ab, triangle.ac);
  const alignment = dot(actual, expected);
  const actualSquared = dot(actual, actual);
  const expectedSquared = dot(expected, expected);
  if (alignment <= 0n || actualSquared === 0n || expectedSquared === 0n) return false;
  // Separate explicit engineering gates: cos^2 >= 0.999999 and |length-1| <= 0.0001.
  const angular = alignment * alignment * 1_000_000n >= actualSquared * expectedSquared * 999_999n;
  const unit = 1n << BigInt(-2 * power);
  const length = actualSquared * 100_000_000n;
  return angular && length >= unit * 99_980_001n && length <= unit * 100_020_001n;
}

export function describeAuthoredSurface(nearest: ReturnType<typeof exactAuthoredSurfaces>[number]) {
  return nearest.map((hit) => ({
    instance: hit.triangle.instance,
    primitive: hit.triangle.primitive,
    frontFace: hit.frontFace,
    numerator: String(hit.numerator),
    denominator: String(hit.denominator),
  }));
}
