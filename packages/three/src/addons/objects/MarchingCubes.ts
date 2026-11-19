import { MarchingCubes as OriginalMarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import type { Material, Mesh } from 'three/src/Three.Core.js';

export { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

type MarchingState = Pick<
  OriginalMarchingCubes,
  | 'enableUvs'
  | 'enableColors'
  | 'resolution'
  | 'isolation'
  | 'size'
  | 'size2'
  | 'size3'
  | 'halfsize'
  | 'delta'
  | 'yd'
  | 'zd'
  | 'field'
  | 'normal_cache'
  | 'palette'
  | 'count'
  | 'positionArray'
  | 'normalArray'
  | 'init'
  | 'addBall'
  | 'addPlaneX'
  | 'addPlaneY'
  | 'addPlaneZ'
  | 'setCell'
  | 'getCell'
  | 'blur'
  | 'reset'
  | 'update'
>;
/** Obsolete immediate-mode methods and flags do not exist in r187. */
export interface MarchingCubes extends Mesh, MarchingState {
  readonly isMarchingCubes: true;
  uvArray?: Float32Array;
  colorArray?: Float32Array;
}
export const MarchingCubes = OriginalMarchingCubes as unknown as Omit<
  typeof OriginalMarchingCubes,
  'prototype'
> & {
  new (
    resolution: number,
    material: Material | Material[],
    enableUvs?: boolean,
    enableColors?: boolean,
    maxPolyCount?: number,
  ): MarchingCubes;
  readonly prototype: MarchingCubes;
};
