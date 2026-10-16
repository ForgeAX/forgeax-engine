// @forgeax/engine-runtime - Procedural Plane geometry (M3 / w8).
//
// Mirrors Three.js r184 PlaneGeometry: createPlaneGeometry(width, height,
// widthSegments?, heightSegments?) -> Result<MeshAsset, AssetError>. The plane
// lies on the XY plane with +Z normal (standard three.js orientation).
// Degenerate parameters fail-fast with AssetError('asset-parse-failed').
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate, FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';

export function createPlaneGeometry(
  width: number,
  height: number,
  widthSegments: number = 1,
  heightSegments: number = 1,
): Result<MeshAsset, AssetError> {
  if (width <= 0 || height <= 0) {
    return err(degenerate(`width=${width}, height=${height}`));
  }
  const ws = widthSegments | 0;
  const hs = heightSegments | 0;
  if (ws < 1 || hs < 1) {
    return err(degenerate(`widthSegments=${ws}, heightSegments=${hs}`));
  }

  const halfW = width / 2;
  const halfH = height / 2;
  const gridX1 = ws + 1;
  const gridY1 = hs + 1;
  const segW = width / ws;
  const segH = height / hs;

  const vertexCount = gridX1 * gridY1;
  const indexCount = ws * hs * 6;
  const vertices = new Float32Array(vertexCount * FACTORY_FLOATS_PER_VERTEX);
  const indices = new Uint32Array(indexCount);

  let vIdx = 0;
  for (let iy = 0; iy < gridY1; iy++) {
    const y = iy * segH - halfH;
    for (let ix = 0; ix < gridX1; ix++) {
      const x = ix * segW - halfW;
      const base = vIdx * FACTORY_FLOATS_PER_VERTEX;
      vertices[base + 0] = x;
      vertices[base + 1] = -y;
      vertices[base + 2] = 0;
      vertices[base + 3] = 0;
      vertices[base + 4] = 0;
      vertices[base + 5] = 1;
      vertices[base + 6] = ix / ws;
      // UV.v uses the WebGPU top-left convention (V=0 = image top).
      vertices[base + 7] = iy / hs;
      vIdx++;
    }
  }

  let iIdx = 0;
  for (let iy = 0; iy < hs; iy++) {
    for (let ix = 0; ix < ws; ix++) {
      const a = ix + gridX1 * iy;
      const b = ix + gridX1 * (iy + 1);
      const c = ix + 1 + gridX1 * (iy + 1);
      const d = ix + 1 + gridX1 * iy;
      indices[iIdx++] = a;
      indices[iIdx++] = b;
      indices[iIdx++] = d;
      indices[iIdx++] = b;
      indices[iIdx++] = c;
      indices[iIdx++] = d;
    }
  }

  return meshFromInterleaved(vertices, indices);
}
