import { maxOf, minOf, pushAll } from './arrays';
import { type BakeValidateOptions, checkBake } from './bake-checks';
import { measureUv } from './compute/uv-ts';
import type { DrawingCheckOptions } from './drawing-check';
import type { EdgeFlowOptions } from './edge-flow';
import {
  cross,
  dot,
  faceArea,
  faceNormal,
  facesVolume,
  length,
  sub,
  type Tuple3,
  triangulateLoop,
  windingNumber,
} from './geom';
import {
  contactTolerance,
  type DesignedContact,
  FIT_TOLERANCE,
  pairInterference,
  partDistance,
  partGeometry,
} from './interference';
import { components, faceContacts } from './intersect';
import type { LayoutCheckOptions } from './layout';
import { type EditMesh, NONE } from './mesh';
import { type MeshQualityLimits, meshQuality } from './mesh-quality';
import { regionGroups } from './ops';
import { orient2d, trianglesOverlap2d } from './predicates';
import { sliverFaces } from './repair';
import { type Coverage, coverageOf, type Issue, type UncheckedReason } from './report';
import type { ShutLineOptions } from './shut-lines';
import type { SurfaceQualityOptions } from './surface-quality';
import { faceThickness } from './thickness';
import { checkWatertight, type WatertightOptions, type WatertightReport } from './watertight';

export type ValidationCode =
  | 'topology-twin'
  | 'topology-loop'
  | 'topology-dead-reference'
  | 'face-degenerate'
  | 'face-nonplanar'
  | 'mesh-open'
  | 'mesh-inverted'
  | 'face-flipped'
  | 'self-intersection'
  | 'shell-overlap'
  | 'designed-contact'
  | 't-junction'
  | 'thin-wall'
  | 'isolated-vertex'
  | 'uv-missing'
  | 'uv-degenerate'
  | 'uv-overlap'
  | 'surface-quality'
  | 'edge-flow'
  | 'mesh-quality'
  | 'patch-layout'
  | 'shut-line'
  | 'bake'
  | 'texel-density'
  | 'drawing';

