// @forgeax/engine-runtime - Procedural Cylinder geometry (M3 / w8).
//
// Mirrors Three.js r184 CylinderGeometry: createCylinderGeometry(radiusTop,
// radiusBottom, height, radialSegments?, heightSegments?, openEnded?) ->
// Result<MeshAsset, AssetError>. `openEnded` omits both caps (a tube or an
// open cone, e.g. a light beam whose far end must not show a hard disc).
// Degenerate parameters (both radii <= 0, height <= 0, radialSegments < 3,
// heightSegments < 1) fail-fast with AssetError('asset-parse-failed').
// Note: one radius may be zero (degenerate end collapses to a cone tip),
// but NOT both — a zero cylinder has no surface area.
//
// Related: requirements §AC-06 / §AC-14; plan-strategy §M3 + D-P5;
//          plan-tasks.json w8 acceptanceCheck.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate } from './box';
import {
  createPrimitiveAttributes,
  finishPrimitiveMesh,
  type PrimitiveAttributes,
} from './primitive-attributes';

type Cap = readonly [radius: number, direction: 1 | -1];

/** Closed ends with a positive radius; an open-ended surface has none. */
function cylinderCaps(radiusTop: number, radiusBottom: number, openEnded: boolean): Cap[] {
  if (openEnded) return [];
  const caps: Cap[] = [
    [radiusTop, 1],
    [radiusBottom, -1],
  ];
  return caps.filter(([radius]) => radius > 0);
}

/** Write one cap fan (centre + ring) at `vIdx`/`iIdx`; returns the next cursors. */
function writeCap(
  attributes: PrimitiveAttributes,
  indices: Uint32Array,
  [radius, direction]: Cap,
  halfHeight: number,
  rs: number,
  cursor: { vIdx: number; iIdx: number },
): void {
  let { vIdx, iIdx } = cursor;
  const centerIdx = vIdx;
  attributes.position[vIdx * 3 + 1] = direction * halfHeight;
  attributes.normal[vIdx * 3 + 1] = direction;
  attributes.uv[vIdx * 2 + 0] = 0.5;
  attributes.uv[vIdx * 2 + 1] = 0.5;
  vIdx++;
  const ringStart = vIdx;
  for (let ix = 0; ix <= rs; ix++) {
    const theta = (ix / rs) * Math.PI * 2;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    attributes.position[vIdx * 3 + 0] = radius * sinT;
    attributes.position[vIdx * 3 + 1] = direction * halfHeight;
    attributes.position[vIdx * 3 + 2] = radius * cosT;
    attributes.normal[vIdx * 3 + 1] = direction;
    attributes.uv[vIdx * 2 + 0] = sinT * 0.5 + 0.5;
    attributes.uv[vIdx * 2 + 1] = cosT * 0.5 + 0.5;
    vIdx++;
  }
  const flip = direction < 0 ? 1 : 0;
  for (let ix = 0; ix < rs; ix++) {
    indices[iIdx++] = centerIdx;
    indices[iIdx++] = ringStart + ix + flip;
    indices[iIdx++] = ringStart + ix + 1 - flip;
  }
  cursor.vIdx = vIdx;
  cursor.iIdx = iIdx;
}

export function createCylinderGeometry(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number = 16,
  heightSegments: number = 1,
  openEnded: boolean = false,
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
  // Caps: each cap has 1 center + (rs + 1) ring vertices and rs triangles.
  const caps = cylinderCaps(radiusTop, radiusBottom, openEnded);
  const vertexCount = sideVertexCount + caps.length * (rs + 2);
  const indexCount = rs * hs * 6 + caps.length * rs * 3;

  const attributes = createPrimitiveAttributes(vertexCount);
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
      attributes.position[vIdx * 3 + 0] = x;
      attributes.position[vIdx * 3 + 1] = y;
      attributes.position[vIdx * 3 + 2] = z;
      attributes.normal[vIdx * 3 + 0] = nx / nlen;
      attributes.normal[vIdx * 3 + 1] = ny / nlen;
      attributes.normal[vIdx * 3 + 2] = nz / nlen;
      attributes.uv[vIdx * 2 + 0] = u;
      // UV.v uses the WebGPU top-left convention (V=0 = image top).
      attributes.uv[vIdx * 2 + 1] = v;
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
  const cursor = { vIdx, iIdx };
  for (const cap of caps) writeCap(attributes, indices, cap, halfHeight, rs, cursor);

  return finishPrimitiveMesh(attributes, indices);
}
