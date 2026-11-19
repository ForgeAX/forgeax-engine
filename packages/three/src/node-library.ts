import type NodeMaterial from 'three/src/materials/nodes/NodeMaterial.js';
import OriginalBasic from 'three/src/renderers/webgpu/nodes/BasicNodeLibrary.js';
import OriginalStandard from 'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js';
import type { Material } from 'three/src/Three.Core.js';

/** No matching CPU conversion returns null in r187. These are not native registries. */
export interface BasicNodeLibrary extends Omit<OriginalBasic, 'fromMaterial'> {
  fromMaterial(material: Material): NodeMaterial | null;
}
export const BasicNodeLibrary = OriginalBasic as unknown as Omit<
  typeof OriginalBasic,
  'prototype'
> & {
  readonly prototype: BasicNodeLibrary;
  new (): BasicNodeLibrary;
};
export interface StandardNodeLibrary extends Omit<OriginalStandard, 'fromMaterial'> {
  fromMaterial(material: Material): NodeMaterial | null;
}
export const StandardNodeLibrary = OriginalStandard as unknown as Omit<
  typeof OriginalStandard,
  'prototype'
> & {
  readonly prototype: StandardNodeLibrary;
  new (): StandardNodeLibrary;
};
