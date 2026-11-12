import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type ComputeBackend,
  type ComputePolicy,
  runComputeJob,
  type SourceFaceProvenance,
  type SubdivisionBoundary,
  type SubdivisionScheme,
} from './compute/job';
import { subdividedFaceCount, tsSubdivideBackend } from './compute/subdivide-ts';
import { append } from './connect';
import { faceFolded } from './deform';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import { faceArea, faceCentroid, facesVolume } from './geom';
import type { EditMesh } from './mesh';
import { isClosed, type OpDiagnostic, type RoleCounts, requireSegments } from './ops';

export interface SubdivideOptions {
  /** Refinement levels (>= 1); every level splits each refined n-gon into n quads. */
  readonly levels: number;
  /** `catmullClark` (default) smooths toward the limit surface; `simple` only splits. */
  readonly scheme?: SubdivisionScheme;
  /** Open-boundary rule (default `edgeAndCorner`: boundary corners of one face stay put). */
  readonly boundary?: SubdivisionBoundary;
  /**
   * Sharpness of the sharp edges that store no level of their own (OpenSubdiv `eCrease`);
   * default infinite. Edges marked with `markCrease` keep their own. A crease of sharpness s
   * stays a full crease for s - 1 levels and blends smooth and crease rules on the last.
   */
  readonly creaseSharpness?: number;
  /** Backend policy for this call; defaults to the session's `compute`. */
  readonly compute?: ComputePolicy;
  /** Work units for this job; defaults to the session's `budget.work`. */
  readonly budget?: number;
}

export interface SubdivideContext {
  readonly tolerance: number;
  readonly policy: ComputePolicy;
  readonly native?: ComputeBackend;
  readonly signal?: { readonly aborted: boolean };
  readonly budget?: number;
  /** Session face budget; the predicted face count is checked before any work. */
  readonly faceBudget: number;
}

const SCHEMES: readonly SubdivisionScheme[] = ['catmullClark', 'simple'];
const BOUNDARIES: readonly SubdivisionBoundary[] = ['edgeOnly', 'edgeAndCorner'];

function bounds(mesh: EditMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return { min, max };
}

/**
 * Subdivide faces as a compute job (design 4.1): canonical FXEM in, refined FXEM and
 * per-face provenance out. Children keep the material, label, role, tags and flags of
 * their face; corner values interpolate linearly; sharp edges stay creases until their
 * sharpness (infinite by default) is used up.
 * Vertices next to unselected faces stay put, so neighbours only gain edge points.
 */
