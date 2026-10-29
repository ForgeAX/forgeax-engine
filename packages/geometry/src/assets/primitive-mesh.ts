import type { AssetError, MeshAsset, Result } from '@forgeax/engine-types';
import { createBoxGeometry, meshFromInterleaved } from '../box';
import { createCylinderGeometry } from '../cylinder';
import { createPlaneGeometry } from '../plane';
import { createSphereGeometry } from '../sphere';

export type PrimitiveMeshKind =
  | 'cube'
  | 'triangle'
  | 'quad'
  | 'sphere'
  | 'cylinder'
  | 'nine-slice-quad';

/** Create one ordinary mesh payload for allocation or interning by an owning World. */
export function createPrimitiveMesh(kind: PrimitiveMeshKind): Result<MeshAsset, AssetError> {
  switch (kind) {
    case 'cube':
      return createBoxGeometry(1, 1, 1);
    case 'triangle':
      return meshFromInterleaved(
        new Float32Array([
          0, 0.7, 0, 0, 0, 1, 0.5, 1, -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0.7, -0.6, 0, 0, 0, 1, 1, 0,
        ]),
        new Uint16Array([0, 1, 2]),
      );
    case 'quad':
      return createPlaneGeometry(1, 1);
    case 'sphere':
      return createSphereGeometry(1, 16, 12);
    case 'cylinder':
      return createCylinderGeometry(0.5, 0.5, 1, 16, 1);
    case 'nine-slice-quad':
      return createPlaneGeometry(1, 1, 3, 3);
  }
}
