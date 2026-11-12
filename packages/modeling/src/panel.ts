import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf, pushAll } from './arrays';
import { bevel } from './bevel';
import { mergeFlags } from './crease';
import { bisectMesh, type CutPlane, readPlane } from './cut';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  facesVolume,
  length,
  planeOffset,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  extrudeRegion,
  isClosed,
  markRole,
  type OpDiagnostic,
  type RoleCounts,
  region,
  requirePositive,
} from './ops';
import { type CornerSource, type FaceRewrite, faceCorners, rewriteFaces } from './rewrite';

/** Cross-section of a panel line: flat floor and walls, a V, or a rounded U. */
export type PanelProfile = 'square' | 'v' | 'u';

export interface PanelLineOptions {
  /** Width of the groove at the surface (meters). */
  readonly width: number;
  /** Depth of the groove below the surface (meters). */
  readonly depth: number;
  /** Cross-section (default `square`). */
  readonly profile?: PanelProfile;
}

/** Panel line target: an interior edge path, or the selected faces crossed by a plane. */
export type PanelTarget =
  | { readonly kind: 'edges'; readonly edges: readonly number[] }
  | { readonly kind: 'plane'; readonly faces: readonly number[]; readonly plane: CutPlane };

/** Strip divisions across the width per profile: offsets as fractions of the half width. */
const DIVISIONS: Readonly<Record<PanelProfile, readonly number[]>> = {
  square: [-1, 1],
  v: [-1, 0, 1],
  u: [-1, -0.5, 0, 0.5, 1],
};

/** Depth fraction at a normalized distance `u` (0 at the rim, 1 at the centre line). */
function depthAt(profile: PanelProfile, u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return profile === 'v' ? t : Math.sqrt(1 - (1 - t) * (1 - t));
}

/** Offset displacement limit, in multiples of the depth, at strip corners. */
const MITER_LIMIT = 4;

function pointSegmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return length(sub(p, add(a, scale(ab, t))));
}

/** Faces between the two outer cut planes, after the plane cuts split the selection. */
function planeStrip(
  mesh: EditMesh,
  faces: readonly number[],
  cut: CutPlane,
  half: number,
  profile: PanelProfile,
  tolerance: number,
): Result<{ strip: number[]; point: Tuple3; normal: Tuple3 }, ModelingError> {
  const plane = readPlane(cut);
  if (!plane.ok) return plane;
  const { point, normal } = plane.value;
  const within = new Set(faces);
  for (const fraction of DIVISIONS[profile]) {
    const done = bisectMesh(
      mesh,
      { point: add(point, scale(normal, fraction * half)), normal },
      tolerance,
      within,
    );
    if (!done.ok) return done;
    // Rewritten faces can reuse the ids of other rewritten faces: remove before adding.
    const pieces = done.value.rewritten
      .map((r) => [r.face, r.faces] as const)
      .filter(([source]) => within.has(source));
    for (const [source] of pieces) within.delete(source);
    for (const [, created] of pieces) for (const f of created) within.add(f);
  }
  const strip = [...within]
    .filter((f) =>
      mesh
        .faceVertices(f)
        .every((v) => Math.abs(dot(sub(mesh.position(v), point), normal)) <= half + tolerance),
    )
    .sort((a, b) => a - b);
  if (strip.length === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'the panel plane crosses the selected faces',
        { point: cut.point, normal: cut.normal, faces: faces.length },
        'move the plane onto the selected faces or select the faces it crosses',
      ),
    );
  }
  return ok({ strip, point, normal });
}

/** Incident strip-face unit normals of every strip vertex. */
function incidentNormals(mesh: EditMesh, strip: readonly number[]): Map<number, Tuple3[]> {
  const incident = new Map<number, Tuple3[]>();
  for (const f of strip) {
    const n = faceNormal(mesh, f);
    for (const v of mesh.faceVertices(f)) {
      const list = incident.get(v) ?? [];
      list.push(n);
      incident.set(v, list);
    }
  }
  return incident;
}

function planar(mesh: EditMesh, f: number, tolerance: number): boolean {
  const n = faceNormal(mesh, f);
  const loop = mesh.faceVertices(f);
  const p0 = mesh.position(loop[0] as number);
  return loop.every((v) => Math.abs(dot(sub(mesh.position(v), p0), n)) <= tolerance * 10);
}