/** Opt-in checks whose threshold or intent depends on the asset. */
export interface ValidateOptions {
  /** Report faces whose wall (distance to the next surface behind them) is thinner (meters). */
  readonly minThickness?: number;
  /**
   * Gate zero slivers: every face narrower than this (meters, height over the longest
   * edge: the faces `cleanup.slivers` removes) is one `face-degenerate` error with
   * `detail.reason: 'sliver'`, the count and the first faces. A width that is not a finite
   * length above 0 is the same error with `reason: 'invalid-width'`. `part` (a face tag, else
   * a label, as for `quality`) limits the check to that part; an unknown part is the same
   * error with `reason: 'unknown-part'`.
   */
  readonly slivers?: { readonly width: number; readonly part?: string };
  /**
   * Gate the union-then-triangulate-once rule: a surface built from several overlapping
   * bodies is one component, with its intersection curves resolved, before any triangle
   * leaves the session (`lowpoly`, `boolean`). Faces of different edge-connected components
   * that cross are one `shell-overlap` error with `detail.reason: 'crossing'` (the signature of
   * instances appended or triangulated separately: no shared edge at the join, a crack or a
   * non-manifold weld at export), the crossing count, the first face pairs with their component
   * indices, and the component list (`faces`, `closed`). `expected` is the number of components
   * the design intends (separate hoses, rams, springs and rods count); another number is a
   * `shell-overlap` warning with `detail.reason: 'component-count'`.
   */
  readonly shells?: { readonly expected?: number };
  /** The asset needs non-overlapping uv0 (lightmaps, baking): report overlapping UV triangles. */
  readonly uniqueUv?: boolean;
  /**
   * Assembly fits: part pairs designed to touch or nest (a tube through a bushing, a pin
   * in its bore, a press fit), each part named by a face tag, or else by a label. Their contact is a
   * `designed-contact` when the measured penetration stays within the pair's tolerance
   * (default 1e-3 m, as for `interference`); deeper, it stays a confirmed crossing.
   */
  readonly contacts?: readonly DesignedContact[];
  /**
   * Check the session's NURBS patches and feature lines (`checkSurfaceQuality`): each
   * failed check is a `surface-quality` warning whose `detail.check` names it.
   */
  readonly surfaceQuality?: boolean | SurfaceQualityOptions;
  /**
   * Check every declared `patchLayout` (`checkLayout`): the plan, and once built, each
   * declared side as measured. Each finding is a `patch-layout` warning whose
   * `detail.check` names it.
   */
  readonly layout?: boolean | LayoutCheckOptions;
  /**
   * Measure the shut lines of a DTS table (`measureShutLines`): each row that fails, an
   * unmeasured one included, is a `shut-line` error with its failed checks and measurements;
   * an excepted row and a stale exception limit are `shut-line` warnings.
   */
  readonly shutLines?: ShutLineOptions;
  /**
   * Watertightness per part (`part:` face tag, else connected component): maximal chains of
   * free (naked) edges and of shelled panels' outer edges (skin against its own shell wall),
   * each with its `gap` to the facing edge elsewhere within `radius` and its partner, plus the
   * `crossPart` seams between parts. A chain that no trim, DTS row (`shutLines` table first,
   * else `table`; gap or clearance row) or `open` edge declares is a `mesh-open` error, as is a
   * cross-part seam without a row; T-junctions are errors per part. The summary is
   * `report.watertight`. Mesh gaps below the weld/snap distance are collapsed by tessellation;
   * NURBS seam gaps and weld moves come with the edge-first seam table. The T-junction reach is max(tolerance,
   * 0.2 % of the edge): wider cracks show as chains, not T-junctions.
   */
  readonly watertight?: true | WatertightOptions;
  /**
   * Check the session state against its design drawings (`m.drawing`): each failed section,
   * silhouette, feature or dimension check is a `drawing` warning whose `detail.check` names
   * it (`DrawingFinding`). Tolerances are the items' own.
   */
  readonly drawing?: boolean | DrawingCheckOptions;
  /**
   * Check the edge flow (`checkEdgeFlow`) against the session's feature lines: `edge-flow`
   * warnings for feature lines without a continuous edge loop, stretched faces and size
   * jumps, infos for triangles and poles; `detail.check` names the check.
   */
  readonly edgeFlow?: boolean | EdgeFlowOptions;
  /**
   * Triangle tiling gates (`meshQuality`): each part (a face tag, else a label) that exceeds
   * its limits (default the R5 faceting thresholds) is a `mesh-quality` warning with the
   * failed limits and the measured report; an unknown part is a warning too.
   */
  /**
   * Bake pitfalls (BK-V): each finding is a `bake` warning whose
   * `detail.check` names the check; `true` runs every check with the default settings.
   */
  readonly bake?: true | BakeValidateOptions;
  readonly quality?: readonly {
    readonly part: string;
    readonly limits?: Partial<MeshQualityLimits>;
  }[];
  /**
   * Texel density budget: every UV island's density, the one `measureUv` /
   * `uv.pack` / `uv.trim` measure (resolution x sqrt(UV area / 3D area)), within
   * `tolerance` (default 0.2) of `target` texels per meter. Islands outside it are one
   * `texel-density` warning with the range and the worst islands; a face without the
   * channel is a `texel-density` warning too.
   */
  readonly texelDensity?: {
    readonly resolution: number;
    readonly target: number;
    readonly tolerance?: number;
    readonly channel?: 'uv0' | 'uv1';
  };
}

/** The `shells` gate: crossings between edge-connected components, and the component count. */
function checkShells(
  mesh: EditMesh,
  crossing: readonly { readonly faces: readonly [number, number] }[],
  expected: number | undefined,
  issues: Issue<ValidationCode>[],
): void {
  const parts = components(mesh);
  const between = crossing
    .map((c) => ({
      faces: c.faces,
      components: [parts.of.get(c.faces[0]), parts.of.get(c.faces[1])],
    }))
    .filter((c) => c.components[0] !== c.components[1]);
  const list = parts.faces.map((f, i) => ({
    component: i,
    faces: f.length,
    closed: parts.closed[i],
  }));
  if (between.length > 0) {
    issues.push({
      code: 'shell-overlap',
      severity: 'error',
      detail: {
        reason: 'crossing',
        crossings: between.length,
        pairs: between.slice(0, MAX_CONTACT_PAIRS),
        components: list,
        hint: 'union the bodies (lowpoly / boolean union) and triangulate the result once',
      },
    });
  }
  if (expected !== undefined && parts.faces.length !== expected) {
    issues.push({
      code: 'shell-overlap',
      severity: 'warn',
      detail: { reason: 'component-count', components: parts.faces.length, expected, list },
    });
  }
}

/** Self-intersection pairs reported in detail (the total is always reported). */
const MAX_CONTACT_PAIRS = 32;

export interface ValidationReport {
  readonly pass: boolean;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly boundaryEdges: number;
  readonly closed: boolean;
  /** Signed volume; meaningful only for closed meshes. */
  readonly volume: number;
  readonly issues: readonly Issue<ValidationCode>[];
  /**
   * What the run looked at, by issue code: faces, declared fits, quality gates, shut-line rows,
   * layouts, drawings, feature lines and shell operations checked, and the ones left out with
   * their reason. A check whose option is off is one `mesh` subject, `not-requested`.
   */
  readonly coverage: Coverage<ValidationCode>;
  /** With `watertight`: free-edge chains and per-part counts. */
  readonly watertight?: WatertightReport;
}

