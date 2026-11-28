// Instant Meshes position-field pipeline (Jakob et al. 2015): hierarchy, extrinsic 4-RoSy
// orientation, then extrinsic 4-PoSy positions on a uniform quad lattice. Extraction to a quad
// mesh is a separate stage (see extract.ts, not yet landed).

import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import type { CrossField, PositionField } from './field';
import { buildHierarchy, finestLevel } from './hierarchy';
import { solveOrientation } from './orientation-field';
import { solvePositions } from './position-solve';
import { faceAreas, type TriMesh, triTopology } from './trimesh';

export interface InstantMeshesOptions {
  /** Target lattice spacing. Defaults to sqrt(2 x mean face area), i.e. one quad per two triangles. */
  readonly scale?: number;
  /** Gauss-Seidel sweeps per level for both solves (default 6, Instant Meshes default). */
  readonly iterations?: number;
}

export interface InstantMeshesReport {
  readonly levels: number;
  readonly scale: number;
  readonly orientationResidual: number;
  readonly vertices: number;
}

export interface InstantMeshesResult {
  readonly field: PositionField;
  readonly report: InstantMeshesReport;
}

/**
 * Position field for a closed-or-open triangle mesh. Returns structured errors for invalid input
 * (topology, non-finite coordinates, non-positive scale). Creases are not yet split here, so
 * `vertexSource` is the identity; the crease split lands with the feature-aware pipeline.
 */
export function instantMeshesField(
  mesh: TriMesh,
  options: InstantMeshesOptions = {},
): Result<InstantMeshesResult, ModelingError> {
  const topo = triTopology(mesh);
  if (!topo.ok) return topo;
  const areas = faceAreas(mesh);
  const totalArea = areas.reduce((s, a) => s + a, 0);
  // Quad-count goal of about one quad per two triangles: a quad covers two triangles' area.
  const scale =
    options.scale ?? Math.sqrt((2 * totalArea) / Math.max(1, mesh.triangles.length / 3));
  if (!(scale > 0) || !Number.isFinite(scale))
    return err(
      modelingError('model-invalid-argument', 'a positive finite target scale', {
        reason: 'bad-scale',
      }),
    );
  const iterations = options.iterations ?? 6;
  const level0 = finestLevel(mesh);
  const hierarchy = buildHierarchy(level0);
  const orient = solveOrientation(hierarchy, { iterations });

  const nv = mesh.positions.length / 3;
  const orientation: CrossField = {
    site: 'vertex',
    mesh,
    normal: level0.normal,
    direction: orient.direction,
    fixed: new Uint8Array(nv),
    singularities: [],
  };
  const origin = solvePositions(hierarchy, orient.levels, { iterations, scale });
  const field: PositionField = {
    orientation,
    scale,
    origin,
    vertexSource: Uint32Array.from({ length: nv }, (_, i) => i),
  };
  return ok({
    field,
    report: {
      levels: hierarchy.levels.length,
      scale,
      orientationResidual: orient.residual,
      vertices: nv,
    },
  });
}
