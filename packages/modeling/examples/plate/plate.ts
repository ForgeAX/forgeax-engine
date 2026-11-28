import * as exact from '@forgeax/engine-modeling/brep';
import { type MeshJob, type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-700 (exact stage), steps 1 to 3. A rectangular plate is built as an analytic
 * Shape, tessellated into the editable mesh, and textured: its two large faces and its
 * four rim faces take separate material slots over one metric uv0 chart (each face keeps
 * the same texels per meter). Steps 4 and later (chained curved holes, fillets) extend
 * this build in their own tasks. Straight-line code: the tools map every journal entry
 * back to its source line.
 */
export interface PlateParameters {
  /** Extent along x (meters). */
  readonly width: number;
  /** Extent along z (meters). */
  readonly depth: number;
  /** Extent along y (meters). */
  readonly thickness: number;
}

export const PLATE_DEFAULTS: PlateParameters = { width: 0.24, depth: 0.16, thickness: 0.012 };

/** Material slots of step 3. */
export const PLATE_SLOTS = { face: 'plate-face', rim: 'plate-rim' } as const;

/** Export options of the published mesh: auto-smooth at 40 degrees, so every right-angle plate edge stays hard. */
export const PLATE_EXPORT = { normals: { mode: 'autoSmooth', angle: 40 } } as const;

/** The exact stage is injected, so a game that never imports it does not bundle it. */
export const plateSession: SessionFactory = () => model({ exact });

export function buildPlate(p: PlateParameters = PLATE_DEFAULTS, session: SessionFactory = plateSession): Model {
  const plate = session('plate');
  // Step 1: the primitive. A named Shape; the mesh is still empty.
  plate.brep.box('plate', { size: [p.width, p.thickness, p.depth], label: 'plate', role: 'body' });
  // Step 2: the one crossing into the mesh. Six planar faces, uv0 a metric chart per face.
  plate.fromShape('plate');
  // Step 3: texturing. The faces share one texel density, so the slots differ only in material.
  plate.assign(sel.createdBy('plate.py').or(sel.createdBy('plate.ny')), PLATE_SLOTS.face);
  plate.assign(sel.createdBy('plate.px').or(sel.createdBy('plate.nx')).or(sel.createdBy('plate.pz')).or(sel.createdBy('plate.nz')), PLATE_SLOTS.rim);
  return plate;
}

/**
 * The plate as a `modeling-mesh-job` (design 10.4): `plate.pack.ts` emits only the
 * parameters and the cooker builds the Shape and its mesh; register
 * `createMeshJobCooker([PLATE_JOB])` in the build plugin.
 */
export const PLATE_JOB: MeshJob<PlateParameters> = {
  name: 'plate-c700',
  build: (p) => buildPlate(p),
  export: PLATE_EXPORT,
};
