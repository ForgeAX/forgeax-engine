import {
  createMeshBuilder,
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { type ModelingError, modelingError } from './errors';
import { faceArea, faceCentroid, faceNormal, type Tuple3, triangulateLoop } from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, NONE } from './mesh';

/** Closed set of overlay projections derived from an editable mesh. */
export type OverlayKind = 'tags' | 'roles' | 'elementIds' | 'sharp' | 'seams' | 'normals' | 'edges';

export const OVERLAY_KINDS: readonly OverlayKind[] = [
  'tags',
  'roles',
  'elementIds',
  'sharp',
  'seams',
  'normals',
  'edges',
];

export interface OverlayLegendEntry {
  readonly label: string;
  readonly color: readonly [number, number, number, number];
  readonly faces: number;
}

export interface Overlay {
  readonly kind: OverlayKind;
  /** Vertex-colored triangles (face overlays) or a line-list (edge and normal overlays). */
  readonly mesh: MeshAsset;
  readonly legend: readonly OverlayLegendEntry[];
}

const PALETTE: readonly (readonly [number, number, number])[] = [
  [0.9, 0.33, 0.25],
  [0.25, 0.62, 0.95],
  [0.36, 0.8, 0.38],
  [0.95, 0.75, 0.2],
  [0.7, 0.42, 0.9],
  [0.2, 0.82, 0.8],
  [0.95, 0.5, 0.75],
  [0.6, 0.6, 0.6],
];
const UNKEYED: readonly [number, number, number, number] = [0.18, 0.18, 0.2, 1];

function paletteColor(index: number): [number, number, number, number] {
  const base = PALETTE[index % PALETTE.length] as readonly [number, number, number];
  const shade =
    1 - (0.35 * Math.floor(index / PALETTE.length)) / (1 + Math.floor(index / PALETTE.length));
  return [base[0] * shade, base[1] * shade, base[2] * shade, 1];
}

/**
 * A vertex-colored overlay mesh in the Engine's canonical vertex layout: every attribute
 * of Geometry's default map that the overlay lacks (normal, uv, tangent) is zero-filled
 * from that map's projection, so overlays draw through the ordinary unlit pipeline.
 */
export function overlayMesh(
  attributes: VertexAttributeMap,
  topology: 'triangle-list' | 'line-list',
  options: { readonly indices?: readonly number[]; readonly slot?: string } = {},
): Result<MeshAsset, ModelingError> {
  const position = attributes.position;
  const count = position instanceof Float32Array ? position.length / 3 : 0;
  const filled: Record<string, VertexAttributeMap[keyof VertexAttributeMap]> = { ...attributes };
  const projection = deriveVertexLayoutProjection({
    ...DEFAULT_VERTEX_ATTRIBUTE_MAP,
    ...attributes,
  });
  for (const a of projection.attributes)
    if (filled[a.key] === undefined) filled[a.key] = new Float32Array((count * a.byteLength) / 4);
  const indices = options.indices;
  const built = createMeshBuilder({
    attributes: filled as VertexAttributeMap,
    ...(indices === undefined
      ? {}
      : { indices: count <= 0xffff ? new Uint16Array(indices) : new Uint32Array(indices) }),
    submeshes: [{ topology, materialSlot: 0 }],
    materialSlots: [{ slotName: options.slot ?? 'Overlay' }],
  }).build();
  if (!built.ok) {
    return err(
      modelingError('model-degenerate', 'the overlay buffers form a valid MeshAsset', {
        cause: built.error.code,
      }),
    );
  }
  return ok(built.value);
}

function build(
  attributes: VertexAttributeMap,
  indices: number[] | undefined,
  topology: 'triangle-list' | 'line-list',
): Result<MeshAsset, ModelingError> {
  return overlayMesh(attributes, topology, indices === undefined ? {} : { indices });
}

/** Overlay offset: a thousandth of the bounding diagonal. */
function faceLift(mesh: EditMesh): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  const diagonal = Math.sqrt(
    [0, 1, 2].reduce((sum, k) => {
      const d = (max[k] as number) - (min[k] as number);
      return sum + d * d;
    }, 0),
  );
  return Number.isFinite(diagonal) ? diagonal * 1e-3 : 0;
}

/** One key per face; faces sharing a key share a legend color. */
function faceKeys(mesh: EditMesh, kind: 'tags' | 'roles' | 'elementIds'): Map<number, string> {
  const keys = new Map<number, string>();
  for (const f of mesh.faces()) {
    if (kind === 'elementIds') keys.set(f, `face ${f}`);
    else if (kind === 'roles') {
      const label = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
      const role = mesh.roleNames[mesh.fRole[f] as number] ?? '';
      keys.set(f, label === '' ? '' : `${label}.${role}`);
    } else {
      const names = mesh.tagNames.filter((_, t) => mesh.hasTag(f, t));
      keys.set(f, names.join('+'));
    }
  }
  return keys;
}

