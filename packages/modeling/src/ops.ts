import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { setFlag } from './crease';
import { atan2, hypot2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  add,
  axisIndex,
  cross,
  dot,
  faceCentroid,
  faceNormal,
  length,
  newell,
  normalize,
  planeOffset,
  scale,
  sub,
  type Tuple3,
} from './geom';
import { type CornerChannelName, type EditMesh, edgeKey, FACE_MIRRORED, NONE } from './mesh';

/** Non-fatal fact an operation reports alongside its result. */
export interface OpDiagnostic {
  readonly severity: 'info' | 'warn';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Number of faces an operation produced or moved, per role. */
export type RoleCounts = Record<string, number>;

/** One repair event: where it happened and how far the result departs from the input, in meters. */
export interface RepairSite {
  readonly at: Tuple3;
  readonly deviation: number;
}

interface RepairBase {
  /** One count per event. */
  readonly changed: number;
  /** One per event, by deviation descending then position; at most MAX_REPAIR_SITES. */
  readonly sites: readonly RepairSite[];
}

/** What a repair operation changed; `sites[0]` is its largest departure from the input. */
export type RepairReport =
  | (RepairBase & { readonly op: 'weld'; readonly collapsedFaces: number })
  | (RepairBase & { readonly op: 'resolveTJunctions' })
  | (RepairBase & { readonly op: 'weldEdgeSequence'; readonly inserted: number })
  | (RepairBase & {
      readonly op: 'fillHoles';
      readonly largestLoop: number;
      readonly nonplanar: number;
    })
  | (RepairBase & {
      readonly op: 'cleanup.slivers';
      readonly found: number;
      readonly kept: readonly Tuple3[];
      readonly keptCount: number;
    });

/** Receives the report of a repair operation that succeeded. */
export type RepairSink = (report: RepairReport) => void;

export const MAX_REPAIR_SITES = 32;

/** The `changed` and bounded, ordered `sites` of a repair report built from its events. */
export function repairBase(events: readonly RepairSite[]): RepairBase {
  const sites = [...events]
    .sort(
      (a, b) =>
        b.deviation - a.deviation || a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2],
    )
    .slice(0, MAX_REPAIR_SITES);
  return { changed: events.length, sites };
}

export interface Attribution {
  readonly label: number;
  readonly material: number;
  readonly tag: number;
}

export function requireFinite(name: string, value: number): Result<number, ModelingError> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err(
      modelingError('model-invalid-argument', `${name} is a finite number`, { [name]: value }),
    );
  }
  return ok(value);
}

export function requirePositive(name: string, value: number): Result<number, ModelingError> {
  const finite = requireFinite(name, value);
  if (!finite.ok) return finite;
  if (value <= 0) {
    return err(
      modelingError('model-invalid-argument', `${name} is greater than 0`, { [name]: value }),
    );
  }
  return ok(value);
}

export function requireSegments(
  name: string,
  value: number,
  minimum: number,
): Result<number, ModelingError> {
  if (!Number.isInteger(value) || value < minimum) {
    return err(
      modelingError('model-invalid-argument', `${name} is an integer >= ${minimum}`, {
        [name]: value,
      }),
    );
  }
  return ok(value);
}

export function addFaces(
  mesh: EditMesh,
  loops: readonly (readonly number[])[],
  attribution: Attribution,
  role: string,
  counts: RoleCounts,
): Result<number[], ModelingError> {
  const roleIndex = attribution.label === 0 ? 0 : mesh.nameIndex(mesh.roleNames, role);
  const faces: number[] = [];
  for (const loop of loops) {
    const added = mesh.addFace(loop, attribution.material);
    if (!added.ok) return added;
    const f = added.value;
    mesh.fLabel[f] = attribution.label;
    mesh.fRole[f] = roleIndex;
    if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
    faces.push(f);
  }
  counts[role] = (counts[role] ?? 0) + faces.length;
  return ok(faces);
}

// ---- region operations ----------------------------------------------------------

interface Region {
  readonly faces: Set<number>;
  /** Region half-edges whose twin face is outside the region. */
  readonly boundary: number[];
}

export function region(mesh: EditMesh, faces: readonly number[]): Region {
  const set = new Set(faces);
  const boundary: number[] = [];
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const other = mesh.hFace[h ^ 1] as number;
      if (other === NONE || !set.has(other)) boundary.push(h);
    }
  }
  return { faces: set, boundary };
}

export interface SavedFace {
  readonly loop: number[];
  readonly face: number;
  readonly corners: readonly number[];
}

export function detachFaces(mesh: EditMesh, faces: readonly number[]): SavedFace[] {
  return faces.map((f) => ({ loop: mesh.faceVertices(f), face: f, corners: mesh.faceHalves(f) }));
}

/** What restoreFace reads from the mesh state before an edit: an EditMesh copy, or a region snapshot. */
export interface FaceSource {
  readonly channels: ReadonlyMap<CornerChannelName, unknown>;
  corner(name: CornerChannelName, h: number): ArrayLike<number> | undefined;
  copyFaceAttributesTo(from: number, target: EditMesh, to: number): void;
}