const MESH: readonly string[] = ['mesh'];

type Skipped = { code: ValidationCode; subject: string; reason: UncheckedReason };

/** Coverage of the codes one validation stage owns; its subjects are enumerated before it runs. */
export class CoverageLedger {
  readonly enumerated: Partial<Record<ValidationCode, readonly string[]>> = {};
  readonly evaluated: Partial<Record<ValidationCode, ReadonlySet<string>>> = {};
  readonly skipped: Skipped[] = [];

  /** Every listed subject was evaluated (or only `done` of them). */
  run(code: ValidationCode, subjects: readonly string[], done?: ReadonlySet<string>): void {
    this.enumerated[code] = subjects;
    this.evaluated[code] = done ?? new Set(subjects);
  }

  /** The check did not run on the whole mesh. */
  off(code: ValidationCode, reason: UncheckedReason): void {
    this.enumerated[code] = ['mesh'];
    this.skipped.push({ code, subject: 'mesh', reason });
  }

  skip(code: ValidationCode, subject: string, reason: UncheckedReason): void {
    this.skipped.push({ code, subject, reason });
  }

  coverage(): Coverage<ValidationCode> {
    return coverageOf(this.enumerated, this.evaluated, this.skipped);
  }
}

/** Two stages' coverage in one: subjects of the same code and reason add up. */
export function mergeCoverage(
  a: Coverage<ValidationCode>,
  b: Coverage<ValidationCode>,
): Coverage<ValidationCode> {
  const checked = new Map<ValidationCode, number>();
  for (const c of [...a.checked, ...b.checked])
    checked.set(c.code, (checked.get(c.code) ?? 0) + c.subjects);
  const unchecked = new Map<string, Coverage<ValidationCode>['unchecked'][number]>();
  for (const u of [...a.unchecked, ...b.unchecked]) {
    const key = `${u.code}\n${u.reason}`;
    const had = unchecked.get(key);
    unchecked.set(
      key,
      had === undefined
        ? u
        : {
            ...u,
            subjects: had.subjects + u.subjects,
            sample: [...had.sample, ...u.sample].slice(0, 8),
          },
    );
  }
  return {
    checked: [...checked].map(([code, subjects]) => ({ code, subjects })),
    unchecked: [...unchecked.values()],
  };
}

/**
 * Check the half-edge invariants and the geometric facts that the modeling
 * contract relies on. Errors mean the mesh breaks a kernel invariant; warnings
 * are asset-quality facts the author should look at.
 */
