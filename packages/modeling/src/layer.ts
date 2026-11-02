import { err, ok, type Result } from '@forgeax/engine-types';
import { duplicateFaces } from './connect';
import { type ModelingError, modelingError } from './errors';
import { add, scale, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import { markRole, type OpDiagnostic, type RoleCounts } from './ops';
import { shell, unitOffsets } from './shell';
import { SurfaceQuery } from './shrinkwrap';

export interface LayerOptions {
  /** Signed gap between the source surface and the layer, along its normals (meters). */
  readonly offset: number;
  /** Wall thickness grown outward from the layer (default 0: a single sheet). */
  readonly thickness?: number;
  /** With a thickness: `closed` (default) joins both sheets with rim quads, `open` leaves them apart. */
  readonly rim?: 'closed' | 'open';
  /**
   * Wrap the offset sheet back to exactly `offset` from the source surface (nearest
   * point, interpolated normals) instead of the per-vertex normal solve, so curved
   * regions keep a constant gap.
   */
  readonly conform?: boolean;
  /** Pass-through of the shell's `clamp` for thicknesses beyond the local feature size. */
  readonly clamp?: boolean;
  /** Pass-through of the shell's `taper`: the wall thins to nothing at the layer's edges (no rim). */
  readonly taper?: number;
}

const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

/**
 * Region offset shell (garment, liner, armor plate over a body): a copy of the faces
 * moves `offset` along the region normals and, with a thickness, grows a wall outward.
 * The source faces never change. Roles: `layer` (the sheet, the outer wall with a
 * thickness), `inner` and `rim`; copies drop the source tags (they are new parts) and
 * keep material slots, corner values and edge intent.
 */
export function layer(
  mesh: EditMesh,
  faces: readonly number[],
  options: LayerOptions,
  label: number,
  tag: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const offset = options?.offset;
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return invalid('offset is a finite length', { offset });
  }
  const thickness = options.thickness ?? 0;
  if (!Number.isFinite(thickness) || thickness < 0) {
    return invalid('thickness is a finite length >= 0', { thickness });
  }
  const rim = options.rim ?? 'closed';
  if (rim !== 'closed' && rim !== 'open') return invalid("rim is 'closed' or 'open'", { rim });
  if (options.taper !== undefined && (thickness === 0 || options.rim === 'open')) {
    return invalid('taper applies to a closed layer with a thickness', {
      taper: options.taper,
      thickness,
      rim: options.rim,
    });
  }
  if (options.rim !== undefined && thickness === 0) {
    return invalid('rim applies to a layer with a thickness', { rim, thickness });
  }
  if (offset === 0 && thickness === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'a layer has an offset or a thickness',
        { offset, thickness },
        'pass offset (the gap to the surface) or thickness, or use duplicate()',
      ),
    );
  }
  const surface = options.conform === true ? SurfaceQuery.of(mesh, faces) : undefined;
  if (surface !== undefined && !surface.ok) return surface;
  const backup = mesh.clone();
  const copied = duplicateFaces(mesh, faces);
  if (!copied.ok) return copied;
  const copies = copied.value;
  for (const f of copies) mesh.fTags.fill(0, f * mesh.tagWords, (f + 1) * mesh.tagWords);
  if (tag >= 0) for (const f of copies) mesh.addTag(f, tag);
  const counts: RoleCounts = {};
  markRole(mesh, copies, label, 'layer', counts);

  let gap = { min: offset, max: offset };
  if (offset !== 0) {
    const offsets = unitOffsets(mesh, copies);
    if (!offsets.ok) {
      mesh.assign(backup);
      return offsets;
    }
    const moved = new Map<number, Tuple3>();
    for (const [v, unit] of offsets.value.unit) {
      moved.set(v, add(mesh.position(v), scale(unit, offset)));
    }
    if (surface?.ok) {
      gap = { min: Infinity, max: -Infinity };
      for (const [v, p] of moved) {
        const hit = surface.value.below(p);
        if (hit === undefined) continue;
        const placed = add(hit.point, scale(hit.normal, offset));
        moved.set(v, placed);
        // The gap actually reached: the distance from the placed vertex to the source.
        const reached = surface.value.nearest(placed)?.distance ?? hit.distance;
        gap.min = Math.min(gap.min, reached);
        gap.max = Math.max(gap.max, reached);
      }
    }
    const off = Math.abs(offset);
    if (surface?.ok && Number.isFinite(gap.min) && (gap.min < off * 0.9 || gap.max > off * 1.1)) {
      diagnostics.push({
        severity: 'warn',
        message: `conform reached gaps of ${gap.min.toPrecision(3)}..${gap.max.toPrecision(3)} m for offset ${offset}: a concave region pulls the layer closer than its offset`,
        detail: { gap, offset },
      });
    }
    for (const [v, p] of moved) mesh.setPosition(v, ...p);
    if (offsets.value.mitered.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `${offsets.value.mitered.length} layer vertex offset(s) clamped at the miter limit`,
        detail: {
          vertices: offsets.value.mitered.slice(0, MAX_REPORTED),
          count: offsets.value.mitered.length,
        },
      });
    }
  }

  if (thickness > 0) {
    const created = { inner: [] as number[], rims: [] as number[] };
    const walled = shell(
      mesh,
      copies,
      [],
      {
        thickness,
        direction: 'out',
        ...(options.clamp === undefined ? {} : { clamp: options.clamp }),
        ...(options.taper === undefined ? {} : { taper: options.taper }),
      },
      label,
      tolerance,
      diagnostics,
      created,
    );
    if (!walled.ok) {
      mesh.assign(backup);
      return walled;
    }
    for (const f of [...created.inner, ...created.rims]) {
      mesh.fTags.fill(0, f * mesh.tagWords, (f + 1) * mesh.tagWords);
      if (tag >= 0) mesh.addTag(f, tag);
    }
    if (rim === 'open') for (const f of created.rims) mesh.removeFace(f);
    counts.inner = created.inner.length;
    if (rim === 'closed' && created.rims.length > 0) counts.rim = created.rims.length;
  }
  const boundary = copies.reduce(
    (n, f) => n + mesh.faceHalves(f).filter((h) => (mesh.hFace[h ^ 1] as number) === NONE).length,
    0,
  );
  diagnostics.push({
    severity: 'info',
    message: `layer of ${copies.length} faces at ${offset} m${thickness > 0 ? `, ${thickness} m thick` : ''}`,
    detail: {
      faces: copies.length,
      offset,
      thickness,
      ...(thickness > 0 ? { rim } : {}),
      ...(options.conform === true ? { gap } : {}),
      openEdges: boundary,
    },
  });
  return ok(counts);
}