export function subdivide(
  mesh: EditMesh,
  faces: readonly number[],
  options: SubdivideOptions,
  context: SubdivideContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const levels = requireSegments('levels', options.levels, 1);
  if (!levels.ok) return levels;
  const scheme = options.scheme ?? 'catmullClark';
  const boundary = options.boundary ?? 'edgeAndCorner';
  if (!SCHEMES.includes(scheme)) {
    return err(
      modelingError('model-invalid-argument', `scheme is one of ${SCHEMES.join(', ')}`, { scheme }),
    );
  }
  if (!BOUNDARIES.includes(boundary)) {
    return err(
      modelingError('model-invalid-argument', `boundary is one of ${BOUNDARIES.join(', ')}`, {
        boundary,
      }),
    );
  }
  const sharpness = options.creaseSharpness ?? Infinity;
  if (typeof sharpness !== 'number' || Number.isNaN(sharpness) || sharpness <= 0) {
    return err(
      modelingError('model-invalid-argument', 'creaseSharpness is greater than 0', { sharpness }),
    );
  }
  const { faceMap } = mesh.compact();
  const selected = new Set(faces);
  const all = selected.size === mesh.faceCount;
  const indices = [...selected].map((f) => faceMap[f] as number).sort((a, b) => a - b);
  let corners = 0;
  for (const f of selected) corners += mesh.fLen[f] as number;
  const untouched = mesh.faceCount - selected.size;
  const predicted = subdividedFaceCount(corners, untouched, levels.value, context.faceBudget);
  if (predicted > context.faceBudget) {
    return err(
      modelingError(
        'model-work-budget',
        `the subdivided mesh stays within ${context.faceBudget} faces`,
        { levels: levels.value, corners, predicted },
        'lower levels or subdivide fewer faces',
      ),
    );
  }
  const before = bounds(mesh);
  const closed = isClosed(mesh);
  const volumeBefore = closed ? facesVolume(mesh, mesh.faces()) : 0;
  const area = mesh.faces().reduce((sum, f) => sum + faceArea(mesh, f), 0);
  const input = encodeSnapshot(mesh);
  const source = decodeSnapshot(input);
  if (!source.ok) return source;
  const sourceFaces = source.value.faces();
  const job = runComputeJob(
    {
      kind: 'subdivide',
      inputs: [input],
      params: {
        scheme,
        boundary,
        levels: levels.value,
        faces: all ? 'all' : indices,
        ...(sharpness === Infinity ? {} : { creaseSharpness: sharpness }),
      },
    },
    tsSubdivideBackend,
    {
      policy: options.compute ?? context.policy,
      ...(context.native === undefined ? {} : { native: context.native }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...((options.budget ?? context.budget) === undefined
        ? {}
        : { budget: (options.budget ?? context.budget) as number }),
    },
  );
  if (!job.ok) return job;
  const result = job.value;
  const output = decodeSnapshot(result.outputs[0] ?? new Uint8Array());
  if (!output.ok) return output;
  const out = output.value;
  const outFaces = out.faces();
  const origin = (result.provenance[0] as SourceFaceProvenance | undefined)?.face;
  // Hard assertion (design 7.4): the provenance maps every output face, and each
  // refined n-gon became n x 4^(levels-1) faces while every other face stayed one.
  const chosen = new Set(all ? sourceFaces.map((_, i) => i) : indices);
  const children = new Int32Array(sourceFaces.length);
  let unmapped = origin === undefined || origin.length !== outFaces.length ? outFaces.length : 0;
  if (unmapped === 0 && origin !== undefined) {
    for (const i of origin) {
      if (i < 0 || i >= sourceFaces.length) unmapped++;
      else children[i] = (children[i] as number) + 1;
    }
  }
  const scale = subdividedFaceCount(1, 0, levels.value, Infinity);
  const wrong: number[] = [];
  for (const [i, f] of sourceFaces.entries()) {
    const expected = chosen.has(i) ? (source.value.fLen[f] as number) * scale : 1;
    if ((children[i] as number) !== expected && wrong.length < 32) wrong.push(i);
  }
  if (unmapped > 0 || wrong.length > 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'every selected n-gon is refined into n x 4^(levels-1) faces that map back to it',
        {
          backend: result.report.backend,
          unmappedFaces: unmapped,
          wrongFaces: wrong,
          outputFaces: outFaces.length,
        },
        'the backend broke the subdivide contract; rerun with compute: ts to compare',
      ),
    );
  }
  const slack = context.tolerance * 10;
  const after = bounds(out);
  const outside = [0, 1, 2].filter(
    (k) =>
      (after.min[k] as number) < (before.min[k] as number) - slack ||
      (after.max[k] as number) > (before.max[k] as number) + slack,
  );
  if (outside.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: 'the subdivided surface leaves the bounds of its control cage',
      detail: { axes: outside.map((k) => 'xyz'[k]), before, after },
    });
  }
  const volumeAfter = closed ? facesVolume(out, outFaces) : 0;
  const volumeChange = volumeAfter - volumeBefore;
  const volumeSlack = context.tolerance * area;
  if (closed && scheme === 'catmullClark' && Math.abs(volumeChange) <= volumeSlack) {
    diagnostics.push({
      severity: 'warn',
      message:
        'Catmull-Clark changed no volume: every refined vertex is creased, pinned or on a boundary corner (the result equals a Simple subdivision)',
      detail: { volumeBefore, volumeAfter },
    });
  }
  if (closed && scheme === 'simple' && Math.abs(volumeChange) > volumeSlack) {
    diagnostics.push({
      severity: 'warn',
      message: 'a Simple subdivision moved the surface (its volume changed)',
      detail: { volumeBefore, volumeAfter },
    });
  }
  const folded = outFaces.filter((f) => faceFolded(out, f));
  if (folded.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${folded.length} subdivided face(s) fold over themselves (export would reject them); add support creases where a thin smooth band meets a crease`,
      detail: {
        foldedFaces: folded.length,
        at: folded.slice(0, 32).map((f) => faceCentroid(out, f)),
      },
    });
  }
  const next = mesh.clone();
  for (const f of next.faces()) next.removeFace(f);
  for (const v of next.vertices()) next.removeVertex(v);
  const written = append(next, out, {}, { label: 0, material: 0, tag: -1 });
  if (!written.ok) return written;
  const refinedFaces = outFaces.length - untouched;
  diagnostics.push({
    severity: 'info',
    message: `subdivide ran on the ${result.report.backend} backend (${result.report.quality})`,
    detail: {
      scheme,
      boundary,
      levels: levels.value,
      backend: result.report.backend,
      backendIdentity: result.report.backendIdentity,
      quality: result.report.quality,
      cacheKey: result.report.cacheKey,
      metrics: {
        ...result.report.metrics,
        ...(closed ? { volumeBefore, volumeAfter } : {}),
      },
    },
  });
  mesh.assign(next);
  return ok({ subdivided: refinedFaces });
}