export function validateMesh(
  mesh: EditMesh,
  tolerance: number,
  options: ValidateOptions = {},
): ValidationReport {
  const issues: Issue<ValidationCode>[] = [];
  const faces = mesh.faces();
  const ledger = new CoverageLedger();
  const faceNames = faces.map(String);
  const planar = new Set<string>();
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    if (halves.length !== (mesh.fLen[f] as number)) {
      issues.push({
        code: 'topology-loop',
        severity: 'error',
        detail: { face: f, expected: mesh.fLen[f], actual: halves.length },
      });
    }
    for (const h of halves) {
      if (
        (mesh.hFace[h] as number) !== f ||
        (mesh.hPrev[mesh.hNext[h] as number] as number) !== h
      ) {
        issues.push({ code: 'topology-loop', severity: 'error', detail: { face: f, half: h } });
      }
      const v = mesh.hVert[h] as number;
      if (!mesh.isVertexAlive(v)) {
        issues.push({
          code: 'topology-dead-reference',
          severity: 'error',
          detail: { face: f, vertex: v },
        });
      }
      const twin = h ^ 1;
      const next = mesh.hNext[h] as number;
      if ((mesh.hVert[twin] as number) !== (mesh.hVert[next] as number)) {
        issues.push({ code: 'topology-twin', severity: 'error', detail: { half: h } });
      }
    }
    const area = faceArea(mesh, f);
    if (area <= tolerance * tolerance) {
      issues.push({ code: 'face-degenerate', severity: 'error', detail: { face: f, area } });
      continue;
    }
    planar.add(String(f));
    const n = faceNormal(mesh, f);
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const origin = points[0] as [number, number, number];
    const deviation = maxOf(points.map((p) => Math.abs(dot(sub(p, origin), n))));
    if (deviation > tolerance * 10) {
      issues.push({ code: 'face-nonplanar', severity: 'warn', detail: { face: f, deviation } });
    }
    if (triangulateLoop(points) === undefined) {
      // Export would refuse it, and the contact and UV checks cannot sample it.
      issues.push({
        code: 'face-degenerate',
        severity: 'error',
        detail: { face: f, reason: 'self-overlapping' },
      });
    }
  }
  for (const code of [
    'topology-loop',
    'topology-twin',
    'topology-dead-reference',
    'face-degenerate',
  ] as const)
    ledger.run(code, faceNames);
  ledger.run('face-nonplanar', faceNames, planar);
  for (const code of [
    'mesh-open',
    'mesh-inverted',
    'face-flipped',
    'self-intersection',
    't-junction',
    'isolated-vertex',
  ] as const) {
    if (faces.length > 0) ledger.run(code, MESH);
    else ledger.off(code, 'missing-input');
  }
  let boundaryEdges = 0;
  for (const e of mesh.edges()) {
    const a = mesh.hFace[e * 2] as number;
    const b = mesh.hFace[e * 2 + 1] as number;
    if (a === NONE && b === NONE) {
      issues.push({ code: 'topology-dead-reference', severity: 'error', detail: { edge: e } });
    } else if (a === NONE || b === NONE) {
      boundaryEdges++;
    }
  }
  const closed = boundaryEdges === 0 && faces.length > 0;
  const volume = closed ? facesVolume(mesh, faces) : 0;
  if (!closed && faces.length > 0) {
    issues.push({ code: 'mesh-open', severity: 'info', detail: { boundaryEdges } });
  }
  checkOrientation(mesh, faces, issues);
  const tJunctions = tJunctionVertices(mesh, tolerance);
  let watertight: WatertightReport | undefined;
  if (options.watertight === undefined) {
    if (tJunctions.length > 0)
      issues.push({
        code: 't-junction',
        severity: 'warn',
        detail: { count: tJunctions.length, vertices: tJunctions.slice(0, MAX_CONTACT_PAIRS) },
      });
  } else {
    const checked = checkWatertight(
      mesh,
      tolerance,
      options.watertight === true ? {} : options.watertight,
      options.shutLines,
      tJunctions,
    );
    if (checked.ok) {
      watertight = checked.value.report;
      pushAll(issues, checked.value.issues);
    } else
      issues.push({
        code: 'mesh-open',
        severity: 'error',
        detail: { check: 'options', error: checked.error },
      });
  }
  if (options.minThickness !== undefined) {
    checkThickness(mesh, options.minThickness, tolerance, issues);
    ledger.run('thin-wall', MESH);
  } else ledger.off('thin-wall', 'not-requested');
  if (options.slivers !== undefined) checkSlivers(mesh, faces, options.slivers, issues);
  const used = new Set<number>();
  for (const f of faces) for (const v of mesh.faceVertices(f)) used.add(v);
  const isolated = mesh.vertices().filter((v) => !used.has(v));
  if (isolated.length > 0) {
    issues.push({
      code: 'isolated-vertex',
      severity: 'warn',
      detail: { count: isolated.length, vertices: isolated.slice(0, MAX_CONTACT_PAIRS) },
    });
  }
  checkUv(mesh, faces, tolerance, issues);
  const uvReason: UncheckedReason | undefined = mesh.channels.has('uv0')
    ? undefined
    : 'missing-input';
  for (const code of ['uv-missing', 'uv-degenerate'] as const) {
    if (uvReason === undefined) ledger.run(code, MESH);
    else ledger.off(code, uvReason);
  }
  if (options.uniqueUv === true) {
    checkUvOverlap(mesh, faces, issues);
    if (uvReason === undefined) ledger.run('uv-overlap', MESH);
    else ledger.off('uv-overlap', uvReason);
  } else ledger.off('uv-overlap', 'not-requested');
  if (options.bake !== undefined) {
    checkBake(mesh, options.bake, issues);
    ledger.run('bake', MESH);
  } else ledger.off('bake', 'not-requested');
  if (options.texelDensity !== undefined) {
    checkTexelDensity(mesh, options.texelDensity, issues);
    ledger.run('texel-density', MESH);
  } else ledger.off('texel-density', 'not-requested');
  const fits = designedFits(mesh, faces, options.contacts ?? [], tolerance, issues, ledger);
  const gates = options.quality ?? [];
  if (options.quality === undefined) ledger.off('mesh-quality', 'not-requested');
  else {
    const names = gates.map((g) => g.part);
    ledger.enumerated['mesh-quality'] = names;
    ledger.evaluated['mesh-quality'] = new Set<string>();
  }
  for (const gate of gates) {
    const region = partFaces(mesh, faces, gate.part);
    const measured = region.length === 0 ? undefined : meshQuality(mesh, region, gate.limits);
    if (measured === undefined) ledger.skip('mesh-quality', gate.part, 'missing-input');
    else (ledger.evaluated['mesh-quality'] as Set<string>).add(gate.part);
    if (measured === undefined || !measured.ok) {
      issues.push({
        code: 'mesh-quality',
        severity: 'warn',
        detail: {
          part: gate.part,
          ...(measured === undefined
            ? { reason: 'unknown-part' }
            : { reason: 'invalid-limits', error: measured.error.expected }),
        },
      });
    } else if (measured.value.failed.length > 0) {
      issues.push({
        code: 'mesh-quality',
        severity: 'warn',
        detail: { part: gate.part, failed: measured.value.failed, report: measured.value },
      });
    }
  }
  const all = faceContacts(mesh, Number.MAX_SAFE_INTEGER, tolerance).contacts.filter(
    (c) => !fits.some((fit) => fit(c.faces[0], c.faces[1])),
  );
  // Classify every contact first, then cap each class: a cap over the mixed list let touches
  // early in face order push a crossing out of the report (and a gate on warnings passed).
  const crossing = all.filter((c) => c.contact === 'cross');
  const touching = all.filter((c) => c.contact === 'touch');
  const totals = { total: all.length, crossings: crossing.length, touches: touching.length };
  if (crossing.length > 0) {
    issues.push({
      code: 'self-intersection',
      severity: 'warn',
      detail: {
        certainty: 'confirmed',
        pairs: crossing.slice(0, MAX_CONTACT_PAIRS).map((c) => c.faces),
        ...totals,
      },
    });
  }
  if (options.shells !== undefined) {
    checkShells(mesh, crossing, options.shells.expected, issues);
    if (faces.length > 0) ledger.run('shell-overlap', MESH);
    else ledger.off('shell-overlap', 'missing-input');
  } else ledger.off('shell-overlap', 'not-requested');
  if (touching.length > 0) {
    issues.push({
      code: 'self-intersection',
      severity: 'info',
      detail: {
        certainty: 'candidate',
        pairs: touching.slice(0, MAX_CONTACT_PAIRS).map((c) => c.faces),
        ...totals,
      },
    });
  }
  const coverage = ledger.coverage();
  return {
    pass: coverage.checked.length > 0 && issues.every((issue) => issue.severity !== 'error'),
    faces: faces.length,
    edges: mesh.edgeCount,
    vertices: mesh.vertexCount,
    boundaryEdges,
    closed,
    volume,
    issues,
    coverage,
    ...(watertight === undefined ? {} : { watertight }),
  };
}