/**
 * The parts of `faces` that restoring them needs, copied before they are removed:
 * corner values, face attributes, positions and edge flags. Costs the region, not the
 * mesh (a full clone per call made repeated region edits quadratic).
 */
export class RegionSnapshot implements FaceSource {
  readonly channels = new Map<CornerChannelName, true>();
  private readonly corners = new Map<number, Map<CornerChannelName, Float32Array>>();
  private readonly attributes = new Map<
    number,
    { material: number; label: number; role: number; flags: number; tags: Uint32Array }
  >();
  private readonly positions = new Map<number, Tuple3>();
  private readonly flags = new Map<number, number>();

  constructor(mesh: EditMesh, faces: readonly number[]) {
    for (const name of mesh.channels.keys()) this.channels.set(name, true);
    for (const f of faces) {
      this.attributes.set(f, {
        material: mesh.fMaterial[f] as number,
        label: mesh.fLabel[f] as number,
        role: mesh.fRole[f] as number,
        flags: mesh.fFlags[f] as number,
        tags: mesh.fTags.slice(f * mesh.tagWords, (f + 1) * mesh.tagWords),
      });
      for (const h of mesh.faceHalves(f)) {
        const v = mesh.hVert[h] as number;
        if (!this.positions.has(v)) this.positions.set(v, mesh.position(v));
        const w = mesh.hVert[mesh.hNext[h] as number] as number;
        const e = mesh.eFlags[h >> 1] as number;
        if (e !== 0) this.flags.set(edgeKey(v, w), e);
        const values = new Map<CornerChannelName, Float32Array>();
        for (const name of mesh.channels.keys()) {
          const value = mesh.corner(name, h);
          if (value !== undefined) values.set(name, value.slice());
        }
        this.corners.set(h, values);
      }
    }
  }

  corner(name: CornerChannelName, h: number): Float32Array | undefined {
    return this.corners.get(h)?.get(name);
  }

  position(v: number): Tuple3 {
    return this.positions.get(v) as Tuple3;
  }

  edgeFlags(a: number, b: number): number {
    return this.flags.get(edgeKey(a, b)) ?? 0;
  }

  copyFaceAttributesTo(from: number, target: EditMesh, to: number): void {
    const a = this.attributes.get(from);
    if (a === undefined) return;
    target.fMaterial[to] = a.material;
    target.fLabel[to] = a.label;
    target.fRole[to] = a.role;
    target.fFlags[to] = a.flags;
    for (let w = 0; w < Math.min(a.tags.length, target.tagWords); w++) {
      target.fTags[to * target.tagWords + w] = a.tags[w] as number;
    }
  }
}

/** Re-create a face from a saved loop with remapped vertices, keeping attributes and corner values. */
export function restoreFace(
  mesh: EditMesh,
  scratch: FaceSource,
  saved: SavedFace,
  remap: (v: number) => number,
): Result<number, ModelingError> {
  const added = mesh.addFace(saved.loop.map(remap));
  if (!added.ok) return added;
  const f = added.value;
  scratch.copyFaceAttributesTo(saved.face, mesh, f);
  const halves = mesh.faceHalves(f);
  for (let i = 0; i < halves.length; i++) {
    for (const name of scratch.channels.keys()) {
      const value = scratch.corner(name, saved.corners[i] as number);
      if (value !== undefined) mesh.setCorner(name, halves[i] as number, value);
    }
  }
  return ok(f);
}

export function edgeFlagsBetween(mesh: EditMesh, a: number, b: number): number {
  const h = mesh.findHalf(a, b);
  return h === NONE ? 0 : (mesh.eFlags[h >> 1] as number);
}

export function setEdgeFlags(mesh: EditMesh, a: number, b: number, flags: number): void {
  const h = mesh.findHalf(a, b);
  if (h !== NONE) mesh.eFlags[h >> 1] = flags;
}

export function markRole(
  mesh: EditMesh,
  faces: readonly number[],
  label: number,
  role: string,
  counts: RoleCounts,
) {
  if (faces.length === 0) return;
  if (label !== 0) {
    const roleIndex = mesh.nameIndex(mesh.roleNames, role);
    for (const f of faces) {
      mesh.fLabel[f] = label;
      mesh.fRole[f] = roleIndex;
    }
  }
  counts[role] = (counts[role] ?? 0) + faces.length;
}

/** How selected faces group: one region, one per face, or one per edge-connected island. */
export type RegionMode = 'merged' | 'perFace' | 'perIsland';

/** Split selected faces into the groups a region operation treats independently. */
export function regionGroups(
  mesh: EditMesh,
  faces: readonly number[],
  mode: RegionMode,
): number[][] {
  if (mode === 'merged') return [[...faces]];
  if (mode === 'perFace') return faces.map((f) => [f]);
  const selected = new Set(faces);
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (const seed of faces) {
    if (seen.has(seed)) continue;
    const group: number[] = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length > 0) {
      const f = stack.pop() as number;
      group.push(f);
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g !== NONE && selected.has(g) && !seen.has(g)) {
          seen.add(g);
          stack.push(g);
        }
      }
    }
    groups.push(group.sort((a, b) => a - b));
  }
  return groups;
}

/**
 * Region vertices that faces outside the region also use (shared edges or pinched
 * corners); with `openBoundary`, also the vertices on open mesh boundary edges.
 */
