import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  ComputeJobResult,
  ComputePolicy,
  ConstraintLevel,
  QuadricKind,
  RemeshConstraints,
  RemeshDirection,
  RemeshJobParams,
} from './compute/job';
import type { Flow, FlowGuide } from './compute/line-field';
import { append } from './connect';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import { faceArea, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { type OpDiagnostic, type RoleCounts, requirePositive, requireSegments } from './ops';
import type { EdgeSelector } from './selectors';
import { type PerspectiveView, perspectiveFrame } from './views';
import { jobDiagnostic, type ProcessContext, runProcessJob } from './voxel';

/**
 * How a feature class constrains simplify and remesh (design 5.6): `true` keeps its
 * curves (vertices slide along them, curve ends stay), `'pin'` also freezes every
 * vertex and edge on them, `false` lets the operation change them freely.
 */
export type PreserveLevel = boolean | 'pin';

export interface PreserveOptions {
  /** Open mesh boundaries (default true). */
  readonly boundaries?: PreserveLevel;
  /** Edges marked sharp (default true). */
  readonly sharp?: PreserveLevel;
  /** Borders between faces of different label, role or tags (default true). */
  readonly labels?: PreserveLevel;
  /** Marked seams and edges where corner values (UVs, colors) are discontinuous (default true). */
  readonly uvSeams?: PreserveLevel;
  /** Borders between material slots (default true). */
  readonly materials?: PreserveLevel;
}

export interface SimplifyOptions {
  /**
   * Stop once the processed faces are at most this many triangles: export triangles, so a
   * quad counts 2 (`lowpoly` targetFaces means the same).
   */
  readonly targetFaces?: number;
  /** Stop before a collapse whose RMS distance to the merged planes exceeds this (meters). */
  readonly maxError?: number;
  /** Error terms (default 'volume': plane quadrics with a volume-preserving collapse position). */
  readonly quadric?: QuadricKind;
  /**
   * Refuse any collapse that brings a triangle closer than this (meters) to one it shares no
   * vertex with, among the processed faces and every face around them, unless the pair was
   * already that close: layered parts and thin shells never touch or cross.
   */
  readonly clearance?: number;
  /** Refuse collapses that leave a triangle above this aspect (unless its star was already worse). */
  readonly maxAspect?: number;
  /** Refuse collapses that give a vertex more neighbours than this (fans). */
  readonly maxValence?: number;
  /**
   * Keep the outline seen from these views (image-driven simplification): the quadric of every vertex on a contour generator (front- and
   * back-facing triangles around it, seen from a view's eye) weighs 1 + `weight` (> 0), so
   * collapses move it last. `maxError` and the report's collapse error are weighted too.
   */
  readonly silhouette?: { readonly views: readonly PerspectiveView[]; readonly weight: number };
  readonly preserve?: PreserveOptions;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

/** `cleanup.tiling`: flips toward Delaunay and needle collapses on a triangulated surface. */
export interface TilingOptions {
  /** Collapse the shortest edge of triangles above this aspect (default 5). */
  readonly maxAspect?: number;
  /** No move takes the surface farther than this from its input (meters). */
  readonly maxError: number;
  /** Flip and collapse passes (1 to 100, default 10); stops early once nothing changes. */
  readonly iterations?: number;
  /** As simplify's: no move brings two surfaces closer than this. */
  readonly clearance?: number;
  /**
   * The remesh's direction (same option, same metric): flips take the diagonal that is
   * shorter in the field's metric, so the cleanup keeps a directed remesh's alignment; caps
   * still flip toward Delaunay. Without it, Delaunay flips.
   */
  readonly direction?: RemeshOptions['direction'];
  readonly preserve?: PreserveOptions;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

export interface RemeshOptions {
  /** Target edge length in meters: edges split above 4/3 and collapse below 4/5 of it. */
  readonly targetEdgeLength: number;
  /** Split / collapse / flip / smooth passes (1 to 100); stops early once nothing changes. */
  readonly iterations: number;
  /** Tangential smoothing speed in [0, 1] (default 0.1). */
  readonly smoothing?: number;
  /** As simplify's: no split, collapse, flip or smoothing move brings two surfaces closer than this. */
  readonly clearance?: number;
  /**
   * Curvature-adaptive lengths: each vertex's length is the chord whose
   * deviation from its bend is `error` meters, between `minEdge` and `targetEdgeLength`;
   * an edge takes the smaller of its ends. Thin rims and tips get short edges.
   */
  readonly adaptive?: { readonly error: number; readonly minEdge: number };
  /**
   * Long edges follow a line field: each guide's `flow` over its faces, or the
   * minimum principal curvature directions. Preserved feature curves (and `constrain` edges)
   * are hard constraints. `anisotropy` is the long over short edge length (at most 6; 1 is
   * the isotropic remesh). Default 1.5, from a window: raising it lowers the long edges'
   * flow angle and raises the aspect median. A perfectly aligned tiling has aspect 1.155 a,
   * so R5's aspect p50 <= 2 caps a near 1.7 (measured 2.06 at 1.6 on a fine tube), and the
   * flow measure skips aspect < 1.5, so below about 1.3 little is measured. A guide may set
   * its own. Where flow lines converge (a radial flow near its point) alignment degrades:
   * the shrinking spacing needs irregular vertices. Give clearance-locked layers the same
   * analytic guide so their fields agree; 'principal' differs between layers.
   */
  readonly direction?: {
    readonly guides: readonly FlowGuide[] | 'principal';
    readonly anisotropy?: number;
    readonly constrain?: EdgeSelector;
  };
  readonly preserve?: PreserveOptions;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

const QUADRICS: readonly QuadricKind[] = ['plane', 'volume', 'attribute'];
/** Without maxError, a simplify Hausdorff above this fraction of the bounding diagonal warns. */
const SIMPLIFY_RELATIVE_DEVIATION = 0.02;

function level(value: unknown, name: string): Result<ConstraintLevel, ModelingError> {
  if (value === undefined || value === true) return ok('slide');
  if (value === false) return ok('free');
  if (value === 'pin') return ok('pin');
  return err(
    modelingError('model-invalid-argument', `preserve.${name} is true, false or 'pin'`, {
      [name]: value,
    }),
  );
}

function constraintsOf(
  preserve: PreserveOptions | undefined,
): Result<RemeshConstraints, ModelingError> {
  const p = preserve ?? {};
  const boundary = level(p.boundaries, 'boundaries');
  if (!boundary.ok) return boundary;
  const sharp = level(p.sharp, 'sharp');
  if (!sharp.ok) return sharp;
  const label = level(p.labels, 'labels');
  if (!label.ok) return label;
  const seam = level(p.uvSeams, 'uvSeams');
  if (!seam.ok) return seam;
  const material = level(p.materials, 'materials');
  if (!material.ok) return material;
  return ok({
    boundary: boundary.value,
    sharp: sharp.value,
    label: label.value,
    seam: seam.value,
    material: material.value,
  });
}

function identity(mesh: EditMesh, f: number): string {
  return `${mesh.labelNames[mesh.fLabel[f] as number] ?? ''}/${mesh.roleNames[mesh.fRole[f] as number] ?? ''}`;
}

/**
 * Run a remesh job over faces and replace the session mesh with its result. Hard
 * assertions (design 7.4): the provenance maps every output face to an input face,
 * and with labels preserved every label and role of the processed faces survives.
 */
const finiteVector = (v: unknown) =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const nonZero = (v: Tuple3) => v[0] !== 0 || v[1] !== 0 || v[2] !== 0;

function validFlow(flow: Flow): boolean {
  if (flow === null || typeof flow !== 'object') return false;
  if ('along' in flow) return finiteVector(flow.along) && nonZero(flow.along);
  if ('around' in flow) {
    return (
      finiteVector(flow.around?.axis) &&
      nonZero(flow.around.axis) &&
      finiteVector(flow.around?.center)
    );
  }
  if ('from' in flow) return finiteVector(flow.from);
  if ('curve' in flow)
    return Array.isArray(flow.curve) && flow.curve.length >= 2 && flow.curve.every(finiteVector);
  return false;
}

/** The direction option checked, its selectors resolved to the mesh's face and vertex ids. */
function directionOf(
  mesh: EditMesh,
  direction: RemeshOptions['direction'],
): Result<RemeshDirection | undefined, ModelingError> {
  if (direction === undefined) return ok(undefined);
  const anisotropy = direction.anisotropy ?? 1.5;
  if (!(typeof anisotropy === 'number' && anisotropy >= 1 && anisotropy <= 6)) {
    return err(
      modelingError('model-invalid-argument', 'direction.anisotropy is within [1, 6]', {
        anisotropy,
      }),
    );
  }
  let guides: RemeshDirection['guides'] = 'principal';
  if (direction.guides !== 'principal') {
    if (!Array.isArray(direction.guides) || direction.guides.length === 0) {
      return err(
        modelingError(
          'model-invalid-argument',
          "direction.guides is a non-empty list of { faces?, flow } or 'principal'",
          { guides: direction.guides },
        ),
      );
    }
    const resolved: { faces?: number[]; flow: Flow; anisotropy?: number }[] = [];
    for (const [i, g] of direction.guides.entries()) {
      if (!validFlow(g?.flow)) {
        return err(
          modelingError(
            'model-invalid-argument',
            'a flow: { along } | { around: { axis, center } } | { from } | { curve: at least 2 points }, with finite non-zero vectors',
            { guide: i, flow: g?.flow },
          ),
        );
      }
      if (
        g.anisotropy !== undefined &&
        !(typeof g.anisotropy === 'number' && g.anisotropy >= 1 && g.anisotropy <= 6)
      ) {
        return err(
          modelingError('model-invalid-argument', 'a guide anisotropy is within [1, 6]', {
            guide: i,
            anisotropy: g.anisotropy,
          }),
        );
      }
      const own = g.anisotropy === undefined ? {} : { anisotropy: g.anisotropy };
      if (g.faces === undefined) {
        resolved.push({ flow: g.flow, ...own });
        continue;
      }
      const ids = g.faces.resolve(mesh);
      if (!ids.ok) return ids;
      resolved.push({ faces: ids.value, flow: g.flow, ...own });
    }
    guides = resolved;
  }
  let constrain: number[] | undefined;
  if (direction.constrain !== undefined) {
    const edges = direction.constrain.resolve(mesh);
    if (!edges.ok) return edges;
    constrain = edges.value.flatMap((e) => [
      mesh.hVert[e * 2] as number,
      mesh.hVert[e * 2 + 1] as number,
    ]);
  }
  return ok({ guides, anisotropy, ...(constrain === undefined ? {} : { constrain }) });
}

/** The diagnostic's direction group: guides, anisotropy and the field's constrained vertices and roughness. */
function directionReport(direction: RemeshDirection | undefined, metrics: Record<string, number>) {
  if (direction === undefined) return {};
  return {
    direction: {
      guides: direction.guides === 'principal' ? 'principal' : direction.guides.length,
      anisotropy: direction.anisotropy,
      constrained: metrics.fieldConstrained ?? 0,
      roughness: metrics.fieldRoughness ?? 0,
    },
  };
}

function runRemesh(
  mesh: EditMesh,
  faces: readonly number[],
  params: Omit<RemeshJobParams, 'faces'>,
  context: ProcessContext,
  options: { readonly compute?: ComputePolicy; readonly budget?: number },
): Result<
  { result: ComputeJobResult<'remesh'>; out: EditMesh; processed: number; source: EditMesh },
  ModelingError
> {
  const { faceMap, vertexMap } = mesh.compact();
  const all = faces.length === mesh.faceCount;
  const indices = faces.map((f) => faceMap[f] as number).sort((a, b) => a - b);
  // Direction ids are the mesh's own: the job reads the compacted snapshot.
  const direction = params.direction;
  if (direction !== undefined) {
    params = {
      ...params,
      direction: {
        ...direction,
        guides:
          direction.guides === 'principal'
            ? 'principal'
            : direction.guides.map((g) =>
                g.faces === undefined
                  ? g
                  : { ...g, faces: g.faces.map((f) => faceMap[f] as number) },
              ),
        ...(direction.constrain === undefined
          ? {}
          : { constrain: direction.constrain.map((v) => vertexMap[v] as number) }),
      },
    };
  }
  const input = encodeSnapshot(mesh);
  const source = decodeSnapshot(input);
  if (!source.ok) return source;
  const job = runProcessJob(
    { kind: 'remesh', inputs: [input], params: { ...params, faces: all ? 'all' : indices } },
    context,
    options,
  );
  if (!job.ok) return job;
  const output = decodeSnapshot(job.value.outputs[0] ?? new Uint8Array());
  if (!output.ok) return output;
  const out = output.value;
  const origin = job.value.provenance[0]?.face;
  const outFaces = out.faces();
  const chosen = new Set(all ? source.value.faces() : indices);
  const unmapped =
    origin === undefined || origin.length !== outFaces.length
      ? outFaces.length
      : [...origin].filter((s) => s < 0 || s >= source.value.faceCount).length;
  if (unmapped > 0 || job.value.status === 'partial') {
    return err(
      modelingError(
        'model-op-no-effect',
        'every remeshed face maps back to an input face and the result is manifold',
        {
          backend: job.value.report.backend,
          unmappedFaces: unmapped,
          locations: job.value.locations.slice(0, 8),
        },
        'the backend broke the remesh contract; rerun with compute: ts to compare',
      ),
    );
  }
  if (params.constraints.label !== 'free') {
    const before = new Set([...chosen].map((f) => identity(source.value, f)));
    const after = new Set(
      outFaces.filter((_, i) => chosen.has(origin?.[i] as number)).map((f) => identity(out, f)),
    );
    const lost = [...before].filter((name) => !after.has(name));
    if (lost.length > 0) {
      return err(
        modelingError(
          'model-op-no-effect',
          'every label and role of the processed faces survives',
          { lost },
          'raise targetFaces / lower targetEdgeLength, or pin the label borders',
        ),
      );
    }
  }
  const processed = outFaces.filter((_, i) => chosen.has(origin?.[i] as number)).length;
  return ok({ result: job.value, out, processed, source: source.value });
}

function replaceMesh(mesh: EditMesh, out: EditMesh): Result<void, ModelingError> {
  const next = mesh.clone();
  for (const f of next.faces()) next.removeFace(f);
  for (const v of next.vertices()) next.removeVertex(v);
  const written = append(next, out, {}, { label: 0, material: 0, tag: -1 });
  if (!written.ok) return written;
  mesh.assign(next);
  return ok(undefined);
}

function volumeWarning(
  metrics: Readonly<Record<string, number>>,
  op: string,
  diagnostics: OpDiagnostic[],
) {
  const change = metrics.volumeChange;
  if (change !== undefined && Math.abs(change) > 0.02) {
    diagnostics.push({
      severity: 'warn',
      message: `${op} changed the enclosed volume by ${(change * 100).toFixed(1)}%`,
      detail: { volumeBefore: metrics.volumeBefore, volumeAfter: metrics.volumeAfter },
    });
  }
}

/**
 * QEM simplification (Garland-Heckbert edge collapse) of faces as a `remesh` job.
 * Output faces are triangles that keep the label, role, tags, material and flags of
 * the face they came from; constrained feature curves keep their shape.
 */
export function simplifyFaces(
  mesh: EditMesh,
  faces: readonly number[],
  options: SimplifyOptions,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  if (options.targetFaces === undefined && options.maxError === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'targetFaces or maxError is given',
        {},
        'pass targetFaces (triangles to keep) or maxError (meters)',
      ),
    );
  }
  if (options.targetFaces !== undefined) {
    const target = requireSegments('targetFaces', options.targetFaces, 1);
    if (!target.ok) return target;
  }
  if (options.maxError !== undefined) {
    const max = requirePositive('maxError', options.maxError);
    if (!max.ok) return max;
  }
  if (options.clearance !== undefined) {
    const clearance = requirePositive('clearance', options.clearance);
    if (!clearance.ok) return clearance;
  }
  if (options.maxAspect !== undefined) {
    const maxAspect = requirePositive('maxAspect', options.maxAspect);
    if (!maxAspect.ok) return maxAspect;
  }
  if (options.maxValence !== undefined) {
    const maxValence = requireSegments('maxValence', options.maxValence, 3);
    if (!maxValence.ok) return maxValence;
  }
  const silhouette = options.silhouette;
  if (silhouette !== undefined) {
    const weight = requirePositive('silhouette.weight', silhouette.weight);
    if (!weight.ok) return weight;
    if (
      !Array.isArray(silhouette.views) ||
      silhouette.views.length === 0 ||
      silhouette.views.some((v) => perspectiveFrame(v) === undefined)
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'silhouette.views is a non-empty list of valid perspective views',
          { views: silhouette.views },
        ),
      );
    }
  }
  const quadric = options.quadric ?? 'volume';
  if (!QUADRICS.includes(quadric)) {
    return err(
      modelingError('model-invalid-argument', `quadric is one of ${QUADRICS.join(', ')}`, {
        quadric,
      }),
    );
  }
  const constraints = constraintsOf(options.preserve);
  if (!constraints.ok) return constraints;
  const run = runRemesh(
    mesh,
    faces,
    {
      operation: 'simplify',
      constraints: constraints.value,
      quadric,
      ...(options.targetFaces === undefined ? {} : { targetFaces: options.targetFaces }),
      ...(options.maxError === undefined ? {} : { maxError: options.maxError }),
      ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
      ...(options.maxAspect === undefined ? {} : { maxAspect: options.maxAspect }),
      ...(options.maxValence === undefined ? {} : { maxValence: options.maxValence }),
      ...(silhouette === undefined
        ? {}
        : {
            silhouette: {
              eyes: silhouette.views.map((v) => [v.eye[0], v.eye[1], v.eye[2]] as Tuple3),
              weight: silhouette.weight,
            },
          }),
    },
    context,
    options,
  );
  if (!run.ok) return run;
  const { result, out, processed } = run.value;
  const metrics = result.report.metrics;
  if ((metrics.collapses ?? 0) === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'simplify collapses at least one edge',
        {
          triangles: metrics.trianglesBefore,
          targetFaces: options.targetFaces,
          maxError: options.maxError,
          blockedCollapses: metrics.blockedCollapses,
        },
        'lower targetFaces, raise maxError, or relax preserve',
      ),
    );
  }
  if (options.targetFaces !== undefined && (metrics.trianglesAfter ?? 0) > options.targetFaces) {
    diagnostics.push({
      severity: 'warn',
      message: `simplify stopped at ${metrics.trianglesAfter} triangles above targetFaces ${options.targetFaces}: ${
        metrics.stoppedByMaxError === 1
          ? 'maxError'
          : (metrics.clearanceBlocked ?? 0) > 0
            ? 'constraints, normal-flip and clearance checks'
            : 'constraints and normal-flip checks'
      } blocked further collapses`,
      detail: {
        trianglesAfter: metrics.trianglesAfter,
        blockedCollapses: metrics.blockedCollapses,
      },
    });
  }
  if (options.maxError !== undefined && (metrics.hausdorff ?? 0) > 2 * options.maxError) {
    diagnostics.push({
      severity: 'warn',
      message: `the simplified surface deviates ${metrics.hausdorff} m (Hausdorff), more than twice maxError`,
      detail: { hausdorff: metrics.hausdorff, maxError: options.maxError },
    });
  } else if (
    options.maxError === undefined &&
    (metrics.hausdorffRelative ?? 0) > SIMPLIFY_RELATIVE_DEVIATION
  ) {
    diagnostics.push({
      severity: 'warn',
      message: `the simplified surface deviates ${(metrics.hausdorff ?? 0).toPrecision(3)} m (Hausdorff), ${((metrics.hausdorffRelative ?? 0) * 100).toFixed(1)}% of the bounding diagonal: preserved curves (sharp rims, seams) left the target to coarsen the rest. Simplify before uv.auto (its seams pin the surface), relax preserve, raise targetFaces or pass maxError`,
      detail: {
        hausdorff: metrics.hausdorff,
        hausdorffRelative: metrics.hausdorffRelative,
        limit: SIMPLIFY_RELATIVE_DEVIATION,
      },
    });
  }
  volumeWarning(metrics, 'simplify', diagnostics);
  const replaced = replaceMesh(mesh, out);
  if (!replaced.ok) return replaced;
  diagnostics.push(
    jobDiagnostic('simplify', result.report, {
      quadric,
      constraints: constraints.value,
      ...(options.targetFaces === undefined ? {} : { targetFaces: options.targetFaces }),
      ...(options.maxError === undefined ? {} : { maxError: options.maxError }),
      ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
    }),
  );
  return ok({ simplified: processed });
}

