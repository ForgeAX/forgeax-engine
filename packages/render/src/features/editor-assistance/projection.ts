import type { MeshAsset } from '@forgeax/engine-types';
import type { RenderFeaturePlanContext, RenderFeaturePlanView } from '../plan';
import { transformHelperPoint } from './geometry';
import { type EditorAssistanceSourceFrame, resolveEditorAssistanceMesh } from './source';
import type {
  CapturedEditorAssistancePrimitive,
  EditorAssistanceAction,
  EditorAssistanceColor,
  EditorAssistanceDepth,
  EditorAssistanceVector,
} from './state';

export interface EditorAssistanceHit {
  readonly action: EditorAssistanceAction;
  readonly depth: EditorAssistanceDepth;
  readonly triangle: readonly [number, number, number, number, number, number];
}
export interface EditorAssistanceViewGeometry {
  readonly identity: string;
  readonly width: number;
  readonly height: number;
  readonly always: Float32Array;
  readonly occluded: Float32Array;
  readonly hits: readonly EditorAssistanceHit[];
  readonly truncated: boolean;
}
type Clip = readonly [number, number, number, number, ...number[]];
const MAX_VERTICES = 196608;
const CLIP_PLANES = [
  (p: Clip) => p[3] + p[0],
  (p: Clip) => p[3] - p[0],
  (p: Clip) => p[3] + p[1],
  (p: Clip) => p[3] - p[1],
  (p: Clip) => p[2],
  (p: Clip) => p[3] - p[2],
] as const;
function clipPoint(matrix: ArrayLike<number>, p: EditorAssistanceVector): Clip {
  return [0, 1, 2, 3].map(
    (row) =>
      (matrix[row] ?? 0) * p[0] +
      (matrix[4 + row] ?? 0) * p[1] +
      (matrix[8 + row] ?? 0) * p[2] +
      (matrix[12 + row] ?? 0),
  ) as unknown as Clip;
}
function interpolate(a: Clip, b: Clip, t: number): Clip {
  return a.map((value, i) => value + ((b[i] ?? 0) - value) * t) as unknown as Clip;
}
function clipPolygon(input: readonly Clip[]): readonly Clip[] {
  let polygon = input;
  for (const plane of CLIP_PLANES) {
    if (polygon.length === 0) return polygon;
    const next: Clip[] = [];
    let a = polygon[polygon.length - 1] as Clip,
      da = plane(a);
    for (const b of polygon) {
      const db = plane(b);
      if (da < 0 !== db < 0) next.push(interpolate(a, b, da / (da - db)));
      if (db >= 0) next.push(b);
      a = b;
      da = db;
    }
    polygon = next;
  }
  return polygon;
}
function clipLine(a: Clip, b: Clip): readonly [Clip, Clip] | undefined {
  for (const plane of CLIP_PLANES) {
    const da = plane(a),
      db = plane(b);
    if (da < 0 && db < 0) return undefined;
    if (da < 0) a = interpolate(a, b, da / (da - db));
    else if (db < 0) b = interpolate(a, b, da / (da - db));
  }
  return a[3] > 0 && b[3] > 0 ? [a, b] : undefined;
}