/** A part of an assembly: the faces tagged `name`, else the faces whose label is `name`. */
function partFaces(mesh: EditMesh, faces: readonly number[], name: string): number[] {
  const tag = mesh.tagIndex(name, false);
  const label = mesh.labelNames.indexOf(name);
  return tag >= 0
    ? faces.filter((f) => mesh.hasTag(f, tag))
    : label > 0
      ? faces.filter((f) => (mesh.fLabel[f] as number) === label)
      : [];
}

/**
 * Measure each declared fit with the `interference` penetration test (surface depth
 * for closed parts) and report it. A fit within its tolerance returns a predicate that
 * excuses the face pairs between its two parts from self-intersection; a deeper one,
 * or a part name that tags no face, is a warning and excuses nothing.
 */
function designedFits(
  mesh: EditMesh,
  faces: readonly number[],
  declared: readonly DesignedContact[],
  tolerance: number,
  issues: Issue<ValidationCode>[],
  ledger: CoverageLedger,
): ((a: number, b: number) => boolean)[] {
  const names = declared.map((c) => c.parts.join('+'));
  const done = new Set<string>();
  ledger.enumerated['designed-contact'] = names;
  ledger.evaluated['designed-contact'] = done;
  const excused: ((a: number, b: number) => boolean)[] = [];
  const reports: Record<string, unknown>[] = [];
  let exceeded = false;
  for (const contact of declared) {
    const [nameA, nameB] = contact.parts;
    const subject = contact.parts.join('+');
    const limit = contactTolerance(contact);
    const part = (name: string) => {
      const set = new Set(partFaces(mesh, faces, name));
      const closed =
        set.size > 0 &&
        [...set].every((f) =>
          mesh.faceHalves(f).every((h) => set.has(mesh.hFace[h ^ 1] as number)),
        );
      return { set, geometry: partGeometry(mesh, name, [...set], closed) };
    };
    const a = part(nameA);
    const b = part(nameB);
    if (a.set.size === 0 || b.set.size === 0) {
      exceeded = true;
      ledger.skip('designed-contact', subject, 'missing-input');
      reports.push({ parts: [nameA, nameB], status: 'unknown-part', tolerance: limit });
      continue;
    }
    done.add(subject);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
    const pair = pairInterference(
      [a.geometry, b.geometry],
      0,
      1,
      { deltas: [identity, identity], relative: () => identity },
      new Map([[nameA < nameB ? `${nameA}\n${nameB}` : `${nameB}\n${nameA}`, limit]]),
      tolerance,
    );
    const depth = pair?.depth ?? 0;
    const within = depth <= limit;
    if (!within) exceeded = true;
    // A fit with a declared band must also sit at its designed distance (a mis-sized bore).
    let distance: number | undefined;
    let mismatch = false;
    if (contact.kind === 'fit' && contact.gap !== undefined) {
      distance = partDistance(
        [a.geometry, b.geometry],
        0,
        1,
        { deltas: [identity, identity], relative: () => identity },
        contact.gap[1] + 0.01,
      );
      mismatch =
        distance < contact.gap[0] - FIT_TOLERANCE || distance > contact.gap[1] + FIT_TOLERANCE;
      if (mismatch) exceeded = true;
    }
    reports.push({
      parts: [nameA, nameB],
      status: !within
        ? 'exceeded'
        : mismatch
          ? 'mismatch'
          : pair === undefined
            ? 'apart'
            : 'within',
      depth,
      tolerance: limit,
      ...(distance === undefined ? {} : { distance, gap: contact.gap }),
    });
    if (within) {
      excused.push((x, y) => (a.set.has(x) && b.set.has(y)) || (a.set.has(y) && b.set.has(x)));
    }
  }
  if (reports.length > 0) {
    issues.push({
      code: 'designed-contact',
      severity: exceeded ? 'warn' : 'info',
      detail: { fits: reports },
    });
  }
  return excused;
}