/** Split non-planar faces into triangles (quads along the shorter diagonal); source -> pieces. */
function planarize(
  mesh: EditMesh,
  faces: readonly number[],
): Result<Map<number, number[]>, ModelingError> {
  const rewrites: FaceRewrite[] = [];
  for (const f of [...new Set(faces)].sort((a, b) => a - b)) {
    const corners = faceCorners(mesh, f);
    const points = corners.map((c) => mesh.position(c.v));
    let triangles: number[] | undefined;
    if (corners.length === 4) {
      const ac = length(sub(points[2] as Tuple3, points[0] as Tuple3));
      const bd = length(sub(points[3] as Tuple3, points[1] as Tuple3));
      triangles = ac <= bd ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
    } else {
      triangles = triangulateLoop(points);
    }
    if (triangles === undefined) {
      return err(
        modelingError('model-degenerate', 'every groove face can be triangulated', { face: f }),
      );
    }
    const loops: CornerSource[][] = [];
    for (let i = 0; i < triangles.length; i += 3) {
      loops.push([0, 1, 2].map((k) => corners[triangles[i + k] as number] as CornerSource));
    }
    rewrites.push({ face: f, loops });
  }
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  return ok(new Map(rewrites.map((r, i) => [r.face, done.value[i] as number[]] as const)));
}

/**
 * Open the groove ends: an end wall lying in the plane of the face beyond it merges
 * into that face, which gains the groove notch. `walls` pairs each wall with its
 * region boundary edge `a -> b`; returns the walls that remain.
 */
function openEnds(
  mesh: EditMesh,
  walls: readonly { wall: number; a: number; b: number }[],
  isEnd: (a: number, b: number) => boolean,
  tolerance: number,
): Result<number[], ModelingError> {
  const byFace = new Map<number, { wall: number; a: number; b: number }[]>();
  const kept: number[] = [];
  for (const w of walls) {
    const h = mesh.findHalf(w.b, w.a);
    const outside = h === NONE ? NONE : (mesh.hFace[h] as number);
    const n = outside === NONE ? undefined : faceNormal(mesh, outside);
    const p0 = outside === NONE ? undefined : mesh.position(w.a);
    const coplanar =
      n !== undefined &&
      p0 !== undefined &&
      mesh.fMaterial[outside] === mesh.fMaterial[w.wall] &&
      mesh
        .faceVertices(w.wall)
        .every((v) => Math.abs(dot(sub(mesh.position(v), p0), n)) <= tolerance * 10);
    if (!isEnd(w.a, w.b) || !coplanar) {
      kept.push(w.wall);
      continue;
    }
    const list = byFace.get(outside) ?? [];
    list.push(w);
    byFace.set(outside, list);
  }
  if (byFace.size === 0) return ok(kept);
  const rewrites: FaceRewrite[] = [];
  const touched = new Set<number>();
  for (const [outside, group] of [...byFace].sort((x, y) => x[0] - y[0])) {
    const insert = new Map<number, CornerSource[]>();
    for (const { wall, b } of group) {
      const halves = mesh.faceHalves(wall);
      const start = halves.findIndex((h) => mesh.hVert[h] === b);
      const after = [1, 2].map((k) => halves[(start + k) % halves.length] as number);
      insert.set(
        b,
        after.map((h) => ({ v: mesh.hVert[h] as number, corner: h })),
      );
      for (const v of mesh.faceVertices(wall)) touched.add(v);
      rewrites.push({ face: wall, loops: [] });
    }
    let loop: CornerSource[] = [];
    for (const h of mesh.faceHalves(outside)) {
      const v = mesh.hVert[h] as number;
      loop.push({ v, corner: h });
      pushAll(loop, insert.get(v) ?? []);
    }
    for (let changed = true; changed; ) {
      changed = false;
      const n = loop.length;
      for (let i = 0; i < n && n > 3; i++) {
        const p = loop[i] as CornerSource;
        const r = loop[(i + 2) % n] as CornerSource;
        if (p.v !== r.v) continue;
        const drop = new Set([(i + 1) % n, (i + 2) % n]);
        loop = loop.filter((_, k) => !drop.has(k));
        changed = true;
        break;
      }
    }
    rewrites.push({ face: outside, loops: [loop] });
  }
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  const used = new Set<number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
  for (const v of touched) if (!used.has(v)) mesh.removeVertex(v);
  const merged = new Set(rewrites.filter((r) => r.loops.length === 0).map((r) => r.face));
  return ok(kept.filter((f) => !merged.has(f) && mesh.isFaceAlive(f)));
}