export function sharedVertices(
  mesh: EditMesh,
  faces: readonly number[],
  openBoundary: boolean,
): Set<number> {
  // Typed marks keep the one pass over the half-edges cheap; it stays exact for pinched
  // vertices, which a walk around the region's fans would miss.
  const inside = new Uint8Array(mesh.faceHighWater);
  for (const f of faces) inside[f] = 1;
  const regionVertex = new Uint8Array(mesh.vertexHighWater);
  for (const f of faces) for (const v of mesh.faceVertices(f)) regionVertex[v] = 1;
  const shared = new Set<number>();
  for (let h = 0; h < mesh.halfHighWater; h++) {
    const f = mesh.hFace[h] as number;
    if (f === NONE || inside[f] === 1) continue;
    const v = mesh.hVert[h] as number;
    if (regionVertex[v] === 1) shared.add(v);
  }
  for (const h of region(mesh, faces).boundary) {
    if (!openBoundary && (mesh.hFace[h ^ 1] as number) === NONE) continue;
    shared.add(mesh.hVert[h] as number);
    shared.add(mesh.hVert[mesh.hNext[h] as number] as number);
  }
  return shared;
}

/**
 * For each shared region vertex whose region faces form more than one fan (faces
 * linked through edges at that vertex), the fan of every face corner there, keyed
 * `face:vertex`; vertices with one fan are absent (fan 0).
 */
function regionFans(saved: readonly SavedFace[], shared: ReadonlySet<number>): Map<string, number> {
  const around = new Map<number, number[]>();
  for (const [i, s] of saved.entries()) {
    for (const v of s.loop) {
      if (!shared.has(v)) continue;
      const list = around.get(v);
      if (list === undefined) around.set(v, [i]);
      else list.push(i);
    }
  }
  const out = new Map<string, number>();
  for (const [v, list] of around) {
    if (list.length < 2) continue;
    // Faces at v that share an edge (v, w) belong to one fan.
    const parent = list.map((_, k) => k);
    const find = (k: number): number => {
      while (parent[k] !== k) k = parent[k] as number;
      return k;
    };
    const neighbours = (i: number) => {
      const loop = (saved[i] as SavedFace).loop;
      const at = loop.indexOf(v);
      return [
        loop[(at + 1) % loop.length] as number,
        loop[(at + loop.length - 1) % loop.length] as number,
      ];
    };
    for (let x = 0; x < list.length; x++) {
      const nx = neighbours(list[x] as number);
      for (let y = x + 1; y < list.length; y++) {
        if (neighbours(list[y] as number).some((w) => nx.includes(w))) {
          const rx = find(x);
          const ry = find(y);
          if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
        }
      }
    }
    const roots = [...new Set(list.map((_, k) => find(k)))];
    if (roots.length < 2) continue;
    for (const [k, i] of list.entries()) {
      out.set(`${(saved[i] as SavedFace).face}:${v}`, roots.indexOf(find(k)));
    }
  }
  return out;
}

/**
 * Detach a face region and move it: region vertices shared with the rest of the
 * mesh are duplicated (with `openBoundary`, also those on open mesh boundaries,
 * where walls attach), other region vertices move in place, and `position` gives
 * each moved vertex its new position (absent = unchanged). Region faces keep their
 * attributes, corner values and edge intent. Returns the vertex remap and the
 * region boundary as (old a, old b, flags) for the caller to stitch.
 */
export function detachRegion(
  mesh: EditMesh,
  faces: readonly number[],
  position: (v: number) => Tuple3 | undefined,
  openBoundary: boolean,
  /**
   * The region's shared vertices when the caller knows them (no mesh scan): `'boundary'`
   * when only the region and the faces along its boundary use its vertices (a region
   * extruded just before), or the set itself.
   */
  shared?: 'boundary' | ReadonlySet<number>,
): Result<
  {
    /** Where a region face's vertex went: its moved copy, or itself when it moved in place. */
    readonly target: (face: number, v: number) => number;
    readonly moved: number[];
    readonly boundary: { a: number; b: number; flags: number; face: number }[];
    readonly scratch: RegionSnapshot;
  },
  ModelingError
