// @forgeax/engine-runtime - Procedural Cylinder geometry (M3 / w8).
//
// Mirrors Three.js r184 CylinderGeometry: createCylinderGeometry(radiusTop,
// radiusBottom, height, radialSegments?, heightSegments?) ->
// Result<MeshAsset, AssetError>.
// Degenerate parameters (both radii <= 0, height <= 0, radialSegments < 3,
// heightSegments < 1) fail-fast with AssetError('asset-parse-failed').
// Note: one radius may be zero (degenerate end collapses to a cone tip),
// but NOT both — a zero cylinder has no surface area.
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate, FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';

export function createCylinderGeometry(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number = 16,
  heightSegments: number = 1,
): Result<MeshAsset, AssetError> {
  if (radiusTop < 0 || radiusBottom < 0 || height <= 0) {
    return err(
      degenerate(`radiusTop=${radiusTop}, radiusBottom=${radiusBottom}, height=${height}`),
    );
  }
  if (radiusTop === 0 && radiusBottom === 0) {
    return err(degenerate(`radiusTop=0 and radiusBottom=0; at least one must be > 0`));
  }
  const rs = radialSegments | 0;
  const hs = heightSegments | 0;
  if (rs < 3) return err(degenerate(`radialSegments=${rs}; minimum 3`));
  if (hs < 1) return err(degenerate(`heightSegments=${hs}; minimum 1`));

  const halfHeight = height / 2;
  // Side: (rs + 1) * (hs + 1) vertices
  const sideVertexCount = (rs + 1) * (hs + 1);
  // Caps: each cap has 1 center + (rs + 1) ring vertices if the radius is > 0
  const topCap = radiusTop > 0;
  const bottomCap = radiusBottom > 0;
  const topCount = topCap ? rs + 2 : 0;
  const bottomCount = bottomCap ? rs + 2 : 0;
  const vertexCount = sideVertexCount + topCount + bottomCount;

  const sideIndexCount = rs * hs * 6;
  const topIdxCount = topCap ? rs * 3 : 0;
  const bottomIdxCount = bottomCap ? rs * 3 : 0;
  const indexCount = sideIndexCount + topIdxCount + bottomIdxCount;

  const vertices = new Float32Array(vertexCount * FACTORY_FLOATS_PER_VERTEX);
  const indices = new Uint32Array(indexCount);

  // --- side ---
  let vIdx = 0;
  const slope = (radiusBottom - radiusTop) / height;
  for (let iy = 0; iy <= hs; iy++) {
    const v = iy / hs;
    const y = halfHeight - v * height;
    const radius = v * (radiusBottom - radiusTop) + radiusTop;
    for (let ix = 0; ix <= rs; ix++) {
      const u = ix / rs;
      const theta = u * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const x = radius * sinT;
      const z = radius * cosT;
      const nx = sinT;
      const ny = slope;
      const nz = cosT;
      // normalize
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const base = vIdx * FACTORY_FLOATS_PER_VERTEX;
      vertices[base + 0] = x;
      vertices[base + 1] = y;
      vertices[base + 2] = z;
      vertices[base + 3] = nx / nlen;
      vertices[base + 4] = ny / nlen;
      vertices[base + 5] = nz / nlen;
      vertices[base + 6] = u;
      // UV.v uses the WebGPU top-left convention (V=0 = image top).
      vertices[base + 7] = v;
      vIdx++;
    }
  }

  let iIdx = 0;
  for (let iy = 0; iy < hs; iy++) {
    for (let ix = 0; ix < rs; ix++) {
      const a = (rs + 1) * iy + ix;
      const b = (rs + 1) * (iy + 1) + ix;
      const c = (rs + 1) * (iy + 1) + ix + 1;
      const d = (rs + 1) * iy + ix + 1;
      indices[iIdx++] = a;
      indices[iIdx++] = b;
      indices[iIdx++] = d;
      indices[iIdx++] = b;
      indices[iIdx++] = c;
      indices[iIdx++] = d;
    }
  }

  // Caps share their geometry; their orientation supplies the normal and winding.
  for (const [radius, direction] of [
    [radiusTop, 1],
    [radiusBottom, -1],
  ] as const) {
    if (!(radius > 0)) continue;
    const centerIdx = vIdx;
    const cBase = vIdx * FACTORY_FLOATS_PER_VERTEX;
    vertices[cBase + 1] = direction * halfHeight;
    vertices[cBase + 4] = direction;
    vertices[cBase + 6] = 0.5;
    vertices[cBase + 7] = 0.5;
    vIdx++;
    const ringStart = vIdx;
    for (let ix = 0; ix <= rs; ix++) {
      const theta = (ix / rs) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const base = vIdx * FACTORY_FLOATS_PER_VERTEX;
      vertices[base + 0] = radius * sinT;
      vertices[base + 1] = direction * halfHeight;
      vertices[base + 2] = radius * cosT;
      vertices[base + 4] = direction;
      vertices[base + 6] = sinT * 0.5 + 0.5;
      vertices[base + 7] = cosT * 0.5 + 0.5;
      vIdx++;
    }
    for (let ix = 0; ix < rs; ix++) {
      indices[iIdx++] = centerIdx;
      indices[iIdx++] = ringStart + ix + (direction < 0 ? 1 : 0);
      indices[iIdx++] = ringStart + ix + (direction > 0 ? 1 : 0);
    }
  }

  return meshFromInterleaved(vertices, indices);
}