/**
 * Cut a panel line (design 8, P1a hard surface): a strip `width` wide is cut into
 * the surface and sunk by `depth` along the surface normal. An edge path becomes the
 * strip through a flat bevel of `width / 2` on each side; a plane cuts the strip from
 * the selected faces only. `square` sinks the strip as a floor (role `groove`) with
 * walls (role `lip`); `v` and `u` keep the strip rim and sink each strip vertex by its
 * profile depth at its distance from the centre line (V flanks are `groove`; for U the
 * rim bands are `lip`). Where the strip ends on a face beyond it, that face gains the
 * groove notch (for `square`, when the end wall lies in its plane; otherwise the end
 * stays closed by a `lip` wall). Rim edges become sharp. Effect assertion (hard):
 * every groove face keeps a non-zero area and its facing; on a closed mesh the
 * volume shrinks (soft: a warning otherwise).
 */
export function panelLine(
  mesh: EditMesh,
  target: PanelTarget,
  options: PanelLineOptions,
  attribution: Attribution,
  material: number | undefined,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const width = requirePositive('width', options.width);
  if (!width.ok) return width;
  const depth = requirePositive('depth', options.depth);
  if (!depth.ok) return depth;
  const profile = options.profile ?? 'square';
  if (!(profile in DIVISIONS)) {
    return err(
      modelingError('model-invalid-argument', "profile is 'square', 'v' or 'u'", { profile }),
    );
  }
  const half = options.width / 2;
  const closed = isClosed(mesh);
  const volumeBefore = closed ? facesVolume(mesh, mesh.faces()) : 0;
  let strip: number[];
  let across: (p: Tuple3) => number;
  if (target.kind === 'edges') {
    const path = target.edges.map(
      (e) => mesh.edgeVertices(e).map((v) => mesh.position(v)) as [Tuple3, Tuple3],
    );
    across = (p) => minOf(path.map(([a, b]) => pointSegmentDistance(p, a, b)));
    const created = new Map<string, number[]>();
    const done = bevel(
      mesh,
      target.edges,
      { width: half, segments: DIVISIONS[profile].length - 1 },
      attribution,
      material,
      tolerance,
      diagnostics,
      created,
    );
    if (!done.ok) return done;
    strip = [...(created.get('bevel') ?? []), ...(created.get('corner') ?? [])].sort(
      (a, b) => a - b,
    );
  } else {
    const cut = planeStrip(mesh, target.faces, target.plane, half, profile, tolerance);
    if (!cut.ok) return cut;
    const { point, normal } = cut.value;
    strip = cut.value.strip;
    across = (p) => Math.abs(dot(sub(p, point), normal));
  }
  const isEnd = (a: number, b: number) =>
    across(scale(add(mesh.position(a), mesh.position(b)), 0.5)) < half / 2;
  for (const h of region(mesh, strip).boundary) {
    const a = mesh.hVert[h] as number;
    const b = mesh.hVert[mesh.hNext[h] as number] as number;
    if (!isEnd(a, b)) mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
  }
  const before = strip.map((f) => faceNormal(mesh, f));
  const incident = incidentNormals(mesh, strip);
  const roleOf = new Map<number, string>();
  const neighbours = new Set<number>();
  if (profile === 'square') {
    const limit = options.depth * MITER_LIMIT;
    const targets = new Map<number, Tuple3>();
    for (const [v, normals] of incident) {
      let move = planeOffset(normals, -options.depth);
      const reach = length(move);
      if (reach > limit) move = scale(move, limit / reach);
      targets.set(v, add(mesh.position(v), move));
    }
    const planes = strip.map((f) => ({
      normal: faceNormal(mesh, f),
      point: faceCentroid(mesh, f),
    }));
    const boundary = region(mesh, strip).boundary.map((h) => ({
      a: mesh.hVert[h] as number,
      b: mesh.hVert[mesh.hNext[h] as number] as number,
    }));
    const ends = new Set(boundary.filter(({ a, b }) => isEnd(a, b)).map(({ a, b }) => `${a},${b}`));
    const done = extrudeRegion(mesh, strip, (v) => targets.get(v));
    if (!done.ok) return done;
    const off = done.value.moved.filter((f, i) => {
      const plane = planes[i] as { normal: Tuple3; point: Tuple3 };
      return (
        Math.abs(dot(sub(faceCentroid(mesh, f), plane.point), plane.normal) + options.depth) >
        tolerance
      );
    });
    if (off.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `${off.length} groove floor face(s) sank by other than depth ${options.depth}: the strip turns a corner or follows a curved surface`,
        detail: { faces: off.length, depth: options.depth },
      });
    }
    const walls = done.value.walls.map((wall, i) => ({
      wall,
      ...(boundary[i] as { a: number; b: number }),
    }));
    const opened = openEnds(mesh, walls, (a, b) => ends.has(`${a},${b}`), tolerance);
    if (!opened.ok) return opened;
    strip = done.value.moved;
    for (const f of strip) roleOf.set(f, 'groove');
    for (const f of opened.value) roleOf.set(f, 'lip');
  } else {
    const moves: [number, Tuple3][] = [];
    for (const [v, normals] of [...incident].sort((x, y) => x[0] - y[0])) {
      const p = mesh.position(v);
      const u = 1 - across(p) / half;
      if (u <= 0) continue;
      moves.push([v, add(p, planeOffset(normals, -options.depth * depthAt(profile, u)))]);
    }
    const inStrip = new Set(strip);
    const moved = new Set(moves.map(([v]) => v));
    for (const f of mesh.faces()) {
      if (!inStrip.has(f) && mesh.faceVertices(f).some((v) => moved.has(v))) neighbours.add(f);
    }
    for (const [v, q] of moves) mesh.setPosition(v, ...q);
    const lips =
      profile === 'u' ? strip.filter((f) => mesh.faceVertices(f).some((v) => !moved.has(v))) : [];
    for (const f of strip) roleOf.set(f, 'groove');
    for (const f of lips) roleOf.set(f, 'lip');
  }
  const collapsed = [...roleOf.keys()].filter((f) => faceArea(mesh, f) <= tolerance * tolerance);
  const turned = strip.filter((f, i) => dot(faceNormal(mesh, f), before[i] as Tuple3) <= 0);
  if (collapsed.length > 0 || turned.length > 0) {
    return err(
      modelingError(
        'model-degenerate',
        'every groove face keeps a non-zero area and its facing',
        {
          collapsed: collapsed.length,
          turned: turned.length,
          width: options.width,
          depth: options.depth,
        },
        'reduce depth or widen the panel line',
      ),
    );
  }
  const bent = [...neighbours].filter((f) => !planar(mesh, f, tolerance));
  const split = planarize(mesh, [
    ...[...roleOf.keys()].filter((f) => !planar(mesh, f, tolerance)),
    ...bent,
  ]);
  if (!split.ok) return split;
  // Pieces can reuse the ids of other split faces: remove every source before adding.
  const assigned = [...split.value].flatMap(([source, pieces]) => {
    const role = roleOf.get(source);
    roleOf.delete(source);
    return role === undefined ? [] : pieces.map((f) => [f, role] as const);
  });
  for (const [f, role] of assigned) roleOf.set(f, role);
  if (bent.length > 0) {
    diagnostics.push({
      severity: 'info',
      message: `${bent.length} face(s) beyond the groove ends were split into triangles to stay planar`,
      detail: { faces: bent.length },
    });
  }
  const counts: RoleCounts = {};
  for (const role of ['groove', 'lip']) {
    const faces = [...roleOf]
      .filter(([, r]) => r === role)
      .map(([f]) => f)
      .sort((x, y) => x - y);
    markRole(mesh, faces, attribution.label, role, counts);
  }
  for (const f of roleOf.keys()) {
    if (material !== undefined) mesh.fMaterial[f] = material;
    if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
    for (const h of mesh.faceHalves(f)) {
      if (!roleOf.has(mesh.hFace[h ^ 1] as number)) {
        mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
      }
    }
  }
  if (closed) {
    const change = facesVolume(mesh, mesh.faces()) - volumeBefore;
    if (change >= 0) {
      diagnostics.push({
        severity: 'warn',
        message: `the closed mesh volume changed by ${change}; a panel line removes material`,
        detail: { volumeChange: change },
      });
    }
  }
  return ok(counts);
}
