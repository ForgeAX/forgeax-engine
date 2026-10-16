// @forgeax/engine-runtime - Procedural Cone geometry (M3 / w8).
//
// Mirrors Three.js r184 ConeGeometry: createConeGeometry(radius, height,
// radialSegments?, heightSegments?) -> Result<MeshAsset, AssetError>.
// Cone is the cylinder-with-top-radius=0 degenerate, delegated directly.
// Byte-identical output to createCylinderGeometry(0, radius, height, ...)
// by contract (test in geometry.test.ts enforces the equivalence).
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate } from './box';
import { createCylinderGeometry } from './cylinder';

export function createConeGeometry(
  radius: number,
  height: number,
  radialSegments: number = 16,
  heightSegments: number = 1,
): Result<MeshAsset, AssetError> {
  if (radius <= 0) return err(degenerate(`radius=${radius}`));
  if (height <= 0) return err(degenerate(`height=${height}`));
  return createCylinderGeometry(0, radius, height, radialSegments, heightSegments);
}
