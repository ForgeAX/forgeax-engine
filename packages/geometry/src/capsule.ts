// @forgeax/engine-runtime - Procedural Capsule geometry.
//
// A capsule is a cylinder mid-band of height `length` capped by two radius-
// `radius` hemispheres, so the total height is `length + 2 * radius`. The
// convention matches Bevy `Capsule3d::new(radius, height)` (its `height` is
// the mid-section; the radius is added to each end) and Three.js r184
// CapsuleGeometry(radius, length, capSegments, radialSegments).
//
// Generation mirrors sphere.ts's ring sweep rather than composing separate
// cylinder + sphere meshes (no mesh-merge primitive exists): a single
// top-to-bottom latitude sweep emits the top hemisphere (offset +halfLength),
// the two equator rings that bound the cylinder band, and the bottom
// hemisphere (offset -halfLength). Consecutive rings are stitched by the same
// quad connector sphere.ts uses, so the vertical wall between the equator
// rings is filled with no dedicated cylinder code. Per-vertex normals are
// `normalize(pos - hemisphereCenter)` (radial on the caps, horizontal on the
// wall) so the surface is seam-free by construction.
//
// Degenerate parameters (radius <= 0, length < 0, capSegments < 1,
// radialSegments < 3) fail-fast with AssetError('asset-parse-failed'),
// matching the 6 sibling factories.

import type { AssetError, MeshAsset } from '@forgeax/engine-types';
import { err, type Result } from '@forgeax/engine-types';
import { degenerate, FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';
import { poleGridIndices } from './pole-grid-indices';

/**
 * Build a procedural capsule geometry aligned with Bevy `Capsule3d` /
 * Three.js r184 CapsuleGeometry.
 *
 * @param radius hemisphere + cylinder radius (> 0)
 * @param length cylinder mid-section height (>= 0; total height = length + 2*radius)
 * @param capSegments latitude bands per hemisphere (>= 1); default 4
 * @param radialSegments longitudes around the axis (>= 3); default 8
 * @returns `Result<MeshAsset, AssetError>` with attributes populated
 */
export function createCapsuleGeometry(
  radius: number,
  length: number,
  capSegments: number = 4,
  radialSegments: number = 8,
): Result<MeshAsset, AssetError> {
  if (radius <= 0) return err(degenerate(`radius=${radius}`));
  if (length < 0) return err(degenerate(`length=${length}`));
  const cs = capSegments | 0;
  const rs = radialSegments | 0;
  if (cs < 1) return err(degenerate(`capSegments=${cs}; minimum 1`));
  if (rs < 3) return err(degenerate(`radialSegments=${rs}; minimum 3`));

  const halfLength = length / 2;
  // Latitude rows: cs+1 for the top hemisphere (0..pi/2) and cs+1 for the
  // bottom (pi/2..pi). The equator is shared: the top's last row and the
  // bottom's first row are BOTH at the equator radius but at y=+halfLength
  // and y=-halfLength respectively (they coincide only when length===0).
  // Total rows = 2*(cs+1); the middle quad band between the two equator rows
  // becomes the cylinder wall.
  const latRows = 2 * (cs + 1);
  const vertexCount = latRows * (rs + 1);

  const vertices = new Float32Array(vertexCount * FACTORY_FLOATS_PER_VERTEX);

  let vIdx = 0;
  // Emit rows top -> bottom. `row` in [0, latRows-1]. The first cs+1 rows are
  // the top hemisphere (phi 0..pi/2, center y=+halfLength); the last cs+1 rows
  // are the bottom hemisphere (phi pi/2..pi, center y=-halfLength).
  for (let row = 0; row < latRows; row++) {
    const topHemi = row <= cs;
    // Ring radius + y from hemisphere-local latitude so the caps are exact
    // hemispheres and the two equator rings sit at y=+-halfLength.
    let ringR: number;
    let y: number;
    let centerY: number;
    if (topHemi) {
      const t = row / cs; // 0 at north pole, 1 at equator
      const a = t * (Math.PI / 2);
      ringR = radius * Math.sin(a);
      centerY = halfLength;
      y = centerY + radius * Math.cos(a);
    } else {
      const t = (row - (cs + 1)) / cs; // 0 at equator (bottom), 1 at south pole
      const a = t * (Math.PI / 2);
      ringR = radius * Math.cos(a);
      centerY = -halfLength;
      y = centerY - radius * Math.sin(a);
    }
    // v texture coord: monotonic 0..1 top->bottom across all rows.
    const v = row / (latRows - 1);
    for (let ix = 0; ix <= rs; ix++) {
      const u = ix / rs;
      const theta = u * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const x = ringR * sinT;
      const z = ringR * cosT;
      // Normal = normalize(pos - hemisphereCenter): radial on caps, horizontal
      // on the equatorial wall (cos component is 0 there).
      const nx = x;
      const ny = y - centerY;
      const nz = z;
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

  return meshFromInterleaved(vertices, poleGridIndices(rs, latRows));
}