> {
  const outline = region(mesh, faces).boundary;
  const sharedSet =
    shared === 'boundary'
      ? new Set(
          outline.flatMap((h) => [
            mesh.hVert[h] as number,
            mesh.hVert[mesh.hNext[h] as number] as number,
          ]),
        )
      : (shared ?? sharedVertices(mesh, faces, openBoundary));
  const boundary = outline.map((h) => ({
    a: mesh.hVert[h] as number,
    b: mesh.hVert[mesh.hNext[h] as number] as number,
    flags: mesh.eFlags[h >> 1] as number,
    face: mesh.hFace[h] as number,
  }));
  const scratch = new RegionSnapshot(mesh, faces);
  const saved = detachFaces(mesh, faces);
  // A region vertex whose region faces form several edge-connected fans (lobes that touch
  // only there, as a row of triangles) gets one moved copy per fan: one copy would carry
  // two rung edges in the same direction (non-manifold walls).
  const fanOf = regionFans(saved, sharedSet);
  for (const f of faces) mesh.removeFace(f);
  const copies = new Map<string, number>();
  const unmoved = new Set<number>();
  const target = (face: number, v: number): number => {
    if (unmoved.has(v)) return v;
    const id = `${v}:${fanOf.get(`${face}:${v}`) ?? 0}`;
    const known = copies.get(id);
    if (known !== undefined) return known;
    const q = position(v) ?? scratch.position(v);
    if (!sharedSet.has(v)) {
      mesh.setPosition(v, ...q);
      unmoved.add(v);
      return v;
    }
    const copy = mesh.addVertex(...q);
    copies.set(id, copy);
    return copy;
  };
  for (const s of saved) for (const v of s.loop) target(s.face, v);
  const moved: number[] = [];
  for (const s of saved) {
    const restored = restoreFace(mesh, scratch, s, (v) => target(s.face, v));
    if (!restored.ok) return restored;
    moved.push(restored.value);
  }
  for (const s of saved) {
    for (let i = 0; i < s.loop.length; i++) {
      const a = s.loop[i] as number;
      const b = s.loop[(i + 1) % s.loop.length] as number;
      const flags = scratch.edgeFlags(a, b);
      if (flags !== 0) setEdgeFlags(mesh, target(s.face, a), target(s.face, b), flags);
    }
  }
  return ok({ target, moved, boundary, scratch });
}

/**
 * Shared base of extrude, inset and offset (disconnect, displace, stitch):
 * detach the region to `position`, then grow one wall quad from every region
 * boundary edge. Walls copy the material, flags and tags of the region face they
 * grow from but no role identity (only a labeled call gives them one), and the
 * boundary keeps its edge intent; the new rung edges are smooth.
 */
export function extrudeRegion(
  mesh: EditMesh,
  faces: readonly number[],
  position: (v: number) => Tuple3 | undefined,
  shared?: 'boundary' | ReadonlySet<number>,
): Result<{ readonly moved: number[]; readonly walls: number[] }, ModelingError> {
  const detached = detachRegion(mesh, faces, position, true, shared);
  if (!detached.ok) return detached;
  const { target, moved, boundary, scratch } = detached.value;
  const walls: number[] = [];
  for (const { a, b, flags, face } of boundary) {
    const a2 = target(face, a);
    const b2 = target(face, b);
    const added = mesh.addFace([a, b, b2, a2]);
    if (!added.ok) return added;
    scratch.copyFaceAttributesTo(face, mesh, added.value);
    mesh.fLabel[added.value] = 0;
    mesh.fRole[added.value] = 0;
    walls.push(added.value);
    if (flags !== 0) setEdgeFlags(mesh, a, b, flags);
  }
  return ok({ moved, walls });
}

function regionNormal(mesh: EditMesh, faces: readonly number[]): Tuple3 {
  return normalize(
    faces.reduce<Tuple3>(
      (sum, f) => add(sum, newell(mesh.faceVertices(f).map((v) => mesh.position(v)))),
      [0, 0, 0],
    ),
  );
}

export interface ExtrudeOptions {
  readonly distance: number;
  readonly region: RegionMode;
}

/**
 * Extrude faces along their region normal. Moved faces get role `top`; new walls
 * get role `side`. Walls inherit the sharp flag of the boundary edge they grow from.
 * Effect assertion (soft, design 7.4): each group's faces move by `distance` along
 * the region normal, and on a closed mesh the volume changes with the sign of
 * `distance` (beyond `tolerance` times the moved area); a violation is a warning.
 */
