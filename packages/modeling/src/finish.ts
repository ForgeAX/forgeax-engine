import {
  computeTangentVec4,
  createMeshBuilder,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { TriangleBvh } from './compute/bvh';
import { flagSharpness } from './crease';
import { atan2, cos } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { type ExportTopology, weldedTopology } from './export-topology';
import { decodeSnapshot } from './fxem';
import {
  add,
  cross,
  dot,
  faceArea,
  faceNormal,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { type CornerChannelName, type EditMesh, NONE } from './mesh';
import { type NurbsSurface, surfaceDerivatives, surfaceDomain } from './nurbs';
import type { OpDiagnostic } from './ops';

/**
 * Export normal mode. `weighted` weighs each face by corner angle x area (mid-poly hard
 * surface); with `bevelBorrow` (degrees) faces smaller than a fifth of the largest face of
 * their normal group drop out of it wherever such a large face lies within that angle, so
 * large faces stay exactly flat and bevels interpolate between their neighbours' normals;
 * `faceWeight` multiplies the weight of faces carrying a tag. `transfer` takes each
 * render vertex's normal from the nearest point of a source mesh (FXEM snapshot) that
 * faces the same side, exported with `sourceNormals` (default smooth);
 * vertices split only at sharp edges.
 */
export type NormalMode =
  | { readonly mode: 'smooth' }
  | { readonly mode: 'flat' }
  | {
      readonly mode: 'weighted';
      readonly bevelBorrow?: number;
      readonly faceWeight?: Readonly<Record<string, number>>;
    }
  | { readonly mode: 'autoSmooth'; readonly angle: number }
  /**
   * Exact patch normals: a corner of an `m.surface` face (its patch-name tag and `uv1`)
   * within `SURFACE_TOLERANCE` of its patch takes the patch normal; corners sharing a vertex
   * across a smooth edge take their mean when every corner's patch normal agrees within 1
   * degree; any other corner takes the default `weighted` normal.
   */
  | { readonly mode: 'surface' }
  | {
      readonly mode: 'transfer';
      readonly from: Uint8Array;
      readonly sourceNormals?: Exclude<NormalMode, { readonly mode: 'transfer' }>;
    };

/** A face smaller than this fraction of its normal group's largest face borrows (bevelBorrow). */
const BEVEL_AREA_RATIO = 0.2;

/** Channels exported to runtime slots: corner channel name -> MeshAsset attribute key. */
const EXPORT_SLOTS: readonly (readonly [CornerChannelName, keyof VertexAttributeMap])[] = [
  ['uv0', 'uv'],
  ['uv1', 'uv1'],
  ['uv2', 'uv2'],
  ['uv3', 'uv3'],
  ['uv4', 'uv4'],
  ['uv5', 'uv5'],
  ['uv6', 'uv6'],
  ['uv7', 'uv7'],
  ['color', 'color'],
];

/** A triangle within this many f32 steps of collapsing is a sliver, not a defect. */
const F32_SLIVER_STEPS = 4;
/** Spacing of f32 values relative to their magnitude (2^-23). */
const F32_EPSILON = 1.1920928955078125e-7;

export interface ExportOptions {
  readonly normals?: NormalMode;
  /** Report `topology` of the source mesh welded at distance 0 (default off). */
  readonly checkTopology?: boolean;
  /**
   * The session's recorded patches, for `{ mode: 'surface' }`.
   * @internal
   */
  readonly surfaces?: readonly { readonly name: string; readonly surface: NurbsSurface }[];
}

/** Largest distance between a vertex and its patch point for an exact surface normal (m). */
const SURFACE_TOLERANCE = 2e-5;

export interface ExportReport {
  readonly faces: number;
  readonly triangles: number;
  /** Vertices after splitting by normal group and corner values (the GPU count). */
  readonly gpuVertices: number;
  readonly materialSlots: readonly string[];
  readonly aabb: readonly [number, number, number, number, number, number];
  /** Triangles dropped because they are thinner than the f32 grid at their coordinates. */
  readonly slivers: number;
  /** With `checkTopology`: free and non-manifold edges and components of the source faces. */
  readonly topology?: ExportTopology;
  /** With `{ mode: 'surface' }`: render vertices with an exact patch normal, and all of them. */
  readonly exactNormals?: readonly [number, number];
  /**
   * With `{ mode: 'surface' }`: an `info` when the session records patches but no render
   * vertex lies on them (the recorded patches stay where `m.surface` built them, so a later
   * translate or rotate leaves every vertex off its patch and all normals weighted; `mirror`
   * records the reflected patches).
   */
  readonly diagnostics?: readonly OpDiagnostic[];
}

/** One clip a rig export wrote. */
export interface ClipReport {
  readonly name: string;
  /** Source key: `animation-clip/<key>/<name>`. */
  readonly key: string;
  readonly loop: boolean;
  readonly duration: number;
  /** Samples per channel. */
  readonly frames: number;
}

export interface ExportResult {
  readonly mesh: MeshAsset;
  readonly report: ExportReport;
  /** Render vertex -> source corner (compacted half-edge id). */
  readonly vertexCorner: Int32Array;
  /** Render triangle -> source face (compacted face id). */
  readonly triangleFace: Int32Array;
}

export class UnionFind {
  readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let root = i;
    while ((this.parent[root] as number) !== root) root = this.parent[root] as number;
    let node = i;
    while ((this.parent[node] as number) !== root) {
      const next = this.parent[node] as number;
      this.parent[node] = root;
      node = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/**
 * Whether export normals are shared across edge `e` under `normals` (no infinite crease, both
 * faces present, within the autoSmooth angle). The one hard-edge definition, shared with
 * the bake checks.
 * @internal
 */
export function smoothAcross(mesh: EditMesh, e: number, normals: NormalMode): boolean {
  const a = mesh.hFace[e * 2] as number;
  const b = mesh.hFace[e * 2 + 1] as number;
  if (a === NONE || b === NONE || normals.mode === 'flat') return false;
  if (flagSharpness(mesh.eFlags[e] as number) === Infinity) return false;
  if (normals.mode !== 'autoSmooth') return true;
  const cosine = dot(faceNormal(mesh, a), faceNormal(mesh, b));
  return cosine >= cos((normals.angle * Math.PI) / 180) - 1e-12;
}

function cornerAngle(mesh: EditMesh, h: number): number {
  const p = mesh.position(mesh.hVert[h] as number);
  const next = mesh.position(mesh.hVert[mesh.hNext[h] as number] as number);
  const prev = mesh.position(mesh.hVert[mesh.hPrev[h] as number] as number);
  const u = normalize(sub(next, p));
  const v = normalize(sub(prev, p));
  return atan2(length(cross(u, v)), dot(u, v));
}

/**
 * The transfer field: nearest point of the source's exported surface that faces the same
 * side as the reference normal (any point when none does), its interpolated normal.
 */
function transferSource(
  normals: Extract<NormalMode, { readonly mode: 'transfer' }>,
): Result<(p: Tuple3, reference: Tuple3) => Tuple3, ModelingError> {
  const decoded = decodeSnapshot(normals.from);
  if (!decoded.ok) return decoded;
  const sourceNormals = normals.sourceNormals ?? { mode: 'smooth' };
  if ((sourceNormals as NormalMode).mode === 'transfer') {
    return err(
      modelingError('model-invalid-argument', 'transfer.sourceNormals is not a transfer', {}),
    );
  }
  const source = exportMesh(decoded.value, { normals: sourceNormals });
  if (!source.ok) return source;
  const attributes = unpackInterleavedVertexAttributes(
    source.value.mesh.vertices,
    deriveVertexLayoutProjection(source.value.mesh.attributes),
  ) as Record<string, Float32Array> | undefined;
  const indices = source.value.mesh.indices;
  const position = attributes?.position;
  const normal = attributes?.normal;
  if (position === undefined || normal === undefined || indices === undefined) {
    return err(
      modelingError('model-degenerate', 'the transfer source exports positions and normals', {}),
    );
  }
  const bvh = new TriangleBvh(position, indices);
  const triangles = indices.length / 3;
  const faceN = new Float64Array(triangles * 3);
  const corner = (t: number, k: number): Tuple3 => {
    const i = indices[t * 3 + k] as number;
    return [
      position[i * 3] as number,
      position[i * 3 + 1] as number,
      position[i * 3 + 2] as number,
    ];
  };
  for (let t = 0; t < triangles; t++) {
    const a = corner(t, 0);
    faceN.set(normalize(cross(sub(corner(t, 1), a), sub(corner(t, 2), a))), t * 3);
  }
  return ok((p, reference) => {
    const near = (bvh.nearest(
      p,
      (t) =>
        (faceN[t * 3] as number) * reference[0] +
          (faceN[t * 3 + 1] as number) * reference[1] +
          (faceN[t * 3 + 2] as number) * reference[2] >
        0,
    ) ?? bvh.nearest(p)) as NonNullable<ReturnType<TriangleBvh['nearest']>>;
    const w = [1 - near.u - near.v, near.u, near.v];
    const out: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = indices[near.triangle * 3 + k] as number;
      for (let c = 0; c < 3; c++)
        out[c] = (out[c] as number) + (w[k] as number) * (normal[i * 3 + c] as number);
    }
    return normalize(out);
  });
}

/**
 * Export a compacted mesh to an immutable MeshAsset. Normals derive from sharp
 * edges and the normal mode; render vertices split exactly on the integer tuple
 * (vertex, normal group, corner value bits), never on a distance threshold.
 */
export function exportMesh(
  mesh: EditMesh,
  options: ExportOptions = {},
): Result<ExportResult, ModelingError> {
  const normals = options.normals ?? { mode: 'smooth' };
  if (normals.mode === 'autoSmooth' && !(normals.angle >= 0 && normals.angle <= 180)) {
    return err(
      modelingError('model-invalid-argument', 'autoSmooth angle is within [0, 180]', {
        angle: normals.angle,
      }),
    );
  }
  if (normals.mode === 'weighted') {
    const borrow = normals.bevelBorrow;
    if (borrow !== undefined && !(borrow >= 0 && borrow <= 180)) {
      return err(
        modelingError('model-invalid-argument', 'weighted bevelBorrow is within [0, 180] degrees', {
          bevelBorrow: borrow,
        }),
      );
    }
    for (const [tag, weight] of Object.entries(normals.faceWeight ?? {})) {
      if (!(weight >= 0 && Number.isFinite(weight))) {
        return err(
          modelingError('model-invalid-argument', 'faceWeight values are finite and non-negative', {
            tag,
            weight,
          }),
        );
      }
    }
  }
  let transfer: ((p: Tuple3, reference: Tuple3) => Tuple3) | undefined;
  if (normals.mode === 'transfer') {
    const source = transferSource(normals);
    if (!source.ok) return source;
    transfer = source.value;
  }
  const faces = mesh.faces();
  if (faces.length === 0) {
    return err(modelingError('model-precondition', 'the mesh has at least one face to export', {}));
  }
  const exported = EXPORT_SLOTS.filter(([name]) => mesh.channels.has(name));
  for (const [name] of exported) {
    const missing = faces.filter((f) =>
      mesh.faceHalves(f).some((h) => mesh.corner(name, h) === undefined),
    );
    if (missing.length > 0) {
      return err(
        modelingError(
          'model-precondition',
          `every face has ${name} values before export`,
          { channel: name, missingFaces: missing.length, firstFace: missing[0] },
          name === 'uv0'
            ? "topology edits leave new faces without UVs; call m.uv.project({ mode: 'box', scale }) after the last topology edit"
            : `write ${name} on every face or remove the channel`,
        ),
      );
    }
  }
  const uvChannel = exported.find(([name]) => name === 'uv0');
  if (uvChannel === undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the mesh has uv0 values (tangents and the standard pipeline need UVs)',
        {},
        "call m.uv.project({ mode: 'box', scale }) before finish",
      ),
    );
  }

  const groups = new UnionFind(mesh.halfHighWater);
  for (const e of mesh.edges()) {
    if (!smoothAcross(mesh, e, normals)) continue;
    const h = e * 2;
    const t = h + 1;
    groups.union(h, mesh.hNext[t] as number);
    groups.union(mesh.hNext[h] as number, t);
  }
  const faceNormals = new Map<number, Tuple3>();
  const faceAreas = new Map<number, number>();
  for (const f of faces) {
    faceNormals.set(f, faceNormal(mesh, f));
    faceAreas.set(f, faceArea(mesh, f));
  }
  const groupNormal = new Map<number, Tuple3>();
  const tagWeight =
    normals.mode === 'weighted' && normals.faceWeight !== undefined
      ? Object.entries(normals.faceWeight).map(
          ([tag, weight]) => [mesh.tagNames.indexOf(tag), weight] as const,
        )
      : [];
  const faceWeight = (f: number) => {
    let w = 1;
    for (const [tag, weight] of tagWeight) if (tag >= 0 && mesh.hasTag(f, tag)) w *= weight;
    return w;
  };
  const borrow =
    normals.mode === 'weighted' && normals.bevelBorrow !== undefined
      ? cos((normals.bevelBorrow * Math.PI) / 180)
      : undefined;
  // Per group: contributing faces with their weighted normal, area and unit normal.
  const members = new Map<number, { n: Tuple3; w: number; area: number }[]>();
  for (const f of faces) {
    const n = faceNormals.get(f) as Tuple3;
    const area = faceAreas.get(f) as number;
    for (const h of mesh.faceHalves(f)) {
      const root = groups.find(h);
      const weight =
        normals.mode === 'flat'
          ? 1
          : cornerAngle(mesh, h) *
            // 'surface' falls back to the default weighted normal: no tag weights, no borrowing.
            (normals.mode === 'weighted' || normals.mode === 'surface' ? area * faceWeight(f) : 1);
      if (borrow !== undefined) {
        const list = members.get(root) ?? [];
        list.push({ n, w: weight, area });
        members.set(root, list);
        continue;
      }
      const sum = groupNormal.get(root) ?? [0, 0, 0];
      groupNormal.set(root, [
        sum[0] + n[0] * weight,
        sum[1] + n[1] * weight,
        sum[2] + n[2] * weight,
      ]);
    }
  }
  if (borrow !== undefined) {
    for (const [root, list] of members) {
      const largest = maxOf(list.map((m) => m.area));
      const large = list.filter((m) => m.area >= BEVEL_AREA_RATIO * largest);
      const sum: Tuple3 = [0, 0, 0];
      for (const m of list) {
        // A small face next to a large face within the borrow angle takes that face's normal.
        if (m.area < BEVEL_AREA_RATIO * largest && large.some((l) => dot(l.n, m.n) >= borrow))
          continue;
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (m.n[c] as number) * m.w;
      }
      groupNormal.set(root, sum);
    }
  }

  const exactNormal =
    normals.mode === 'surface'
      ? surfaceNormals(mesh, faces, faceNormals, groups, options)
      : undefined;

  // Render vertices with the same source vertex form a chain; a corner joins the one
  // with its normal group and equal corner values (-0 equals 0, NaN equals NaN).
  const vertexCorner: number[] = [];
  const renderGroup: number[] = [];
  const sameVertexNext: number[] = [];
  const firstRender = new Int32Array(mesh.vertexHighWater).fill(NONE);
  const cornerChannels = exported.map(([name]) => mesh.channel(name));
  const sameValues = (a: number, b: number): boolean => {
    for (const { dim, values } of cornerChannels) {
      for (let i = 0; i < dim; i++) {
        const x = values[a * dim + i] as number;
        const y = values[b * dim + i] as number;
        if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
      }
    }
    return true;
  };
  // A tangent frame is per vertex, so a corner also joins only a vertex of its face's uv0
  // handedness: a welded mirror seam keeps one frame per side (MikkTSpace splits there too).
  // A face without uv area (sign 0) joins either side.
  const renderSign: number[] = [];
  const renderOf = (h: number, sign: number): number => {
    const v = mesh.hVert[h] as number;
    const group = groups.find(h);
    for (let r = firstRender[v] as number; r !== NONE; r = sameVertexNext[r] as number) {
      const other = renderSign[r] as number;
      if (sign !== 0 && other !== 0 && other !== sign) continue;
      if (renderGroup[r] === group && sameValues(vertexCorner[r] as number, h)) {
        if (other === 0) renderSign[r] = sign;
        return r;
      }
    }
    const index = vertexCorner.length;
    vertexCorner.push(h);
    renderGroup.push(group);
    renderSign.push(sign);
    sameVertexNext.push(firstRender[v] as number);
    firstRender[v] = index;
    return index;
  };
  const uvValues = mesh.channel('uv0').values;
  const uvHandedness = (halves: readonly number[]): number => {
    let area = 0;
    for (const [k, h] of halves.entries()) {
      const g = halves[(k + 1) % halves.length] as number;
      area +=
        (uvValues[h * 2] as number) * (uvValues[g * 2 + 1] as number) -
        (uvValues[g * 2] as number) * (uvValues[h * 2 + 1] as number);
    }
    return Math.sign(area);
  };

  const slotOrder = [...new Set(faces.map((f) => mesh.fMaterial[f] as number))].sort(
    (a, b) => a - b,
  );
  const indices: number[] = [];
  const triangleFace: number[] = [];
  const submeshes: { indexOffset: number; indexCount: number; materialSlot: number }[] = [];
  for (const [slotIndex, material] of slotOrder.entries()) {
    const start = indices.length;
    for (const f of faces) {
      if ((mesh.fMaterial[f] as number) !== material) continue;
      const halves = mesh.faceHalves(f);
      const local = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
      if (local === undefined) {
        return err(
          modelingError(
            'model-degenerate',
            'every face can be triangulated by ear clipping in its best-fit plane',
            { face: f },
            'the face overlaps itself in its best-fit plane; split or rebuild it',
          ),
        );
      }
      const sign = uvHandedness(halves);
      for (let i = 0; i < local.length; i += 3) {
        for (let j = 0; j < 3; j++)
          indices.push(renderOf(halves[local[i + j] as number] as number, sign));
        triangleFace.push(f);
      }
    }
    submeshes.push({
      indexOffset: start,
      indexCount: indices.length - start,
      materialSlot: slotIndex,
    });
  }

  const count = vertexCorner.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const channelData = new Map<CornerChannelName, Float32Array>();
  for (const [name] of exported)
    channelData.set(name, new Float32Array(count * (name === 'color' ? 4 : 2)));
  let exactCount = 0;
  for (let i = 0; i < count; i++) {
    const h = vertexCorner[i] as number;
    const p = mesh.position(mesh.hVert[h] as number);
    position.set(p, i * 3);
    const exact = exactNormal?.get(groups.find(h));
    if (exact !== undefined) exactCount++;
    const own = normalize(
      exact ??
        groupNormal.get(groups.find(h)) ??
        faceNormals.get(mesh.hFace[h] as number) ?? [0, 1, 0],
    );
    const n = transfer === undefined ? own : transfer(p, own);
    normal.set(n, i * 3);
    for (const [name] of exported) {
      const data = channelData.get(name) as Float32Array;
      const value = mesh.corner(name, h) as Float32Array;
      data.set(value, i * value.length);
    }
  }

  // A triangle thinner than the f32 grid at its own coordinates (a sliver of a valid face
  // far from the origin) can collapse or flip once positions are rounded. It covers less
  // than one representable step, so it is dropped and counted; any other inversion is a
  // real defect and fails.
  const slivers = new Set<number>();
  for (let t = 0; t < indices.length / 3; t++) {
    const corners = [0, 1, 2].map((k) => indices[t * 3 + k] as number);
    const tri = corners.map((i) => [
      position[i * 3] as number,
      position[i * 3 + 1] as number,
      position[i * 3 + 2] as number,
    ]) as [Tuple3, Tuple3, Tuple3];
    const n32 = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const face = triangleFace[t] as number;
    if (dot(n32, faceNormals.get(face) as Tuple3) > 0) continue;
    const exact = corners.map((i) =>
      mesh.position(mesh.hVert[vertexCorner[i] as number] as number),
    ) as [Tuple3, Tuple3, Tuple3];
    const longest = Math.max(
      length(sub(exact[1], exact[0])),
      length(sub(exact[2], exact[1])),
      length(sub(exact[0], exact[2])),
    );
    const altitude =
      longest > 0 ? length(cross(sub(exact[1], exact[0]), sub(exact[2], exact[0]))) / longest : 0;
    const reach = maxOf(exact.flatMap((p) => p.map(Math.abs)));
    if (altitude <= F32_SLIVER_STEPS * reach * F32_EPSILON) {
      slivers.add(t);
      continue;
    }
    return err(
      modelingError('model-degenerate', 'no triangle collapses or inverts after f32 conversion', {
        face,
        triangle: t,
        at: scale(add(add(exact[0], exact[1]), exact[2]), 1 / 3),
        vertices: exact,
        altitude,
      }),
    );
  }
  if (slivers.size > 0) {
    const kept: number[] = [];
    const keptFaces: number[] = [];
    for (const submesh of submeshes) {
      const offset = kept.length;
      for (
        let t = submesh.indexOffset / 3;
        t < (submesh.indexOffset + submesh.indexCount) / 3;
        t++
      ) {
        if (slivers.has(t)) continue;
        kept.push(
          indices[t * 3] as number,
          indices[t * 3 + 1] as number,
          indices[t * 3 + 2] as number,
        );
        keptFaces.push(triangleFace[t] as number);
      }
      submesh.indexOffset = offset;
      submesh.indexCount = kept.length - offset;
    }
    indices.length = 0;
    for (const i of kept) indices.push(i);
    triangleFace.length = 0;
    for (const f of keptFaces) triangleFace.push(f);
  }
  const triangles = indices.length / 3;

  const indexArray = count <= 0xffff ? new Uint16Array(indices) : new Uint32Array(indices);
  const uv = channelData.get('uv0') as Float32Array;
  const tangent = computeTangentVec4(position, normal, uv, indexArray);
  if (!tangent.ok) {
    return err(
      modelingError('model-degenerate', 'tangents can be derived from positions, normals and UVs', {
        cause: tangent.error.code,
      }),
    );
  }
  const attributes: Record<string, Float32Array> = { position, normal, tangent: tangent.value };
  for (const [name, key] of exported) attributes[key] = channelData.get(name) as Float32Array;
  const slotNames = slotOrder.map((m) => mesh.materialNames[m] as string);
  const built = createMeshBuilder({
    attributes: attributes as VertexAttributeMap,
    indices: indexArray,
    submeshes,
    materialSlots: slotNames.map((slotName) => ({ slotName })),
  }).build();
  if (!built.ok) {
    return err(
      modelingError('model-degenerate', 'the exported buffers form a valid MeshAsset', {
        cause: built.error.code,
        detail: built.error.detail,
      }),
    );
  }
  const aabb = built.value.aabb;
  const box: [number, number, number, number, number, number] = aabb
    ? ([aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]].map((x) => x as number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ])
    : [0, 0, 0, 0, 0, 0];
  return ok({
    mesh: built.value,
    report: {
      faces: faces.length,
      triangles,
      gpuVertices: count,
      slivers: slivers.size,
      ...(options.checkTopology === true ? { topology: weldedTopology(mesh, faces) } : {}),
      ...(exactNormal === undefined ? {} : { exactNormals: [exactCount, count] as const }),
      ...(exactNormal !== undefined && exactCount === 0 && (options.surfaces ?? []).length > 0
        ? {
            diagnostics: [
              {
                severity: 'info' as const,
                message:
                  'no render vertex lies on a recorded patch: every normal is weighted (a transform after m.surface leaves the patches behind)',
                detail: { patches: (options.surfaces ?? []).length, vertices: count },
              },
            ],
          }
        : {}),
      materialSlots: slotNames,
      aabb: box,
    },
    vertexCorner: Int32Array.from(vertexCorner),
    triangleFace: Int32Array.from(triangleFace),
  });
}