/** A UV triangle below this fraction of the area its 3D size predicts has collapsed. */
const UV_COLLAPSE = 1e-3;

/**
 * UV facts on uv0 when the channel exists: faces with unset corners (export would
 * refuse them) and faces whose UV triangles collapse: UV area below UV_COLLAPSE of
 * the area the channel's own scale (UV area over 3D area) predicts, so a correctly
 * mapped face that is merely small in a normalized atlas is no defect. A triangle
 * already degenerate in 3D at the tolerance (corners closer than it, or an area of at
 * most its square, as face-degenerate measures faces) may map to a point.
 */
function checkUv(
  mesh: EditMesh,
  faces: readonly number[],
  tolerance: number,
  issues: Issue<ValidationCode>[],
): void {
  if (!mesh.channels.has('uv0')) return;
  let missing = 0;
  const degenerate: number[] = [];
  const triangles: { face: number; uv: number; doubled: number; short: boolean }[] = [];
  let areaUv = 0;
  let area3d = 0;
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const uvs = halves.map((h) => mesh.corner('uv0', h));
    if (uvs.some((uv) => uv === undefined)) {
      missing++;
      continue;
    }
    const points = halves.map((h) => mesh.position(mesh.hVert[h] as number));
    const tris = triangulateLoop(points);
    if (tris === undefined) continue;
    for (let i = 0; i < tris.length; i += 3) {
      const ids = [0, 1, 2].map((k) => tris[i + k] as number);
      const [a, b, c] = ids.map((k) => uvs[k] as Float32Array) as [
        Float32Array,
        Float32Array,
        Float32Array,
      ];
      const [p, q, r] = ids.map((k) => points[k]) as [Tuple3, Tuple3, Tuple3];
      const uv =
        ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
        ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number));
      const doubled = length(cross(sub(q, p), sub(r, p)));
      areaUv += Math.abs(uv);
      area3d += doubled;
      const short =
        doubled / 2 <= tolerance * tolerance ||
        length(sub(q, p)) < tolerance ||
        length(sub(r, q)) < tolerance ||
        length(sub(p, r)) < tolerance;
      triangles.push({ face: f, uv, doubled, short });
    }
  }
  const scale = area3d > 0 ? areaUv / area3d : 0;
  for (const t of triangles) {
    if (t.short || Math.abs(t.uv) > UV_COLLAPSE * scale * t.doubled) continue;
    if (degenerate.at(-1) === t.face) continue;
    degenerate.push(t.face);
  }
  if (missing > 0)
    issues.push({ code: 'uv-missing', severity: 'info', detail: { faces: missing } });
  if (degenerate.length > 0) {
    issues.push({
      code: 'uv-degenerate',
      severity: 'warn',
      detail: { count: degenerate.length, faces: degenerate.slice(0, MAX_CONTACT_PAIRS) },
    });
  }
}

/**
 * Orientation facts. A closed component with negative volume is inverted unless it
 * is a cavity, that is enclosed by the rest of the mesh (winding number > 1/2). A
 * face pair whose open edges coincide in position and run the same direction is a
 * flipped patch: welded, the two faces would traverse their shared edge the same way.
 */