export function extrude(
  mesh: EditMesh,
  faces: readonly number[],
  options: ExtrudeOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const distance = requireFinite('distance', options.distance);
  if (!distance.ok) return distance;
  if (options.distance === 0) {
    return err(modelingError('model-invalid-argument', 'distance is non-zero', { distance: 0 }));
  }
  const closed = isClosed(mesh);
  // Volumes about a local point: far from the origin, world-origin tetrahedra cancel
  // catastrophically (a box at 1e5 m reported the wrong sign for a 1 cm extrusion).
  const pivot = faces.length > 0 ? faceCentroid(mesh, faces[0] as number) : ([0, 0, 0] as Tuple3);
  const volumeBefore = closed ? volumeAbout(mesh, pivot) : 0;
  const area = faces.reduce(
    (sum, f) => sum + length(newell(mesh.faceVertices(f).map((v) => mesh.position(v)))) / 2,
    0,
  );
  const counts: RoleCounts = {};
  const displaced: { faces: number; moved: number }[] = [];
  for (const group of regionGroups(mesh, faces, options.region)) {
    const normal = regionNormal(mesh, group);
    if (length(normal) === 0) {
      return err(
        modelingError('model-degenerate', 'the extruded region has a defined normal', {
          faces: group,
        }),
      );
    }
    const before = meanCentroid(mesh, group);
    const offset = scale(normal, options.distance);
    const done = extrudeRegion(mesh, group, (v) => add(mesh.position(v), offset));
    if (!done.ok) return done;
    const moved = dot(sub(meanCentroid(mesh, done.value.moved), before), normal);
    if (Math.abs(moved - options.distance) > tolerance) {
      displaced.push({ faces: group.length, moved });
    }
    markRole(mesh, done.value.moved, label, 'top', counts);
    markRole(mesh, done.value.walls, label, 'side', counts);
  }
  if (displaced.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${displaced.length} extruded group(s) moved by other than distance ${options.distance} along their normal`,
      detail: { distance: options.distance, groups: displaced },
    });
  }
  if (closed) {
    const change = volumeAbout(mesh, pivot) - volumeBefore;
    if (change * Math.sign(options.distance) < -tolerance * area) {
      diagnostics.push({
        severity: 'warn',
        message: `the closed mesh volume changed by ${change}, against the sign of distance ${options.distance}; check for inverted faces or self-intersection`,
        detail: { distance: options.distance, volumeChange: change },
      });
    }
  }
  return ok(counts);
}

function meanCentroid(mesh: EditMesh, faces: readonly number[]): Tuple3 {
  const sum = faces.reduce<Tuple3>((acc, f) => add(acc, faceCentroid(mesh, f)), [0, 0, 0]);
  return scale(sum, 1 / faces.length);
}

/** Signed volume of a closed mesh, summed from tetrahedra at `pivot`. */
function volumeAbout(mesh: EditMesh, pivot: Tuple3): number {
  let volume = 0;
  for (const f of mesh.faces()) {
    const p = mesh.faceVertices(f).map((v) => sub(mesh.position(v), pivot));
    for (let i = 1; i + 1 < p.length; i++) {
      volume += dot(p[0] as Tuple3, cross(p[i] as Tuple3, p[i + 1] as Tuple3)) / 6;
    }
  }
  return volume;
}

/** Every edge has a face on both sides (and the mesh has faces). */
export function isClosed(mesh: EditMesh): boolean {
  const edges = mesh.edges();
  return edges.length > 0 && edges.every((e) => !mesh.isBoundaryEdge(e));
}

export interface OffsetOptions {
  readonly distance: number;
  readonly region: RegionMode;
}

/** Offset displacement limit, in multiples of `distance`; longer corner moves are clamped and reported. */
const OFFSET_MITER_LIMIT = 4;

/**
 * Offset faces so each face plane moves by `distance` along its own normal: every
 * vertex solves for the displacement that moves all its incident region face planes
 * by `distance` (exact for up to three independent planes, least squares on curved
 * neighbourhoods), clamped to the miter limit. Roles `top` and `side` as for extrude.
 * Effect assertion (soft): faces whose plane moved by other than `distance` within
 * `tolerance` are reported as a warning, separating miter-clamped faces.
 */
export function offset(
  mesh: EditMesh,
  faces: readonly number[],
  options: OffsetOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const distance = requireFinite('distance', options.distance);
  if (!distance.ok) return distance;
  if (options.distance === 0) {
    return err(modelingError('model-invalid-argument', 'distance is non-zero', { distance: 0 }));
  }
  const counts: RoleCounts = {};
  const off: { face: number; moved: number; clamped: boolean }[] = [];
  for (const group of regionGroups(mesh, faces, options.region)) {
    const planes = group.map((f) => ({
      normal: faceNormal(mesh, f),
      point: faceCentroid(mesh, f),
    }));
    const incident = new Map<number, Tuple3[]>();
    for (const [i, f] of group.entries()) {
      const n = (planes[i] as { normal: Tuple3 }).normal;
      for (const h of mesh.faceHalves(f)) {
        const v = mesh.hVert[h] as number;
        const list = incident.get(v) ?? [];
        list.push(n);
        incident.set(v, list);
      }
    }
    const targets = new Map<number, Tuple3>();
    const clamped = new Set<number>();
    const limit = Math.abs(options.distance) * OFFSET_MITER_LIMIT;
    for (const [v, normals] of incident) {
      let move = planeOffset(normals, options.distance);
      const reach = length(move);
      if (reach > limit) {
        move = scale(move, limit / reach);
        clamped.add(v);
      }
      targets.set(v, add(mesh.position(v), move));
    }
    const corners = group.map((f) => [...mesh.faceHalves(f)].map((h) => mesh.hVert[h] as number));
    const done = extrudeRegion(mesh, group, (v) => targets.get(v));
    if (!done.ok) return done;
    for (const [i, f] of done.value.moved.entries()) {
      const plane = planes[i] as { normal: Tuple3; point: Tuple3 };
      const moved = dot(sub(faceCentroid(mesh, f), plane.point), plane.normal);
      if (Math.abs(moved - options.distance) > tolerance) {
        const hit = (corners[i] as number[]).some((v) => clamped.has(v));
        off.push({ face: f, moved, clamped: hit });
      }
    }
    markRole(mesh, done.value.moved, label, 'top', counts);
    markRole(mesh, done.value.walls, label, 'side', counts);
  }
  if (off.length > 0) {
    const moved = off.map((x) => x.moved);
    const clampedFaces = off.filter((x) => x.clamped).length;
    diagnostics.push({
      severity: 'warn',
      message:
        clampedFaces > 0
          ? `${off.length} face plane(s) moved by other than distance; ${clampedFaces} touch corners clamped at the miter limit of ${OFFSET_MITER_LIMIT} x distance`
          : `${off.length} face plane(s) moved by other than distance: their corners join more than three face directions (curved region)`,
      detail: {
        faces: off.length,
        clampedFaces,
        distance: options.distance,
        minMoved: minOf(moved),
        maxMoved: maxOf(moved),
      },
    });
  }
  return ok(counts);
}

export interface InsetOptions {
  readonly thickness: number;
  readonly region: RegionMode;
}

/**
 * Inset faces inside their own plane. The inner faces get role `inner`; the ring
 * of new faces gets role `rim`. Fails without changes when an inner face would
 * collapse or invert.
 */
export function inset(
  mesh: EditMesh,
  faces: readonly number[],
  options: InsetOptions,
  label: number,
): Result<RoleCounts, ModelingError> {
  const thickness = requirePositive('thickness', options.thickness);
  if (!thickness.ok) return thickness;
  const counts: RoleCounts = {};
  for (const group of regionGroups(mesh, faces, options.region)) {
    const targets = insetTargets(mesh, group, options.thickness);
    if (!targets.ok) return targets;
    const done = extrudeRegion(mesh, group, (v) => targets.value.get(v));
    if (!done.ok) return done;
    markRole(mesh, done.value.moved, label, 'inner', counts);
    markRole(mesh, done.value.walls, label, 'rim', counts);
  }
  return ok(counts);
}

/** Inner positions of the region boundary vertices (offset-line intersection). */
function insetTargets(
  mesh: EditMesh,
  faces: readonly number[],
  thickness: number,
): Result<Map<number, Tuple3>, ModelingError> {
  const { boundary } = region(mesh, faces);
  const outgoing = new Map<number, number>();
  for (const h of boundary) {
    const a = mesh.hVert[h] as number;
    if (outgoing.has(a)) {
      return err(
        modelingError('model-precondition', 'the inset region boundary visits each vertex once', {
          vertex: a,
        }),
      );
    }
    outgoing.set(a, h);
  }
  const incoming = new Map<number, number>();
  for (const h of boundary) incoming.set(mesh.hVert[mesh.hNext[h] as number] as number, h);
  const targets = new Map<number, Tuple3>();
  for (const [v, hOut] of outgoing) {
    const hIn = incoming.get(v);
    if (hIn === undefined) {
      return err(
        modelingError('model-precondition', 'the inset region boundary is closed', { vertex: v }),
      );
    }
    const p = mesh.position(v);
    const next = mesh.position(mesh.hVert[mesh.hNext[hOut] as number] as number);
    const prev = mesh.position(mesh.hVert[hIn] as number);
    const nOut = faceNormal(mesh, mesh.hFace[hOut] as number);
    const nIn = faceNormal(mesh, mesh.hFace[hIn] as number);
    const inwardOut = normalize(cross(nOut, normalize(sub(next, p))));
    const inwardIn = normalize(cross(nIn, normalize(sub(p, prev))));
    const denominator = 1 + dot(inwardOut, inwardIn);
    if (denominator < 1e-6) {
      return err(
        modelingError('model-degenerate', 'boundary corners are not folded back onto themselves', {
          vertex: v,
        }),
      );
    }
    targets.set(v, add(p, scale(add(inwardOut, inwardIn), thickness / denominator)));
  }
  for (const f of faces) {
    const before = mesh.faceVertices(f).map((v) => mesh.position(v));
    const after = mesh.faceVertices(f).map((v) => targets.get(v) ?? mesh.position(v));
    const inverted = before.some((p, i) => {
      const q = before[(i + 1) % before.length] as Tuple3;
      const a = after[i] as Tuple3;
      const b = after[(i + 1) % after.length] as Tuple3;
      return dot(sub(q, p), sub(b, a)) <= 0;
    });
    if (inverted || dot(newell(before), newell(after)) <= 0) {
      return err(
        modelingError(
          'model-degenerate',
          'the inset thickness leaves every inner face with positive area',
          { face: f, thickness },
        ),
      );
    }
  }
  return ok(targets);
}

// ---- whole-mesh and attribute operations ------------------------------------------------

export interface MirrorOptions {
  readonly axis: Axis;
  /** Vertices within this distance of the plane are snapped and shared. */
  readonly weldDistance: number;
}

/** Mirror the whole mesh across the plane through the origin; the copy gets role `mirrored`. */
export function mirror(mesh: EditMesh, options: MirrorOptions): Result<RoleCounts, ModelingError> {
  const distance = requireFinite('weldDistance', options.weldDistance);
  if (!distance.ok) return distance;
  const k = axisIndex(options.axis);
  const faces = mesh.faces();
  const vertices = mesh.vertices();
  const coordinates = vertices.map((v) => mesh.pos[v * 3 + k] as number);
  const positive = coordinates.some((c) => c > options.weldDistance);
  const negative = coordinates.some((c) => c < -options.weldDistance);
  if (positive && negative) {
    return err(
      modelingError(
        'model-precondition',
        'the mesh lies on one side of the mirror plane (model one half, then mirror)',
        { axis: options.axis },
        'delete or bisect the geometry on the other side of the plane before mirroring',
      ),
    );
  }
  for (const f of faces) {
    if (
      mesh
        .faceVertices(f)
        .every((v) => Math.abs(mesh.pos[v * 3 + k] as number) <= options.weldDistance)
    ) {
      return err(
        modelingError('model-precondition', 'no face lies on the mirror plane', {
          face: f,
          axis: options.axis,
        }),
      );
    }
  }
  const image = new Map<number, number>();
  for (const v of vertices) {
    const p = mesh.position(v);
    if (Math.abs(p[k]) <= options.weldDistance) {
      p[k] = 0;
      mesh.setPosition(v, ...p);
      image.set(v, v);
    } else {
      p[k] = -p[k];
      image.set(v, mesh.addVertex(...p));
    }
  }
  const scratch = mesh.clone();
  const copies: number[] = [];
  for (const f of faces) {
    const loop = mesh.faceVertices(f);
    const halves = mesh.faceHalves(f);
    const reversed = [...loop].reverse().map((v) => image.get(v) as number);
    const added = mesh.addFace(reversed);
    if (!added.ok) {
      return err(
        modelingError(
          'model-precondition',
          'the mesh is open along the mirror plane (model one half, then mirror)',
          { face: f, axis: options.axis, cause: added.error.detail },
        ),
      );
    }
    const g = added.value;
    scratch.copyFaceAttributesTo(f, mesh, g);
    mesh.fFlags[g] = (mesh.fFlags[g] as number) | FACE_MIRRORED;
    const newHalves = mesh.faceHalves(g);
    for (let i = 0; i < halves.length; i++) {
      const source = halves[halves.length - 1 - i] as number;
      for (const name of mesh.channels.keys()) {
        const value = scratch.corner(name, source);
        if (value !== undefined) mesh.setCorner(name, newHalves[i] as number, value);
      }
    }
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const flags = edgeFlagsBetween(scratch, a, b);
      if (flags !== 0) setEdgeFlags(mesh, image.get(a) as number, image.get(b) as number, flags);
    }
    copies.push(g);
  }
  return ok({ mirrored: copies.length });
}

/** Move vertices of the given faces by an affine function. */
export function transformVertices(
  mesh: EditMesh,
  vertices: readonly number[],
  map: (p: Tuple3) => Tuple3,
): Result<RoleCounts, ModelingError> {
  for (const v of vertices) {
    const q = map(mesh.position(v));
    if (!q.every(Number.isFinite)) {
      return err(
        modelingError('model-invalid-argument', 'the transform yields finite positions', {
          vertex: v,
        }),
      );
    }
    mesh.setPosition(v, ...q);
  }
  return ok({});
}

/** Reverse the orientation of the given faces. */
export function flipFaces(
  mesh: EditMesh,
  faces: readonly number[],
): Result<RoleCounts, ModelingError> {
  const scratch = mesh.clone();
  const saved = detachFaces(mesh, faces);
  for (const f of faces) mesh.removeFace(f);
  for (const s of saved) {
    const reversed: SavedFace = {
      face: s.face,
      loop: [...s.loop].reverse(),
      corners: [...s.corners].reverse(),
    };
    const restored = restoreFace(mesh, scratch, reversed, (v) => v);
    if (!restored.ok) return restored;
  }
  return ok({ flipped: faces.length });
}

export function deleteFaces(
  mesh: EditMesh,
  faces: readonly number[],
): Result<RoleCounts, ModelingError> {
  const touched = new Set<number>();
  for (const f of faces) for (const v of mesh.faceVertices(f)) touched.add(v);
  for (const f of faces) mesh.removeFace(f);
  const used = new Set<number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
  for (const v of touched) if (!used.has(v)) mesh.removeVertex(v);
  return ok({ deleted: faces.length });
}

/**
 * Merge vertices closer than `distance` (spatial hash, deterministic order) and
 * rebuild faces. Faces that collapse below 3 vertices are removed.
 */
export function weld(
  mesh: EditMesh,
  distance: number,
  repair: RepairSink,
): Result<RoleCounts, ModelingError> {
  const checked = requirePositive('distance', distance);
  if (!checked.ok) return checked;
  const cell = (x: number) => Math.floor(x / distance);
  const buckets = new Map<string, number[]>();
  const target = new Map<number, number>();
  const events: RepairSite[] = [];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    const [ix, iy, iz] = [cell(p[0]), cell(p[1]), cell(p[2])];
    let found = NONE;
    for (let dx = -1; dx <= 1 && found === NONE; dx++) {
      for (let dy = -1; dy <= 1 && found === NONE; dy++) {
        for (let dz = -1; dz <= 1 && found === NONE; dz++) {
          for (const u of buckets.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) {
            if (length(sub(mesh.position(u), p)) <= distance) {
              found = u;
              break;
            }
          }
        }
      }
    }
    if (found === NONE) {
      const key = `${ix},${iy},${iz}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(v);
      buckets.set(key, bucket);
      target.set(v, v);
    } else {
      target.set(v, found);
      const at = mesh.position(found);
      events.push({ at, deviation: length(sub(at, p)) });
    }
  }
  if (events.length === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        `weld merges at least one vertex pair within ${distance} m`,
        { distance, nearest: nearestPair(mesh) },
        'raise distance above detail.nearest, or drop the weld',
      ),
    );
  }
  const scratch = mesh.clone();
  const faces = mesh.faces();
  const saved = detachFaces(mesh, faces);
  const flags = mesh
    .edges()
    .map((e) => ({ ends: mesh.edgeVertices(e), flags: mesh.eFlags[e] as number }));
  for (const f of faces) mesh.removeFace(f);
  let collapsed = 0;
  for (const s of saved) {
    const loop: number[] = [];
    const corners: number[] = [];
    for (let i = 0; i < s.loop.length; i++) {
      const v = target.get(s.loop[i] as number) as number;
      if (loop.length > 0 && loop[loop.length - 1] === v) continue;
      loop.push(v);
      corners.push(s.corners[i] as number);
    }
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      corners.pop();
    }
    if (loop.length < 3) {
      collapsed++;
      continue;
    }
    const restored = restoreFace(mesh, scratch, { face: s.face, loop, corners }, (v) => v);
    if (!restored.ok) return restored;
  }
  for (const { ends, flags: f } of flags) {
    if (f !== 0)
      setEdgeFlags(mesh, target.get(ends[0]) as number, target.get(ends[1]) as number, f);
  }
  for (const [v, t] of target) if (v !== t) mesh.removeVertex(v);
  repair({ op: 'weld', ...repairBase(events), collapsedFaces: collapsed });
  return ok({});
}