/**
 * Isotropic remeshing (Botsch-Kobbelt) of faces toward one edge length as a `remesh`
 * job; output triangles keep the attributes of their source face, constrained feature
 * curves stay sharp, and every vertex is reprojected onto the input surface.
 */
export function remeshFaces(
  mesh: EditMesh,
  faces: readonly number[],
  options: RemeshOptions,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const length = requirePositive('targetEdgeLength', options.targetEdgeLength);
  if (!length.ok) return length;
  const iterations = requireSegments('iterations', options.iterations, 1);
  if (!iterations.ok) return iterations;
  if (options.iterations > 100) {
    return err(
      modelingError('model-invalid-argument', 'iterations is at most 100', {
        iterations: options.iterations,
      }),
    );
  }
  const smoothing = options.smoothing ?? 0.1;
  if (!(typeof smoothing === 'number' && smoothing >= 0 && smoothing <= 1)) {
    return err(
      modelingError('model-invalid-argument', 'smoothing is within [0, 1]', { smoothing }),
    );
  }
  if (options.clearance !== undefined) {
    const clearance = requirePositive('clearance', options.clearance);
    if (!clearance.ok) return clearance;
  }
  if (options.adaptive !== undefined) {
    const error = requirePositive('adaptive.error', options.adaptive.error);
    if (!error.ok) return error;
    const minEdge = requirePositive('adaptive.minEdge', options.adaptive.minEdge);
    if (!minEdge.ok) return minEdge;
    if (options.adaptive.minEdge > length.value) {
      return err(
        modelingError('model-invalid-argument', 'adaptive.minEdge is at most targetEdgeLength', {
          minEdge: options.adaptive.minEdge,
          targetEdgeLength: length.value,
        }),
      );
    }
  }
  const constraints = constraintsOf(options.preserve);
  if (!constraints.ok) return constraints;
  const direction = directionOf(mesh, options.direction);
  if (!direction.ok) return direction;
  const area = faces.reduce((sum, f) => sum + faceArea(mesh, f), 0);
  // An equilateral triangle of edge L covers sqrt(3)/4 L^2.
  const predicted = Math.ceil(area / ((Math.sqrt(3) / 4) * length.value * length.value));
  const untouched = mesh.faceCount - faces.length;
  if (predicted + untouched > context.faceBudget) {
    return err(
      modelingError(
        'model-work-budget',
        `the remeshed mesh stays within ${context.faceBudget} faces`,
        { predicted, targetEdgeLength: length.value },
        'raise targetEdgeLength or remesh fewer faces',
      ),
    );
  }
  const run = runRemesh(
    mesh,
    faces,
    {
      operation: 'isotropic',
      constraints: constraints.value,
      targetEdgeLength: length.value,
      iterations: iterations.value,
      smoothing,
      ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
      ...(options.adaptive === undefined ? {} : { adaptive: options.adaptive }),
      ...(direction.value === undefined ? {} : { direction: direction.value }),
    },
    context,
    options,
  );
  if (!run.ok) return run;
  const { result, out, processed } = run.value;
  const metrics = result.report.metrics;
  const mean = metrics.edgeLengthMean ?? 0;
  // Adaptive lengths are shorter than the target by design.
  if (options.adaptive === undefined && Math.abs(mean - length.value) > 0.25 * length.value) {
    diagnostics.push({
      severity: 'warn',
      message: `the mean edge length ${mean} m is more than 25% off targetEdgeLength ${length.value} m; constraints or too few iterations hold edges back`,
      detail: { edgeLengthMean: mean, edgesInRange: metrics.edgesInRange },
    });
  }
  volumeWarning(metrics, 'remesh', diagnostics);
  const replaced = replaceMesh(mesh, out);
  if (!replaced.ok) return replaced;
  diagnostics.push(
    jobDiagnostic('remesh', result.report, {
      targetEdgeLength: length.value,
      iterations: iterations.value,
      smoothing,
      constraints: constraints.value,
      ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
      ...(options.adaptive === undefined ? {} : { adaptive: options.adaptive }),
      ...directionReport(direction.value, metrics),
    }),
  );
  return ok({ remeshed: processed });
}

