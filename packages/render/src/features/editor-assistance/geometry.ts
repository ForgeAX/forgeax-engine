import type {
  EditorAssistanceColor,
  EditorAssistanceDepth,
  EditorAssistancePrimitive,
  EditorAssistanceVector,
} from './state';

/** The same 12 edges serve bounds, camera frusta and collision boxes. */
export const BOX_EDGES = Object.freeze([
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const);
export function transformHelperPoint(
  matrix: ArrayLike<number>,
  point: EditorAssistanceVector,
): EditorAssistanceVector {
  const [x, y, z] = point;
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0),
  ];
}
export function helperBoxCorners(
  bounds: ArrayLike<number>,
  transform?: ArrayLike<number>,
): readonly EditorAssistanceVector[] {
  return Array.from({ length: 8 }, (_, index): EditorAssistanceVector => {
    const point: EditorAssistanceVector = [
      bounds[index & 1 ? 3 : 0] ?? 0,
      bounds[index & 2 ? 4 : 1] ?? 0,
      bounds[index & 4 ? 5 : 2] ?? 0,
    ];
    return transform === undefined ? point : transformHelperPoint(transform, point);
  });
}
export function helperBoxLines(
  corners: readonly EditorAssistanceVector[],
  color: EditorAssistanceColor,
  depth: EditorAssistanceDepth,
): EditorAssistancePrimitive[] {
  return BOX_EDGES.map(([a, b]) => ({
    kind: 'line',
    start: corners[a] as EditorAssistanceVector,
    end: corners[b] as EditorAssistanceVector,
    color,
    depth,
  }));
}
export function helperSphereLines(
  center: EditorAssistanceVector,
  radius: number,
  color: EditorAssistanceColor,
  depth: EditorAssistanceDepth,
  segments = 24,
): EditorAssistancePrimitive[] {
  if (!Number.isFinite(radius) || radius <= 0) return [];
  const rows: EditorAssistancePrimitive[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const point = (angle: number): EditorAssistanceVector => {
      const p = [...center];
      p[(axis + 1) % 3] = (p[(axis + 1) % 3] ?? 0) + Math.cos(angle) * radius;
      p[(axis + 2) % 3] = (p[(axis + 2) % 3] ?? 0) + Math.sin(angle) * radius;
      return p as unknown as EditorAssistanceVector;
    };
    for (let segment = 0; segment < segments; segment++)
      rows.push({
        kind: 'line',
        start: point((segment * 2 * Math.PI) / segments),
        end: point(((segment + 1) * 2 * Math.PI) / segments),
        color,
        depth,
      });
  }
  return rows;
}

/** An infinite light has a direction diagram, never an invented finite range. */
export function helperDirectionLines(
  origin: EditorAssistanceVector,
  direction: ArrayLike<number>,
  length: number,
  angle: number | undefined,
  color: EditorAssistanceColor,
  depth: EditorAssistanceDepth,
): EditorAssistancePrimitive[] {
  const magnitude = Math.hypot(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0);
  if (!(magnitude > 0) || !Number.isFinite(magnitude) || !Number.isFinite(length) || length <= 0)
    return [];
  const n = [0, 1, 2].map((i) => (direction[i] ?? 0) / magnitude);
  const seed = Math.abs(n[1] ?? 0) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a: readonly number[], b: readonly number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const u = cross(n, seed),
    norm = Math.hypot(...u);
  for (let i = 0; i < 3; i++) u[i] = (u[i] ?? 0) / norm;
  const v = cross(n, u);
  const at = (distance: number, radius: number, theta: number) =>
    [0, 1, 2].map(
      (i) =>
        (origin[i] ?? 0) +
        (n[i] ?? 0) * distance +
        radius * ((u[i] ?? 0) * Math.cos(theta) + (v[i] ?? 0) * Math.sin(theta)),
    ) as unknown as EditorAssistanceVector;
  const rows: EditorAssistancePrimitive[] = [];
  const line = (start: EditorAssistanceVector, end: EditorAssistanceVector) =>
    rows.push({ kind: 'line', start, end, color, depth });
  const tip = at(length, 0, 0);
  line(origin, tip);
  if (angle === undefined) {
    for (let i = 0; i < 4; i++) line(tip, at(length * 0.75, length * 0.12, (i * Math.PI) / 2));
  } else if (Number.isFinite(angle) && angle > 0 && angle < Math.PI / 2) {
    const radius = Math.tan(angle) * length;
    for (let i = 0; i < 24; i++)
      line(at(length, radius, (i * Math.PI) / 12), at(length, radius, ((i + 1) * Math.PI) / 12));
    for (let i = 0; i < 4; i++) line(origin, at(length, radius, (i * Math.PI) / 2));
  }
  return rows;
}