/** Distance of the closest vertex pair (brute force, bounded to keep diagnostics cheap). */
function nearestPair(mesh: EditMesh): number | undefined {
  const vertices = mesh.vertices();
  if (vertices.length < 2 || vertices.length > NEAREST_PAIR_LIMIT) return undefined;
  let best = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const p = mesh.position(vertices[i] as number);
    for (let j = i + 1; j < vertices.length; j++) {
      best = Math.min(best, length(sub(mesh.position(vertices[j] as number), p)));
    }
  }
  return best;
}

const NEAREST_PAIR_LIMIT = 4096;

export type ProjectionMode = 'box' | 'planar' | 'cylinder';

export interface ProjectOptions {
  readonly mode: ProjectionMode;
  /** Plane normal for planar projection; cylinder axis (through the origin) for cylinder. */
  readonly axis?: Axis;
  /** World meters per UV unit. */
  readonly scale: number;
  readonly channel?: 'uv0' | 'uv1';
}

/**
 * Write UVs by projecting positions. Box projection picks the dominant normal axis
 * per face. Cylinder projection unrolls the angle around `axis` at each face's mean
 * radius (u) against the height along it (v), keeping a face's corners on one side
 * of the angular seam; faces within 45 degrees of the axis (caps) use planar
 * projection along it. Effect assertion (soft): faces whose UV triangles have zero
 * area are reported.
 */