function checkOrientation(
  mesh: EditMesh,
  faces: readonly number[],
  issues: Issue<ValidationCode>[],
) {
  const components = regionGroups(mesh, faces, 'perIsland');
  const inverted: { faces: number; volume: number }[] = [];
  for (const component of components) {
    const isClosed = component.every((f) =>
      mesh.faceHalves(f).every((h) => (mesh.hFace[h ^ 1] as number) !== NONE),
    );
    if (!isClosed) continue;
    const volume = facesVolume(mesh, component);
    if (volume >= 0) continue;
    const inside = new Set(component);
    const others = faces.filter((f) => !inside.has(f));
    const probe = mesh.position(mesh.faceVertices(component[0] as number)[0] as number);
    if (others.length > 0 && windingNumber(mesh, others, probe) > 0.5) continue;
    inverted.push({ faces: component.length, volume });
  }
  if (inverted.length > 0) {
    issues.push({
      code: 'mesh-inverted',
      severity: 'error',
      detail: {
        components: inverted.length,
        volume: inverted.reduce((s, c) => s + c.volume, 0),
        parts: inverted.slice(0, MAX_CONTACT_PAIRS),
      },
    });
  }
  // Open edges grouped by undirected position: exactly two running the same way is a
  // flipped patch; stacks with both directions (several double-sided pieces) are legal.
  const key = (v: number) => mesh.position(v).join(',');
  const shape = (f: number) => mesh.faceVertices(f).map(key).sort().join('|');
  const open = new Map<string, number[]>();
  for (const e of mesh.edges()) {
    for (const h of [e * 2, e * 2 + 1]) {
      if ((mesh.hFace[h] as number) !== NONE) continue;
      const a = key(mesh.hVert[h] as number);
      const b = key(mesh.hVert[h ^ 1] as number);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = open.get(k) ?? [];
      list.push(h);
      open.set(k, list);
    }
  }
  const flipped: [number, number][] = [];
  for (const halves of open.values()) {
    if (halves.length !== 2) continue;
    const [h, g] = halves as [number, number];
    if (key(mesh.hVert[h] as number) !== key(mesh.hVert[g] as number)) continue;
    const pair: [number, number] = [mesh.hFace[h ^ 1] as number, mesh.hFace[g ^ 1] as number];
    // Coincident duplicates also run the same way; self-intersection reports them.
    if (shape(pair[0]) !== shape(pair[1])) flipped.push(pair);
  }
  if (flipped.length > 0) {
    issues.push({
      code: 'face-flipped',
      severity: 'warn',
      detail: {
        certainty: 'confirmed',
        edges: flipped.length,
        pairs: flipped.slice(0, MAX_CONTACT_PAIRS),
      },
    });
  }
}

/**
 * Open-boundary vertices that lie strictly inside another open edge: the faces meet
 * geometrically but not topologically, which leaves a crack in the render (T-junction).
 * The reach is relative (0.2 % of the edge, at least `tolerance`): on a curved seam the
 * T-vertex lies on the curve while the edge is its chord.
 */
function tJunctionVertices(mesh: EditMesh, tolerance: number): number[] {
  const edges: { a: number; b: number; lo: number; hi: number; reach: number }[] = [];
  const vertices = new Set<number>();
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const [a, b] = mesh.edgeVertices(e);
    vertices.add(a);
    vertices.add(b);
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    const reach = Math.max(tolerance, 0.002 * length(sub(pb, pa)));
    edges.push({
      a,
      b,
      lo: Math.min(pa[0], pb[0]) - reach,
      hi: Math.max(pa[0], pb[0]) + reach,
      reach,
    });
  }
  if (edges.length === 0) return [];
  edges.sort((x, y) => x.lo - y.lo);
  const maxReach = maxOf(edges.map((e) => e.reach));
  const found: number[] = [];
  for (const v of [...vertices].sort((x, y) => x - y)) {
    const p = mesh.position(v);
    for (const edge of edges) {
      if (edge.lo > p[0] + maxReach) break;
      if (edge.hi < p[0] || edge.lo > p[0] || edge.a === v || edge.b === v) continue;
      const pa = mesh.position(edge.a);
      const d = sub(mesh.position(edge.b), pa);
      const span = dot(d, d);
      const t = dot(sub(p, pa), d) / span;
      const len = Math.sqrt(span);
      if (t * len <= edge.reach || (1 - t) * len <= edge.reach) continue;
      const q = sub(p, [pa[0] + d[0] * t, pa[1] + d[1] * t, pa[2] + d[2] * t]);
      if (length(q) <= edge.reach) {
        found.push(v);
        break;
      }
    }
  }
  return found;
}

function checkSlivers(
  mesh: EditMesh,
  faces: readonly number[],
  { width, part }: { readonly width: number; readonly part?: string },
  issues: Issue<ValidationCode>[],
) {
  const fail = (detail: Record<string, unknown>) =>
    issues.push({ code: 'face-degenerate', severity: 'error', detail });
  if (!(Number.isFinite(width) && width > 0)) {
    fail({ reason: 'invalid-width', width });
    return;
  }
  const region = part === undefined ? faces : partFaces(mesh, faces, part);
  if (part !== undefined && region.length === 0) {
    fail({ reason: 'unknown-part', part });
    return;
  }
  const found = sliverFaces(mesh, region, width);
  if (found.length === 0) return;
  fail({
    reason: 'sliver',
    width,
    ...(part === undefined ? {} : { part }),
    count: found.length,
    faces: found.slice(0, MAX_CONTACT_PAIRS),
  });
}