/** Suffix of the patch `m.mirror` records for each recorded patch (then `.k` if taken). */
export const MIRROR_SUFFIX = '.mirror';
const RECORDED_SUFFIX = /\.(\d+|mirror)$/;

/** Largest angle between the exact normals averaged into one group (G1 across a seam), degrees. */
const SEAM_ANGLE = 1;
const SEAM_COSINE = cos((SEAM_ANGLE * Math.PI) / 180);
/** Parameter step toward the interior for the limit normal at a degenerate point. */
const LIMIT_STEP = 1e-6;

/** A tangent pair spanning less than this fraction of its squared speed is degenerate. */
const DEGENERATE = 1e-8;

/** Unit normal at normalized (s, t), or undefined where the tangents (nearly) collapse. */
function regularNormal(surface: NurbsSurface, s: number, t: number): Tuple3 | undefined {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const d = surfaceDerivatives(surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 1);
  const su = scale((d[1] as Tuple3[])[0] as Tuple3, u1 - u0);
  const sv = scale((d[0] as Tuple3[])[1] as Tuple3, v1 - v0);
  const n = cross(su, sv);
  return length(n) > DEGENERATE * (dot(su, su) + dot(sv, sv)) ? normalize(n) : undefined;
}

/**
 * Normal of a patch at (s, t), or at a degenerate point (a pole, a zero-speed line) its
 * limit from the interior: the one-sided normals beside it, when they agree within
 * `SEAM_ANGLE`. Rounding leaves an exact pole a noisy cross product, not a zero one.
 */
