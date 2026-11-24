import type { MeshDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { rayReferenceFailure } from './scene';
import { SdfFieldUpload } from './sdf-field-storage';
import type { SdfMeshInstance } from './sdf-query';
import { prepareSdfPlacements } from './sdf-scene-placement';
import { packSdfSurfacePool, type SdfSurfacePoolRow } from './sdf-surface-storage';

function sampled(field: MeshDistanceField): field is SdfSurfacePoolRow['field'] {
  return field.policy.kind === 'sampled-visibility';
}
export function sdfSurfaceRowAddress(row: number) {
  return SDF_SURFACE_POOL_LAYOUT.sceneWords + row * SDF_SURFACE_POOL_LAYOUT.rowWords;
}

/** The source field owns canonical triangles. Placement material qualification
 * remains with SceneFieldProjection; unavailable coverage cannot acquire a
 * triangle certificate merely by sharing a Mesh with an opaque instance. */
export function packSceneSurface(source: readonly SdfMeshInstance[], capacity: number) {
  const placements = prepareSdfPlacements(source);
  if (!placements.ok) return placements;
  const rows: (SdfSurfacePoolRow | undefined)[] = [];
  for (const [row, instance] of source.entries()) {
    if (!instance) return rayReferenceFailure('missing SDF instance');
    const field = instance.field;
    if ('missing' in field || !sampled(field)) {
      rows.push(undefined);
      continue;
    }
    const prepared = placements.value[row];
    if (!prepared) return rayReferenceFailure('missing prepared SDF placement');
    const { matrix: forward, inverse, certificate } = prepared;
    if (!certificate.ok) return certificate;
    const fieldUpload = instance.fieldUpload;
    rows.push({
      field,
      forward,
      inverse,
      certificate: certificate.value,
      ...(instance.surfaceCoverage === undefined ? {} : { coverage: instance.surfaceCoverage }),
      ...(fieldUpload instanceof SdfFieldUpload && fieldUpload.field === field
        ? { fieldUpload }
        : {}),
    });
  }
  const packed = packSdfSurfacePool(rows, capacity);
  if (!packed.ok) return packed;
  for (const [row, instance] of source.entries()) {
    if (instance.surfaceCoverage === 'unavailable')
      packed.value.words[sdfSurfaceRowAddress(row) + 2] = 0;
  }
  return ok({ pool: packed.value, placements: placements.value });
}
