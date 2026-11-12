import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type ComputeJobRequest,
  type ComputeJobResult,
  type ComputeOptions,
  type ComputePolicy,
  runComputeJob,
  type VoxelSign,
} from './compute/job';
import { tsProcessBackend } from './compute/process-backend';
import { decodeSdf, type SdfData, sampleSdf } from './compute/voxel-ts';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import { cross, dot, facesVolume, length, sub, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import {
  type Attribution,
  deleteFaces,
  isClosed,
  type OpDiagnostic,
  type RoleCounts,
  requireFinite,
  requirePositive,
  requireSegments,
} from './ops';

const SIGNS: readonly VoxelSign[] = ['winding', 'parity'];
const MAX_SMOOTH = 64;

export interface VoxelizeOptions {
  /** Grid spacing in meters. */
  readonly voxelSize: number;
  /** Narrow band half-width in voxels (>= 1) with exact distances; farther samples clamp to it. */
  readonly band: number;
  /**
   * Inside test (default 'winding': generalized winding number >= 1/2, robust to holes
   * and overlaps; 'parity': signed ray crossings voted over the three grid axes).
   */
  readonly sign?: VoxelSign;
  readonly compute?: ComputePolicy;
  /** Work units for the job (default: the session budget). */
  readonly budget?: number;
}

export interface VoxelSurfaceOptions {
  /** Relaxation sweeps of the surface vertices, each kept inside its cell (default 0). */
  readonly smooth?: number;
  /** Place cell vertices at the dual-contouring minimizer of the crossing planes, keeping edges and corners. */
  readonly sharp?: boolean;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

export interface VoxelMeshOptions extends VoxelSurfaceOptions {
  /** Extracted distance level in meters (default 0); > 0 grows the surface (within the band). */
  readonly iso?: number;
}

interface VoxelFieldOptions extends VoxelSurfaceOptions {
  readonly voxelSize: number;
  /** Narrow band in voxels (default: what the operation needs, at least 2). */
  readonly band?: number;
  readonly sign?: VoxelSign;
}

export interface VoxelUnionOptions extends VoxelFieldOptions {
  /** Blend radius in meters of the smooth union (0: the hard union). */
  readonly radius: number;
}

export interface VoxelOffsetOptions extends VoxelFieldOptions {
  /** Offset distance in meters, outward > 0. */
  readonly distance: number;
}

export type VoxelFillOptions = VoxelFieldOptions;

/**
 * Signed distance grid from `m.voxel.fromMesh`: samples at origin + (i, j, k) *
 * voxelSize (x fastest), negative inside, exact within `band` voxels of the surface
 * and clamped beyond. It remembers the faces it was built from, so `m.voxel.toMesh`
 * can give each output face the tags and material slot of its nearest source face.
 */
export class SdfGrid implements SdfData {
  readonly origin: Tuple3;
  readonly voxelSize: number;
  readonly dims: readonly [number, number, number];
  readonly band: number;
  readonly values: Float64Array;
  readonly nearest: Int32Array;
  /** @internal FXSD bytes of the grid (job input). */
  readonly _bytes: Uint8Array;
  /** @internal FXEM snapshot of the session the grid was built from. */
  readonly _source: Uint8Array;

  /** @internal */
  constructor(data: SdfData, bytes: Uint8Array, source: Uint8Array) {
    this.origin = data.origin;
    this.voxelSize = data.voxelSize;
    this.dims = data.dims;
    this.band = data.band;
    this.values = data.values;
    this.nearest = data.nearest;
    this._bytes = bytes;
    this._source = source;
  }

  /** The grid a failed or skipped fromMesh returns. */
  static readonly empty = new SdfGrid(
    {
      origin: [0, 0, 0],
      voxelSize: 0,
      dims: [0, 0, 0],
      band: 0,
      values: new Float64Array(0),
      nearest: new Int32Array(0),
    },
    new Uint8Array(0),
    new Uint8Array(0),
  );

  get isEmpty(): boolean {
    return this.values.length === 0;
  }

  /** Trilinear distance at p (clamped to the grid box); NaN for the empty grid. */
  sample(p: Tuple3): number {
    return this.isEmpty ? Number.NaN : sampleSdf(this, p);
  }
}

/** Session facts a voxel or remesh job needs. */
export interface ProcessContext extends ComputeOptions {
  readonly policy: ComputePolicy;
  readonly tolerance: number;
  readonly faceBudget: number;
}

export function runProcessJob<K extends 'voxel' | 'remesh'>(
  request: ComputeJobRequest<K>,
  context: ProcessContext,
  options: { readonly compute?: ComputePolicy; readonly budget?: number },
): Result<ComputeJobResult<K>, ModelingError> {
  const budget = options.budget ?? context.budget;
  return runComputeJob(request, tsProcessBackend, {
    policy: options.compute ?? context.policy,
    ...(context.native === undefined ? {} : { native: context.native }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(budget === undefined ? {} : { budget }),
  });
}

/** The info diagnostic every compute-job operation reports. */
export function jobDiagnostic(
  op: string,
  report: ComputeJobResult['report'],
  detail: Readonly<Record<string, unknown>>,
  metrics: Readonly<Record<string, number>> = {},
): OpDiagnostic {
  return {
    severity: 'info',
    message: `${op} ran on the ${report.backend} backend (${report.quality})`,
    detail: {
      ...detail,
      backend: report.backend,
      backendIdentity: report.backendIdentity,
      quality: report.quality,
      cacheKey: report.cacheKey,
      metrics: { ...report.metrics, ...metrics },
    },
  };
}

function checkSurface(options: VoxelSurfaceOptions): Result<void, ModelingError> {
  if (options.smooth !== undefined) {
    const smooth = requireSegments('smooth', options.smooth, 0);
    if (!smooth.ok) return smooth;
    if (options.smooth > MAX_SMOOTH) {
      return err(
        modelingError('model-invalid-argument', `smooth is at most ${MAX_SMOOTH}`, {
          smooth: options.smooth,
        }),
      );
    }
  }
  if (options.sharp !== undefined && typeof options.sharp !== 'boolean') {
    return err(
      modelingError('model-invalid-argument', 'sharp is a boolean', { sharp: options.sharp }),
    );
  }
  return ok(undefined);
}

function checkSign(sign: unknown): Result<VoxelSign, ModelingError> {
  const value = sign ?? 'winding';
  if (!SIGNS.includes(value as VoxelSign)) {
    return err(
      modelingError('model-invalid-argument', `sign is one of ${SIGNS.join(', ')}`, { sign }),
    );
  }
  return ok(value as VoxelSign);
}

/** Session faces as ascending FXEM face indices of `encodeSnapshot(mesh)`. */
function fxemFaces(mesh: EditMesh, faces: readonly number[]): number[] | 'all' {
  if (faces.length === mesh.faceCount) return 'all';
  const { faceMap } = mesh.compact();
  return faces.map((f) => faceMap[f] as number).sort((a, b) => a - b);
}

/**
 * Write a job surface into the session: every face gets the operation's label and
 * role `surface`, the tags and material slot of its nearest source face (or the
 * explicit material), plus the placement tag. Corner values, edge intent, face flags
 * and the source faces' labels do not carry over: the surface is new geometry.
 */
function placeSurface(
  mesh: EditMesh,
  surface: EditMesh,
  provenance: Int32Array | undefined,
  source: EditMesh,
  attribution: Attribution,
  explicitMaterial: boolean,
): Result<{ faces: number; unmapped: number }, ModelingError> {
  const vertexOf = new Map<number, number>();
  for (const v of surface.vertices()) vertexOf.set(v, mesh.addVertex(...surface.position(v)));
  const role = attribution.label === 0 ? 0 : mesh.nameIndex(mesh.roleNames, 'surface');
  const tagOf = source.tagNames.map((name) => mesh.tagIndex(name, true));
  let unmapped = 0;
  for (const [i, f] of surface.faces().entries()) {
    const from = provenance?.[i] ?? -1;
    const known = from >= 0 && source.isFaceAlive(from);
    if (!known) unmapped++;
    const material = explicitMaterial
      ? attribution.material
      : known
        ? mesh.nameIndex(
            mesh.materialNames,
            source.materialNames[source.fMaterial[from] as number] ?? 'Default',
          )
        : 0;
    const added = mesh.addFace(
      surface.faceVertices(f).map((v) => vertexOf.get(v) as number),
      material,
    );
    if (!added.ok) return added;
    const g = added.value;
    mesh.fLabel[g] = attribution.label;
    mesh.fRole[g] = role;
    if (known) {
      for (let t = 0; t < source.tagNames.length; t++) {
        if (source.hasTag(from, t)) mesh.addTag(g, tagOf[t] as number);
      }
    }
    if (attribution.tag >= 0) mesh.addTag(g, attribution.tag);
  }
  return ok({ faces: surface.faceCount, unmapped });
}

/** Hard assertions shared by the surface operations: faces exist, closed, fully mapped. */
function checkJobSurface(
  op: string,
  result: ComputeJobResult<'voxel'>,
): Result<{ surface: EditMesh; provenance: Int32Array }, ModelingError> {
  const decoded = decodeSnapshot(result.outputs[0] ?? new Uint8Array());
  if (!decoded.ok) return decoded;
  const surface = decoded.value;
  if (surface.faceCount === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        `${op} extracts a non-empty iso surface`,
        { metrics: result.report.metrics },
        'no grid sample lies inside at this level: check the sign mode (open input needs winding), lower voxelSize, or adjust iso / distance',
      ),
    );
  }
  const provenance = result.provenance[0]?.face;
  if (provenance === undefined || provenance.length !== surface.faceCount) {
    return err(
      modelingError(
        'model-op-no-effect',
        'the voxel job maps every surface face to a source face or -1',
        { backend: result.report.backend, faces: surface.faceCount },
        'the backend broke the voxel contract; rerun with compute: ts to compare',
      ),
    );
  }
  if (!isClosed(surface)) {
    return err(
      modelingError(
        'model-degenerate',
        `${op} returns a closed surface`,
        { backend: result.report.backend },
        'the backend broke the voxel contract; rerun with compute: ts to compare',
      ),
    );
  }
  return ok({ surface, provenance });
}

export function voxelize(
  mesh: EditMesh,
  faces: readonly number[],
  options: VoxelizeOptions,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<SdfGrid, ModelingError> {
  const h = requirePositive('voxelSize', options.voxelSize);
  if (!h.ok) return h;
  const band = requireSegments('band', options.band, 1);
  if (!band.ok) return band;
  const sign = checkSign(options.sign);
  if (!sign.ok) return sign;
  const input = encodeSnapshot(mesh);
  const job = runProcessJob(
    {
      kind: 'voxel',
      inputs: [input],
      params: {
        operation: 'sdf',
        faces: fxemFaces(mesh, faces),
        voxelSize: h.value,
        band: band.value,
        sign: sign.value,
      },
    },
    context,
    options,
  );
  if (!job.ok) return job;
  const bytes = job.value.outputs[0] ?? new Uint8Array();
  const data = decodeSdf(bytes);
  if (!data.ok) return data;
  const metrics = job.value.report.metrics;
  if ((metrics.insideSamples ?? 0) === 0) {
    diagnostics.push({
      severity: 'warn',
      message:
        "no grid sample is inside the faces: an open sheet or inverted faces bound no volume ('parity' needs closed input; 'winding' tolerates holes)",
      detail: { sign: sign.value, samples: metrics.samples },
    });
  }
  diagnostics.push(
    jobDiagnostic('voxel.fromMesh', job.value.report, {
      voxelSize: h.value,
      band: band.value,
      sign: sign.value,
      dims: data.value.dims,
      origin: data.value.origin,
    }),
  );
  return ok(new SdfGrid(data.value, bytes, input));
}

export function gridToMesh(
  mesh: EditMesh,
  grid: SdfGrid,
  options: VoxelMeshOptions,
  attribution: Attribution,
  explicitMaterial: boolean,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  if (!(grid instanceof SdfGrid) || grid.isEmpty) {
    return err(
      modelingError(
        'model-invalid-argument',
        'grid is a non-empty SdfGrid from m.voxel.fromMesh',
        {},
        'the fromMesh that produced it failed or was skipped; fix that call first',
      ),
    );
  }
  const surfaceOptions = checkSurface(options);
  if (!surfaceOptions.ok) return surfaceOptions;
  const iso = requireFinite('iso', options.iso ?? 0);
  if (!iso.ok) return iso;
  const reach = grid.band * grid.voxelSize;
  if (Math.abs(iso.value) >= reach) {
    return err(
      modelingError(
        'model-invalid-argument',
        `|iso| is below the grid's band (${reach} m)`,
        { iso: iso.value, band: grid.band, voxelSize: grid.voxelSize },
        'rebuild the grid with a wider band',
      ),
    );
  }
  const job = runProcessJob(
    {
      kind: 'voxel',
      inputs: options.sharp === true ? [grid._bytes, grid._source] : [grid._bytes],
      params: {
        operation: 'mesh',
        faces: 'all',
        voxelSize: grid.voxelSize,
        band: grid.band,
        sign: 'winding',
        iso: iso.value,
        ...(options.smooth === undefined ? {} : { smooth: options.smooth }),
        ...(options.sharp === undefined ? {} : { sharp: options.sharp }),
      },
    },
    context,
    options,
  );
  if (!job.ok) return job;
  const checked = checkJobSurface('voxel.toMesh', job.value);
  if (!checked.ok) return checked;
  const source = decodeSnapshot(grid._source);
  if (!source.ok) return source;
  const placed = placeSurface(
    mesh,
    checked.value.surface,
    checked.value.provenance,
    source.value,
    attribution,
    explicitMaterial,
  );
  if (!placed.ok) return placed;
  diagnostics.push(
    jobDiagnostic('voxel.toMesh', job.value.report, {
      iso: iso.value,
      smooth: options.smooth ?? 0,
      sharp: options.sharp ?? false,
      unmappedFaces: placed.value.unmapped,
      lost: 'corner values (UVs, colors), edge intent and source labels; tags and material come from the nearest source face',
    }),
  );
  return ok({ surface: placed.value.faces });
}

export type VoxelSurfaceOperation = 'union' | 'offset' | 'fill';

/** A fill below this fraction of the volume its openings would close (fan caps) warns. */
const FILL_MIN_RATIO = 0.75;

interface Opening {
  readonly center: Tuple3;
  readonly radius: number;
  readonly edges: number;
}

/**
 * The selection's openings (loops of edges with no selected face on the other side)
 * and the volume the faces enclose once each opening is closed by a fan to its centroid.
 */
function cappedOpenings(
  mesh: EditMesh,
  faces: readonly number[],
): { readonly volume: number; readonly openings: readonly Opening[] } {
  const chosen = new Set(faces);
  const byStart = new Map<number, number[]>();
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      if (chosen.has(mesh.hFace[h ^ 1] as number)) continue;
      const a = mesh.hVert[h] as number;
      const list = byStart.get(a);
      if (list === undefined) byStart.set(a, [h]);
      else list.push(h);
    }
  }
  // The caps share the face set's tetrahedron apex, so the capped total is a closed volume.
  const apex: Tuple3 =
    faces.length === 0
      ? [0, 0, 0]
      : mesh.position(mesh.faceVertices(faces[0] as number)[0] as number);
  let volume = facesVolume(mesh, faces, apex);
  const openings: Opening[] = [];
  const used = new Set<number>();
  for (const list of byStart.values()) {
    for (const first of list) {
      if (used.has(first)) continue;
      const loop: number[] = [];
      for (let h: number | undefined = first; h !== undefined && !used.has(h); ) {
        used.add(h);
        loop.push(h);
        h = byStart.get(mesh.hVert[h ^ 1] as number)?.find((next) => !used.has(next));
      }
      const c: Tuple3 = [0, 0, 0];
      for (const h of loop) {
        const p = mesh.position(mesh.hVert[h] as number);
        for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (p[k] as number) / loop.length;
      }
      let radius = 0;
      for (const h of loop) {
        const a = mesh.position(mesh.hVert[h] as number);
        const b = mesh.position(mesh.hVert[h ^ 1] as number);
        radius += length(sub(a, c)) / loop.length;
        // The cap triangle (b, a, c) closes the opening against the face's half-edge a -> b.
        volume += dot(sub(b, apex), cross(sub(a, apex), sub(c, apex))) / 6;
      }
      openings.push({ center: c, radius, edges: loop.length });
    }
  }
  return { volume, openings };
}