function exactPatchNormal(surface: NurbsSurface, s: number, t: number): Tuple3 | undefined {
  const m = regularNormal(surface, s, t);
  if (m !== undefined) return m;
  const sides: Tuple3[] = [];
  for (const [ds, dt] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const a = s + ds * LIMIT_STEP;
    const b = t + dt * LIMIT_STEP;
    if (a < 0 || a > 1 || b < 0 || b > 1) continue;
    const n = regularNormal(surface, a, b);
    if (n !== undefined) sides.push(n);
  }
  const first = sides[0];
  if (first === undefined) return undefined;
  if (sides.some((n) => dot(n, first) < SEAM_COSINE)) return undefined;
  return normalize(sides.reduce(add, [0, 0, 0] as Tuple3));
}

/**
 * Exact normals per normal group (a vertex's smooth corner fan): the mean of its corners'
 * patch normals (the limit normal at a degenerate point), each oriented to its face's side.
 * The orientation makes reflected patches exact too: a mirror reverses the parameter
 * orientation, so su x sv of a `.mirror` patch points inward, and the face normal turns it. Each corner is judged on the
 * candidate patch nearest its vertex at its `uv1`. A corner off that patch (a T-junction or
 * weld moved the vertex from its `uv1` point) does not contribute, but its patch normal there
 * must still agree: the vertex stands in for that point too. A group is absent (it takes the
 * weighted normal) with a corner of a face on no recorded patch, with no corner on its patch,
 * with a corner where the patch has no normal (a cone point, whose one-sided normals differ),
 * or whose normals differ by more than `SEAM_ANGLE` (a crease across a smooth edge, or a fan
 * welded across a normal jump).
 */