/**
 * Tiling cleanup of triangulated faces (default all) as a `remesh` job: flips toward Delaunay
 * (opposite angles above pi, caps first) that raise the smallest angle (with `direction`:
 * toward the metric-shorter diagonal, caps still Delaunay), and collapses of
 * the shortest edge of triangles above `maxAspect`; feature curves stay, no triangle turns
 * more than 45 degrees, and no move leaves the input by more than `maxError` (or, with
 * `clearance`, approaches another surface).
 */
export function cleanupTiling(
  mesh: EditMesh,
  faces: readonly number[],
  options: TilingOptions,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const maxError = requirePositive('maxError', options.maxError);
  if (!maxError.ok) return maxError;
  const maxAspect = requirePositive('maxAspect', options.maxAspect ?? 5);
  if (!maxAspect.ok) return maxAspect;
  const iterations = requireSegments('iterations', options.iterations ?? 10, 1);
  if (!iterations.ok) return iterations;
  if ((options.iterations ?? 10) > 100) {
    return err(
      modelingError('model-invalid-argument', 'iterations is at most 100', {
        iterations: options.iterations,
      }),
    );
  }
  if (options.clearance !== undefined) {
    const clearance = requirePositive('clearance', options.clearance);
    if (!clearance.ok) return clearance;
  }
  const constraints = constraintsOf(options.preserve);
  if (!constraints.ok) return constraints;
  const direction = directionOf(mesh, options.direction);
  if (!direction.ok) return direction;
  const params = {
    maxError: maxError.value,
    maxAspect: maxAspect.value,
    iterations: iterations.value,
    ...(options.clearance === undefined ? {} : { clearance: options.clearance }),
  };
  const run = runRemesh(
    mesh,
    faces,
    {
      operation: 'tiling',
      constraints: constraints.value,
      ...params,
      ...(direction.value === undefined ? {} : { direction: direction.value }),
    },
    context,
    options,
  );
  if (!run.ok) return run;
  const { result, out, processed } = run.value;
  const metrics = result.report.metrics;
  if ((metrics.flips ?? 0) + (metrics.collapses ?? 0) === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'cleanup.tiling flips or collapses at least one edge',
        { prevented: metrics.prevented, maxAspect: maxAspect.value, maxError: maxError.value },
        'the tiling has nothing to flip or collapse within reach: raise maxError, relax preserve, or skip the cleanup',
      ),
    );
  }
  volumeWarning(metrics, 'cleanup.tiling', diagnostics);
  const replaced = replaceMesh(mesh, out);
  if (!replaced.ok) return replaced;
  diagnostics.push(
    jobDiagnostic('cleanup.tiling', result.report, {
      constraints: constraints.value,
      ...params,
      ...directionReport(direction.value, metrics),
    }),
  );
  return ok({ cleaned: processed });
}