/**
 * Replace faces by a voxel surface built from them: the (smooth) union of their
 * vertex-connected parts, their offset, or the closed surface of open input. The
 * unselected faces stay as they are.
 */
export function voxelRebuild(
  mesh: EditMesh,
  faces: readonly number[],
  operation: VoxelSurfaceOperation,
  options: VoxelUnionOptions | VoxelOffsetOptions | VoxelFillOptions,
  attribution: Attribution,
  explicitMaterial: boolean,
  context: ProcessContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const op = operation === 'fill' ? 'voxel.fillHoles' : `voxel.${operation}`;
  const h = requirePositive('voxelSize', options.voxelSize);
  if (!h.ok) return h;
  const sign = checkSign(options.sign);
  if (!sign.ok) return sign;
  const surfaceOptions = checkSurface(options);
  if (!surfaceOptions.ok) return surfaceOptions;
  let reach = 0;
  let radius = 0;
  let distance = 0;
  if (operation === 'union') {
    const r = requireFinite('radius', (options as VoxelUnionOptions).radius);
    if (!r.ok) return r;
    if (r.value < 0) {
      return err(modelingError('model-invalid-argument', 'radius is >= 0', { radius: r.value }));
    }
    radius = r.value;
    reach = radius;
  } else if (operation === 'offset') {
    const d = requireFinite('distance', (options as VoxelOffsetOptions).distance);
    if (!d.ok) return d;
    if (d.value === 0) {
      return err(
        modelingError('model-invalid-argument', 'distance is non-zero', { distance: d.value }),
      );
    }
    distance = d.value;
    reach = Math.abs(distance);
  }
  const needed = Math.max(2, Math.ceil(reach / h.value) + 2);
  let band = needed;
  if (options.band !== undefined) {
    const b = requireSegments('band', options.band, 1);
    if (!b.ok) return b;
    if (b.value < needed) {
      return err(
        modelingError(
          'model-invalid-argument',
          `band is at least ${needed} voxels (the ${operation === 'union' ? 'radius' : 'distance'} plus two voxels)`,
          { band: b.value, needed },
          'omit band to use the minimum',
        ),
      );
    }
    band = b.value;
  }
  const closedBefore = isClosed(mesh);
  const volumeBefore = closedBefore ? facesVolume(mesh, faces) : 0;
  let openEdges = 0;
  const chosen = new Set(faces);
  for (const e of mesh.edges()) {
    const f1 = mesh.hFace[e * 2] as number;
    const f2 = mesh.hFace[e * 2 + 1] as number;
    if ((chosen.has(f1) || chosen.has(f2)) && (f1 < 0 || f2 < 0)) openEdges++;
  }
  const input = encodeSnapshot(mesh);
  const job = runProcessJob(
    {
      kind: 'voxel',
      inputs: [input],
      params: {
        operation,
        faces: fxemFaces(mesh, faces),
        voxelSize: h.value,
        band,
        sign: sign.value,
        ...(operation === 'union' ? { radius } : {}),
        ...(operation === 'offset' ? { distance } : {}),
        ...(options.smooth === undefined ? {} : { smooth: options.smooth }),
        ...(options.sharp === undefined ? {} : { sharp: options.sharp }),
      },
    },
    context,
    options,
  );
  if (!job.ok) return job;
  const checked = checkJobSurface(op, job.value);
  if (!checked.ok) return checked;
  const source = decodeSnapshot(input);
  if (!source.ok) return source;
  const next = mesh.clone();
  const removed = deleteFaces(next, faces);
  if (!removed.ok) return removed;
  const placed = placeSurface(
    next,
    checked.value.surface,
    checked.value.provenance,
    source.value,
    attribution,
    explicitMaterial,
  );
  if (!placed.ok) return placed;
  const surface = checked.value.surface;
  const volumeAfter = facesVolume(surface, surface.faces());
  if (
    operation === 'offset' &&
    closedBefore &&
    Math.sign(volumeAfter - volumeBefore) !== Math.sign(distance)
  ) {
    diagnostics.push({
      severity: 'warn',
      message: `the offset surface ${distance > 0 ? 'lost' : 'gained'} volume against distance ${distance}: the offset is below the voxel resolution`,
      detail: { volumeBefore, volumeAfter, voxelSize: h.value },
    });
  }
  if (operation === 'fill' && openEdges === 0) {
    diagnostics.push({
      severity: 'info',
      message: 'the faces had no open edges; fillHoles only rebuilt them as a voxel surface',
      detail: {},
    });
  } else if (operation === 'fill') {
    const capped = cappedOpenings(mesh, faces);
    if (capped.volume > 0 && volumeAfter < FILL_MIN_RATIO * capped.volume) {
      const at = capped.openings
        .map(
          (o) =>
            `[${o.center.map((x) => Number(x.toFixed(4))).join(', ')}] r ${o.radius.toPrecision(3)}`,
        )
        .join('; ');
      diagnostics.push({
        severity: 'warn',
        message: `voxel.fillHoles enclosed ${((volumeAfter / capped.volume) * 100).toFixed(0)}% of the volume its openings would close: openings this wide (${at}) leave the interior's winding number below 1/2, so the fill is a ring or shell. Close them first (fillHoles or planeCut fillHoles) or fill a narrower part`,
        detail: { volumeAfter, cappedVolume: capped.volume, openings: capped.openings },
      });
    }
  }
  diagnostics.push(
    jobDiagnostic(
      op,
      job.value.report,
      {
        voxelSize: h.value,
        band,
        sign: sign.value,
        ...(operation === 'union' ? { radius } : {}),
        ...(operation === 'offset' ? { distance } : {}),
        smooth: options.smooth ?? 0,
        sharp: options.sharp ?? false,
        sourceFaces: faces.length,
        sourceOpenEdges: openEdges,
        unmappedFaces: placed.value.unmapped,
        lost: 'corner values (UVs, colors), edge intent and source labels; tags and material come from the nearest source face',
      },
      closedBefore ? { volumeBefore, volumeAfter } : { volumeAfter },
    ),
  );
  mesh.assign(next);
  return ok({ surface: placed.value.faces });
}