function faceOverlay(
  mesh: EditMesh,
  kind: 'tags' | 'roles' | 'elementIds',
): Result<Overlay, ModelingError> {
  const keys = faceKeys(mesh, kind);
  const order = [...new Set([...keys.values()].filter((k) => k !== ''))].sort();
  const colorOf = new Map(order.map((key, i) => [key, paletteColor(i)] as const));
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const counts = new Map<string, number>();
  // Lift each face slightly along its normal so the overlay draws over the subject
  // instead of depth-fighting the coplanar surface it labels.
  const lift = faceLift(mesh);
  for (const f of mesh.faces()) {
    const key = keys.get(f) ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const rgba = colorOf.get(key) ?? UNKEYED;
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const local = triangulateLoop(points);
    if (local === undefined) continue;
    const n = faceNormal(mesh, f);
    for (const corner of local) {
      const p = points[corner] as Tuple3;
      position.push(p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift);
      pushAll(normal, n);
      pushAll(color, rgba);
    }
  }
  const built = build(
    {
      position: new Float32Array(position),
      normal: new Float32Array(normal),
      color: new Float32Array(color),
    },
    undefined,
    'triangle-list',
  );
  if (!built.ok) return built;
  const legend: OverlayLegendEntry[] = order.map((label) => ({
    label,
    color: colorOf.get(label) as [number, number, number, number],
    faces: counts.get(label) ?? 0,
  }));
  if (counts.has('')) legend.push({ label: '(none)', color: UNKEYED, faces: counts.get('') ?? 0 });
  return ok({ kind, mesh: built.value, legend });
}

function lineOverlay(
  kind: OverlayKind,
  segments: number[],
  rgba: readonly number[],
  legendLabel: string,
): Result<Overlay, ModelingError> {
  if (segments.length === 0) {
    return err(
      modelingError('model-selection-empty', `the mesh has ${legendLabel} to draw`, {
        overlay: kind,
      }),
    );
  }
  const count = segments.length / 3;
  const color: number[] = [];
  for (let i = 0; i < count; i++) pushAll(color, rgba);
  const built = build(
    { position: new Float32Array(segments), color: new Float32Array(color) },
    undefined,
    'line-list',
  );
  if (!built.ok) return built;
  return ok({
    kind,
    mesh: built.value,
    legend: [
      { label: legendLabel, color: rgba as [number, number, number, number], faces: count / 2 },
    ],
  });
}

/**
 * Project author facts that a MeshAsset cannot carry (tags, roles, element ids,
 * edge intent, face normals) into ordinary vertex-colored or line-list meshes a
 * preview can draw over the exported mesh.
 */
export function projectOverlay(
  mesh: EditMesh,
  kind: OverlayKind,
  /** `edges` only: keep edges with an end inside [minX, minY, minZ, maxX, maxY, maxZ] (close-ups). */
  bounds?: readonly number[],
): Result<Overlay, ModelingError> {
  switch (kind) {
    case 'tags':
    case 'roles':
    case 'elementIds':
      return faceOverlay(mesh, kind);
    case 'sharp':
    case 'seams': {
      const flag = kind === 'sharp' ? EDGE_SHARP : EDGE_SEAM;
      const segments: number[] = [];
      for (const e of mesh.edges()) {
        if (((mesh.eFlags[e] as number) & flag) === 0) continue;
        const [a, b] = mesh.edgeVertices(e);
        segments.push(...mesh.position(a), ...mesh.position(b));
      }
      return lineOverlay(
        kind,
        segments,
        kind === 'sharp' ? [1, 0.55, 0.1, 1] : [0.2, 0.9, 1, 1],
        `${kind} edges`,
      );
    }
    case 'normals': {
      const segments: number[] = [];
      for (const f of mesh.faces()) {
        const c = faceCentroid(mesh, f);
        const n = faceNormal(mesh, f);
        const length = Math.max(1e-3, Math.sqrt(faceArea(mesh, f)) * 0.35);
        segments.push(...c, c[0] + n[0] * length, c[1] + n[1] * length, c[2] + n[2] * length);
      }
      return lineOverlay(kind, segments, [0.4, 1, 0.4, 1], 'face normals');
    }
    case 'edges': {
      // V-wire: every n-gon edge (the edge flow, not the export triangulation), lifted
      // along its faces' normals so the shaded surface does not hide it.
      const lift = faceLift(mesh);
      const inside = (p: Tuple3) =>
        bounds === undefined ||
        [0, 1, 2].every(
          (k) =>
            (p[k] as number) >= (bounds[k] as number) &&
            (p[k] as number) <= (bounds[k + 3] as number),
        );
      const segments: number[] = [];
      for (const e of mesh.edges()) {
        const [a, b] = mesh.edgeVertices(e);
        const pa = mesh.position(a);
        const pb = mesh.position(b);
        if (!inside(pa) && !inside(pb)) continue;
        const n: Tuple3 = [0, 0, 0];
        for (const h of [2 * e, 2 * e + 1]) {
          const f = mesh.hFace[h] as number;
          if (f === NONE) continue;
          const fn = faceNormal(mesh, f);
          for (let k = 0; k < 3; k++) n[k] = (n[k] as number) + (fn[k] as number);
        }
        const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
        const o = (p: Tuple3) => [
          p[0] + (n[0] / l) * lift,
          p[1] + (n[1] / l) * lift,
          p[2] + (n[2] / l) * lift,
        ];
        segments.push(...o(pa), ...o(pb));
      }
      return lineOverlay(kind, segments, [0.03, 0.05, 0.12, 1], 'edges');
    }
  }
}