/** Projection is detached from World, asset edits and subsequent view preparation. */
export function projectEditorAssistance(
  frame: EditorAssistanceSourceFrame,
  view: RenderFeaturePlanView,
  context: Pick<RenderFeaturePlanContext, 'resolveAsset'>,
): EditorAssistanceViewGeometry | undefined {
  const width = view.frame.width,
    height = view.frame.height,
    matrix = view.selectedView?.viewProjection;
  if (
    !view.render ||
    matrix === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  const always: number[] = [],
    occluded: number[] = [],
    gizmoAlways: number[] = [],
    gizmoOccluded: number[] = [],
    hits: EditorAssistanceHit[] = [];
  let vertices = 0,
    truncated = false;
  const screen = (p: Clip) =>
    [((p[0] / p[3] + 1) * width) / 2, ((1 - p[1] / p[3]) * height) / 2] as const;
  const triangle = (
    a: Clip,
    b: Clip,
    c: Clip,
    color: EditorAssistanceColor,
    depth: EditorAssistanceDepth,
    action?: EditorAssistanceAction,
    colors?: readonly EditorAssistanceColor[],
  ) => {
    if (vertices + 3 > MAX_VERTICES) {
      truncated = true;
      return;
    }
    const polygon = clipPolygon(
      [a, b, c].map(
        (point, index) => [...point.slice(0, 4), ...(colors?.[index] ?? color)] as unknown as Clip,
      ),
    );
    for (let i = 1; i + 1 < polygon.length; i++) {
      if (vertices + 3 > MAX_VERTICES) {
        truncated = true;
        break;
      }
      const points = [polygon[0], polygon[i], polygon[i + 1]] as readonly Clip[];
      if (points.some((point) => point[3] <= 0 || !point.every(Number.isFinite))) continue;
      const data =
        action?.kind === 'gizmo'
          ? depth === 'always'
            ? gizmoAlways
            : gizmoOccluded
          : depth === 'always'
            ? always
            : occluded;
      for (const point of points) data.push(...point);
      vertices += 3;
      if (action !== undefined) {
        const [p, q, r] = points.map(screen) as readonly (readonly [number, number])[];
        if (p !== undefined && q !== undefined && r !== undefined)
          hits.push(
            Object.freeze({
              action,
              depth,
              triangle: Object.freeze([...p, ...q, ...r]) as EditorAssistanceHit['triangle'],
            }),
          );
      }
    }
  };
  const line = (
    start: Clip,
    end: Clip,
    color: EditorAssistanceColor,
    depth: EditorAssistanceDepth,
    action?: EditorAssistanceAction,
  ) => {
    const clipped = clipLine(start, end);
    if (clipped === undefined) return;
    const [a, b] = clipped,
      [ax, ay] = screen(a),
      [bx, by] = screen(b);
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-5) return;
    const dx = ((-(by - ay) / length) * 1.5) / width,
      dy = ((-(bx - ax) / length) * 1.5) / height;
    const offset = (p: Clip, sign: number): Clip => [
      p[0] + sign * dx * p[3],
      p[1] + sign * dy * p[3],
      p[2],
      p[3],
    ];
    triangle(offset(a, -1), offset(a, 1), offset(b, 1), color, depth, action);
    triangle(offset(a, -1), offset(b, 1), offset(b, -1), color, depth, action);
  };
  const appendIcon = (primitive: Extract<CapturedEditorAssistancePrimitive, { kind: 'icon' }>) => {
    const center = clipPoint(matrix, primitive.position);
    if (center[3] <= 0 || center[2] < 0 || center[2] > center[3]) return;
    const pixel = (x: number, y: number): Clip => [
      center[0] + ((x * primitive.pixels) / width) * center[3],
      center[1] + ((y * primitive.pixels) / height) * center[3],
      center[2],
      center[3],
    ];
    const points =
      primitive.icon === 'camera'
        ? [
            [-0.65, -0.45],
            [0.2, -0.45],
            [0.2, 0.45],
            [-0.65, 0.45],
            [-0.65, -0.45],
            [0.2, -0.45],
            [0.75, -0.7],
            [0.75, 0.7],
            [0.2, 0.45],
          ]
        : Array.from({ length: 13 }, (_, index) => [
            Math.cos((index * Math.PI) / 6) * 0.55,
            Math.sin((index * Math.PI) / 6) * 0.55,
          ]);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as number[],
        b = points[i] as number[];
      line(
        pixel(a[0] ?? 0, a[1] ?? 0),
        pixel(b[0] ?? 0, b[1] ?? 0),
        primitive.color,
        primitive.depth,
        primitive.action,
      );
    }
  };
  const appendMesh = (primitive: Extract<CapturedEditorAssistancePrimitive, { kind: 'mesh' }>) => {
    const reference = frame.meshes.find(
      (mesh) =>
        mesh.handle === Number(primitive.mesh) &&
        (primitive.meshRevision === undefined || mesh.revision === primitive.meshRevision),
    );
    const mesh: MeshAsset | undefined =
      reference === undefined ? undefined : resolveEditorAssistanceMesh(reference, context);
    if (mesh === undefined) return;
    const rawPosition = mesh.attributes.position;
    const positions =
      rawPosition instanceof ArrayBuffer ? new Float32Array(rawPosition) : rawPosition;
    if (!(positions instanceof Float32Array)) return;
    const vertex = (index: number): Clip =>
      clipPoint(
        matrix,
        transformHelperPoint(primitive.transform, [
          positions[index * 3] ?? 0,
          positions[index * 3 + 1] ?? 0,
          positions[index * 3 + 2] ?? 0,
        ]),
      );
    for (const section of mesh.submeshes) {
      if (section.topology !== 'triangle-list' && section.topology !== 'line-list') continue;
      const count = mesh.indices === undefined ? section.vertexCount : section.indexCount;
      const offset = mesh.indices === undefined ? 0 : section.indexOffset;
      const step = section.topology === 'line-list' ? 2 : 3;
      for (let i = 0; i + step - 1 < count; i += step) {
        const index = (n: number) => mesh.indices?.[offset + i + n] ?? offset + i + n;
        const colors = mesh.attributes.color;
        const color: EditorAssistanceColor =
          colors instanceof Float32Array
            ? ([0, 1, 2, 3].map(
                (channel) =>
                  (colors[index(0) * 4 + channel] ?? 1) * (primitive.color[channel] ?? 1),
              ) as unknown as EditorAssistanceColor)
            : primitive.color;
        if (step === 2)
          line(vertex(index(0)), vertex(index(1)), color, primitive.depth, primitive.action);
        else
          triangle(
            vertex(index(0)),
            vertex(index(1)),
            vertex(index(2)),
            color,
            primitive.depth,
            primitive.action,
            colors instanceof Float32Array
              ? [0, 1, 2].map(
                  (n) =>
                    [0, 1, 2, 3].map(
                      (channel) =>
                        (colors[index(n) * 4 + channel] ?? 1) * (primitive.color[channel] ?? 1),
                    ) as unknown as EditorAssistanceColor,
                )
              : undefined,
          );
        if (vertices >= MAX_VERTICES) {
          truncated = true;
          break;
        }
      }
    }
  };
  for (const primitive of frame.primitives) {
    if (vertices >= MAX_VERTICES) {
      truncated = true;
      break;
    }
    if (primitive.kind === 'line') {
      line(
        clipPoint(matrix, primitive.start),
        clipPoint(matrix, primitive.end),
        primitive.color,
        primitive.depth,
        primitive.action,
      );
    } else if (primitive.kind === 'icon') {
      appendIcon(primitive);
    } else {
      appendMesh(primitive);
    }
  }
  return Object.freeze({
    identity: view.identity,
    width,
    height,
    always: Float32Array.from([...always, ...gizmoAlways]),
    occluded: Float32Array.from([...occluded, ...gizmoOccluded]),
    hits: Object.freeze(hits),
    truncated,
  });
}
