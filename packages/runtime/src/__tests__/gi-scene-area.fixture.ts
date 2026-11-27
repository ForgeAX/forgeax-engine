import { sceneValue } from './gi-scene-value.fixture';
/** Independent double-precision finite-area oracle. No Engine math or shader imports. */
export type Point3 = readonly [number, number, number];
export interface AreaBox {
  readonly min: Point3;
  readonly max: Point3;
  readonly radiance: Point3;
}
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point3, b: Point3): Point3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function receiverHemisphere(point: Point3, normal: Point3, polygon: readonly Point3[]) {
  const result: Point3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = sceneValue(polygon[i]);
    const b = sceneValue(polygon[(i + 1) % polygon.length]);
    const da = dot(subtract(a, point), normal),
      db = dot(subtract(b, point), normal);
    if (da >= 0) result.push(a);
    if (da < 0 !== db < 0) {
      const t = da / (da - db);
      result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return result;
}

/** Integral of max(n dot omega,0) dOmega / pi over an unoccluded polygon. */
export function polygonFormFactor(point: Point3, normal: Point3, polygon: readonly Point3[]) {
  const directions = receiverHemisphere(point, normal, polygon).map((p): Point3 => {
    const delta = subtract(p, point),
      length = Math.hypot(...delta);
    if (length === 0) throw new Error('Receiver may not coincide with an emitter vertex');
    return [delta[0] / length, delta[1] / length, delta[2] / length];
  });
  let sum = 0;
  for (let i = 0; i < directions.length; i++) {
    const a = sceneValue(directions[i]),
      b = sceneValue(directions[(i + 1) % directions.length]);
    const edge = cross(a, b),
      sine = Math.hypot(...edge);
    if (sine > 1e-14) sum += (Math.atan2(sine, dot(a, b)) * dot(normal, edge)) / sine;
  }
  return Math.abs(sum) / (2 * Math.PI);
}

export function boxFaces(box: AreaBox) {
  const faces: { normal: Point3; corners: Point3[]; area: number }[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map(([a, b]) => {
        const p = [0, 0, 0] as [number, number, number];
        p[axis] = sceneValue(sign < 0 ? box.min[axis] : box.max[axis]);
        p[u] = sceneValue(a === 0 ? box.min[u] : box.max[u]);
        p[v] = sceneValue(b === 0 ? box.min[v] : box.max[v]);
        return p;
      });
      const normal = [0, 0, 0] as [number, number, number];
      normal[axis] = sign;
      faces.push({
        normal,
        corners,
        area:
          (sceneValue(box.max[u]) - sceneValue(box.min[u])) *
          (sceneValue(box.max[v]) - sceneValue(box.min[v])),
      });
    }
  return faces;
}

export function boxFormFactor(point: Point3, normal: Point3, box: AreaBox) {
  return boxFaces(box).reduce(
    (sum, face) =>
      dot(subtract(point, sceneValue(face.corners[0])), face.normal) > 0
        ? sum + polygonFormFactor(point, normal, face.corners)
        : sum,
    0,
  );
}

/** Independent midpoint area quadrature; used to challenge the edge-angle formula. */
export function quadratureBox(
  point: Point3,
  normal: Point3,
  box: AreaBox,
  resolution: number,
  blockers: readonly AreaBox[] = [],
) {
  let total = 0;
  for (const face of boxFaces(box)) {
    if (dot(subtract(point, sceneValue(face.corners[0])), face.normal) <= 0) continue;
    const origin = sceneValue(face.corners[0]),
      du = subtract(sceneValue(face.corners[1]), origin),
      dv = subtract(sceneValue(face.corners[3]), origin);
    for (let y = 0; y < resolution; y++)
      for (let x = 0; x < resolution; x++) {
        const u = (x + 0.5) / resolution,
          v = (y + 0.5) / resolution;
        const delta: Point3 = [
          origin[0] + du[0] * u + dv[0] * v - point[0],
          origin[1] + du[1] * u + dv[1] * v - point[1],
          origin[2] + du[2] * u + dv[2] * v - point[2],
        ];
        const distance2 = dot(delta, delta);
        if (blockers.some((blocker) => segmentIntersectsBox(point, delta, blocker))) continue;
        total +=
          (Math.max(dot(normal, delta), 0) * Math.max(-dot(face.normal, delta), 0) * face.area) /
          (resolution * resolution * Math.PI * distance2 * distance2);
      }
  }
  return total;
}

/** The segment parameter is [0,1]; endpoints never count as a blocker. */
export function segmentIntersectsBox(origin: Point3, delta: Point3, box: AreaBox) {
  let near = 1e-7,
    far = 1 - 1e-7;
  for (let axis = 0; axis < 3; axis++) {
    if (delta[axis] === 0) {
      if (
        sceneValue(origin[axis]) < sceneValue(box.min[axis]) ||
        sceneValue(origin[axis]) > sceneValue(box.max[axis])
      )
        return false;
    } else {
      const a = (sceneValue(box.min[axis]) - sceneValue(origin[axis])) / sceneValue(delta[axis]),
        b = (sceneValue(box.max[axis]) - sceneValue(origin[axis])) / sceneValue(delta[axis]);
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
  }
  return near <= far;
}

/** Independent smooth midpoint quadrature over a planar rectangle. */
export function quadraturePolygon(
  point: Point3,
  normal: Point3,
  corners: readonly Point3[],
  resolution: number,
) {
  const origin = sceneValue(corners[0]),
    du = subtract(sceneValue(corners[1]), origin),
    dv = subtract(sceneValue(corners[3]), origin);
  const crossValue = cross(du, dv),
    area = Math.hypot(...crossValue);
  const faceNormal = crossValue.map((v) => v / area) as unknown as Point3;
  let total = 0;
  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      const u = (x + 0.5) / resolution,
        v = (y + 0.5) / resolution;
      const delta: Point3 = [
        origin[0] + du[0] * u + dv[0] * v - point[0],
        origin[1] + du[1] * u + dv[1] * v - point[1],
        origin[2] + du[2] * u + dv[2] * v - point[2],
      ];
      const distance2 = dot(delta, delta);
      total +=
        (Math.max(dot(normal, delta), 0) * Math.abs(dot(faceNormal, delta)) * area) /
        (resolution * resolution * Math.PI * distance2 * distance2);
    }
  return total;
}