function surfaceNormals(
  mesh: EditMesh,
  faces: readonly number[],
  faceNormals: ReadonlyMap<number, Tuple3>,
  groups: UnionFind,
  options: ExportOptions,
): Map<number, Tuple3> {
  // Recorded names may carry `.k` suffixes that make repeated patch names unique and
  // `.mirror` suffixes of reflected patches; faces keep the tag of the name they started with.
  const patches = (options.surfaces ?? []).map((p) => {
    const tags: number[] = [];
    for (let name = p.name, base = ''; ; name = base) {
      tags.push(mesh.tagIndex(name, false));
      base = name.replace(RECORDED_SUFFIX, '');
      if (base === name) break;
    }
    return { surface: p.surface, tags };
  });
  const failed = new Set<number>();
  const found = new Map<number, Tuple3[]>();
  const constraints = new Map<number, Tuple3[]>();
  const push = (map: Map<number, Tuple3[]>, root: number, n: Tuple3) => {
    const list = map.get(root);
    if (list === undefined) map.set(root, [n]);
    else list.push(n);
  };
  const uv1 = mesh.channels.has('uv1');
  for (const f of faces) {
    const candidates = patches.filter((p) => p.tags.some((t) => t >= 0 && mesh.hasTag(f, t)));
    const n = faceNormals.get(f) as Tuple3;
    for (const h of mesh.faceHalves(f)) {
      const root = groups.find(h);
      if (failed.has(root)) continue;
      if (candidates.length === 0 || !uv1) {
        failed.add(root);
        continue;
      }
      const st = mesh.corner('uv1', h);
      if (st === undefined) continue;
      const s = st[0] as number;
      const t = st[1] as number;
      if (!(s >= -1e-9 && s <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9)) continue;
      const p = mesh.position(mesh.hVert[h] as number);
      let nearest: NurbsSurface | undefined;
      let offset = Number.POSITIVE_INFINITY;
      for (const { surface } of candidates) {
        const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
        const q = (
          surfaceDerivatives(surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 0)[0] as Tuple3[]
        )[0] as Tuple3;
        const d = length(sub(q, p));
        if (d < offset) {
          offset = d;
          nearest = surface;
        }
      }
      const m = exactPatchNormal(
        nearest as NurbsSurface,
        Math.min(1, Math.max(0, s)),
        Math.min(1, Math.max(0, t)),
      );
      if (m === undefined) {
        failed.add(root);
        continue;
      }
      push(
        offset > SURFACE_TOLERANCE ? constraints : found,
        root,
        dot(m, n) < 0 ? scale(m, -1) : m,
      );
    }
  }
  const out = new Map<number, Tuple3>();
  for (const [root, list] of found) {
    if (failed.has(root)) continue;
    const all = [...list, ...(constraints.get(root) ?? [])];
    const consistent = all.every((a) => all.every((b) => dot(a, b) >= SEAM_COSINE));
    if (consistent) out.set(root, list.reduce(add, [0, 0, 0] as Tuple3));
  }
  return out;
}
