// @forgeax/engine-runtime - Procedural Sphere geometry (M3 / w8).
//
// Mirrors Three.js r184 SphereGeometry signature:
// createSphereGeometry(radius, widthSegments?, heightSegments?) ->
// Result<MeshAsset, AssetError>. Degenerate parameters (radius <= 0, widthSegments
// < 3, heightSegments < 2) fail-fast with AssetError('asset-parse-failed').
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate, FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';
import { poleGridIndices } from './pole-grid-indices';

export function createSphereGeometry(
  radius: number,
  widthSegments: number = 16,
  heightSegments: number = 12,
): Result<MeshAsset, AssetError> {
  if (radius <= 0) return err(degenerate(`radius=${radius}`));
  const ws = widthSegments | 0;
  const hs = heightSegments | 0;
  if (ws < 3) return err(degenerate(`widthSegments=${ws}; minimum 3`));
  if (hs < 2) return err(degenerate(`heightSegments=${hs}; minimum 2`));

  const vertexCount = (ws + 1) * (hs + 1);
  const vertices = new Float32Array(vertexCount * FACTORY_FLOATS_PER_VERTEX);

  let vIdx = 0;
  for (let iy = 0; iy <= hs; iy++) {
    const v = iy / hs;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= ws; ix++) {
      const u = ix / ws;
      const theta = u * Math.PI * 2;
      const x = -radius * Math.cos(theta) * Math.sin(phi);
      const y = radius * Math.cos(phi);
      const z = radius * Math.sin(theta) * Math.sin(phi);
      const nx = x / radius;
      const ny = y / radius;
      const nz = z / radius;
      const base = vIdx * FACTORY_FLOATS_PER_VERTEX;
      vertices[base + 0] = x;
      vertices[base + 1] = y;
      vertices[base + 2] = z;
      vertices[base + 3] = nx;
      vertices[base + 4] = ny;
      vertices[base + 5] = nz;
      vertices[base + 6] = u;
      // UV.v uses the WebGPU top-left convention (V=0 = image top).
      vertices[base + 7] = v;
      vIdx++;
    }
  }

  return meshFromInterleaved(vertices, poleGridIndices(ws, hs + 1));
}