export function projectUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: ProjectOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const s = requirePositive('scale', options.scale);
  if (!s.ok) return s;
  const channel = options.channel ?? 'uv0';
  const k0 = axisIndex(options.axis ?? 'y');
  const [ku, kw] = [(k0 + 2) % 3, (k0 + 1) % 3];
  let flat = 0;
  for (const f of faces) {
    const n = faceNormal(mesh, f);
    const halves = mesh.faceHalves(f);
    const points = halves.map((h) => mesh.position(mesh.hVert[h] as number));
    let uvs: [number, number][];
    if (options.mode === 'cylinder' && Math.abs(n[k0] as number) < Math.SQRT1_2) {
      const centroid = faceCentroid(mesh, f);
      const center = atan2(centroid[ku] as number, centroid[kw] as number);
      const radius =
        points.reduce((sum, p) => sum + hypot2(p[ku] as number, p[kw] as number), 0) /
        points.length;
      uvs = points.map((p) => {
        let angle = atan2(p[ku] as number, p[kw] as number);
        while (angle - center > Math.PI) angle -= 2 * Math.PI;
        while (center - angle > Math.PI) angle += 2 * Math.PI;
        return [angle * radius, p[k0] as number];
      });
    } else {
      const k =
        options.mode !== 'box'
          ? k0
          : Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
            ? 0
            : Math.abs(n[1]) >= Math.abs(n[2])
              ? 1
              : 2;
      const sign = options.mode === 'box' && (n[k] as number) < 0 ? -1 : 1;
      uvs = points.map((p) =>
        k === 0 ? [-sign * p[2], p[1]] : k === 1 ? [p[0], -sign * p[2]] : [sign * p[0], p[1]],
      );
    }
    for (const [i, h] of halves.entries()) {
      const uv = uvs[i] as [number, number];
      mesh.setCorner(channel, h, [uv[0] / options.scale, uv[1] / options.scale]);
    }
    let area = 0;
    for (let i = 0; i < uvs.length; i++) {
      const a = uvs[i] as [number, number];
      const b = uvs[(i + 1) % uvs.length] as [number, number];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(area) / 2 <= tolerance * tolerance) flat++;
  }
  if (flat > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${flat} face(s) received zero-area UVs; choose a projection axis that does not run along them`,
      detail: { faces: flat },
    });
  }
  return ok({ projected: faces.length });
}

export function markEdges(mesh: EditMesh, edges: readonly number[], flag: number, on: boolean) {
  for (const e of edges) {
    mesh.eFlags[e] = setFlag(mesh.eFlags[e] as number, flag, on);
  }
  return ok({ edges: edges.length });
}