function checkThickness(
  mesh: EditMesh,
  minThickness: number,
  tolerance: number,
  issues: Issue<ValidationCode>[],
) {
  const thin = [...faceThickness(mesh, minThickness, tolerance)].filter(
    ([, d]) => d < minThickness,
  );
  if (thin.length === 0) return;
  issues.push({
    code: 'thin-wall',
    severity: 'warn',
    detail: {
      minThickness,
      count: thin.length,
      thinnest: minOf(thin.map(([, d]) => d)),
      faces: thin.map(([f]) => f).slice(0, MAX_CONTACT_PAIRS),
    },
  });
}

/** uv0 triangles of different faces whose interiors overlap (exact 2D predicates). */
function checkUvOverlap(mesh: EditMesh, faces: readonly number[], issues: Issue<ValidationCode>[]) {
  if (!mesh.channels.has('uv0')) return;
  type UvTriangle = { face: number; p: number[][]; lo: number; hi: number };
  const tris: UvTriangle[] = [];
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const uvs = halves.map((h) => mesh.corner('uv0', h));
    if (uvs.some((uv) => uv === undefined)) continue;
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const p = [0, 1, 2].map((k) => Array.from(uvs[indices[i + k] as number] as Float32Array));
      const turn = orient2d(
        p[0]?.[0] as number,
        p[0]?.[1] as number,
        p[1]?.[0] as number,
        p[1]?.[1] as number,
        p[2]?.[0] as number,
        p[2]?.[1] as number,
      );
      if (turn === 0) continue;
      if (turn < 0) p.reverse();
      const us = p.map((q) => q[0] as number);
      tris.push({ face: f, p, lo: minOf(us), hi: maxOf(us) });
    }
  }
  tris.sort((a, b) => a.lo - b.lo);
  const pairs = new Set<string>();
  for (let i = 0; i < tris.length; i++) {
    const a = tris[i] as UvTriangle;
    for (let j = i + 1; j < tris.length; j++) {
      const b = tris[j] as UvTriangle;
      if (b.lo >= a.hi) break;
      if (a.face === b.face) continue;
      const key = a.face < b.face ? `${a.face},${b.face}` : `${b.face},${a.face}`;
      if (pairs.has(key) || !trianglesOverlap2d(a.p, b.p)) continue;
      pairs.add(key);
    }
  }
  if (pairs.size > 0) {
    issues.push({
      code: 'uv-overlap',
      severity: 'warn',
      detail: {
        pairs: pairs.size,
        faces: [...pairs].slice(0, MAX_CONTACT_PAIRS).map((k) => k.split(',').map(Number)),
      },
    });
  }
}

/** Islands outside the density budget, as one `texel-density` warning. */
function checkTexelDensity(
  mesh: EditMesh,
  budget: NonNullable<ValidateOptions['texelDensity']>,
  issues: Issue<ValidationCode>[],
): void {
  const tolerance = budget.tolerance ?? 0.2;
  const channel = budget.channel ?? 'uv0';
  const measured = measureUv(mesh, channel);
  if (!measured.ok) {
    issues.push({
      code: 'texel-density',
      severity: 'warn',
      detail: { check: 'missing-channel', channel, ...measured.error.detail },
    });
    return;
  }
  const firstFace = new Map<number, number>();
  for (const [f, island] of measured.value.faceIsland.entries()) {
    if (island !== NONE && !firstFace.has(island)) firstFace.set(island, f);
  }
  const islands = measured.value.islands.map((x, island) => ({
    island,
    face: firstFace.get(island) as number,
    faces: x.faces,
    density: x.area3d > 0 ? budget.resolution * Math.sqrt(x.areaUv / x.area3d) : 0,
  }));
  const outside = islands.filter((x) => Math.abs(x.density / budget.target - 1) > tolerance);
  if (outside.length === 0) return;
  const densities = islands.map((x) => x.density);
  issues.push({
    code: 'texel-density',
    severity: 'warn',
    detail: {
      target: budget.target,
      tolerance,
      min: minOf(densities),
      max: maxOf(densities),
      islands: islands.length,
      outside: outside.length,
      worst: [...outside]
        .sort(
          (a, b) =>
            Math.abs(b.density / budget.target - 1) - Math.abs(a.density / budget.target - 1),
        )
        .slice(0, MAX_CONTACT_PAIRS),
    },
  });
}
