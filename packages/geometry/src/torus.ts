// @forgeax/engine-runtime - Procedural Torus geometry (M3 / w8).
//
// Mirrors Three.js r184 TorusGeometry: createTorusGeometry(radius, tube,
// radialSegments?, tubularSegments?) -> Result<MeshAsset, AssetError>.
// `radius` is the distance from the torus center to the tube center (ring
// radius); `tube` is the cross-section (tube) radius. Degenerate parameters
// fail-fast with AssetError('asset-parse-failed').
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate } from './box';
import { createPrimitiveAttributes, finishPrimitiveMesh } from './primitive-attributes';

export function createTorusGeometry(
  radius: number,
  tube: number,
  radialSegments: number = 8,
  tubularSegments: number = 24,
): Result<MeshAsset, AssetError> {
  if (radius <= 0) return err(degenerate(`radius=${radius}`));
  if (tube <= 0) return err(degenerate(`tube=${tube}`));
  const rs = radialSegments | 0;
  const ts = tubularSegments | 0;
  if (rs < 3) return err(degenerate(`radialSegments=${rs}; minimum 3`));
  if (ts < 3) return err(degenerate(`tubularSegments=${ts}; minimum 3`));

  const vertexCount = (rs + 1) * (ts + 1);
  const indexCount = rs * ts * 6;
  const attributes = createPrimitiveAttributes(vertexCount);
  const indices = new Uint32Array(indexCount);

  let vIdx = 0;
  for (let j = 0; j <= rs; j++) {
    const v = (j / rs) * Math.PI * 2;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    for (let i = 0; i <= ts; i++) {
      const u = (i / ts) * Math.PI * 2;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const x = (radius + tube * cosV) * cosU;
      const y = (radius + tube * cosV) * sinU;
      const z = tube * sinV;
      // normal = normalize(position - center_of_tube_at_u)
      const centerX = radius * cosU;
      const centerY = radius * sinU;
      const nx = x - centerX;
      const ny = y - centerY;
      const nz = z;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      attributes.position[vIdx * 3 + 0] = x;
      attributes.position[vIdx * 3 + 1] = y;
      attributes.position[vIdx * 3 + 2] = z;
      attributes.normal[vIdx * 3 + 0] = nx / nlen;
      attributes.normal[vIdx * 3 + 1] = ny / nlen;
      attributes.normal[vIdx * 3 + 2] = nz / nlen;
      attributes.uv[vIdx * 2 + 0] = i / ts;
      attributes.uv[vIdx * 2 + 1] = j / rs;
      vIdx++;
    }
  }

  let iIdx = 0;
  for (let j = 1; j <= rs; j++) {
    for (let i = 1; i <= ts; i++) {
      const a = (ts + 1) * j + i - 1;
      const b = (ts + 1) * (j - 1) + i - 1;
      const c = (ts + 1) * (j - 1) + i;
      const d = (ts + 1) * j + i;
      indices[iIdx++] = a;
      indices[iIdx++] = b;
      indices[iIdx++] = d;
      indices[iIdx++] = b;
      indices[iIdx++] = c;
      indices[iIdx++] = d;
    }
  }

  return finishPrimitiveMesh(attributes, indices);
}
