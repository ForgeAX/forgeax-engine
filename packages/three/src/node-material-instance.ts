import type PhysicalMaterial from 'three/src/materials/nodes/MeshPhysicalNodeMaterial.js';
import type NodeMaterial from 'three/src/materials/nodes/NodeMaterial.js';
import UpstreamInstance from 'three/src/materials/nodes/NodeMaterialInstance.js';
import type SpriteNodeMaterial from 'three/src/materials/nodes/SpriteNodeMaterial.js';
import { Material, type Object3DEventMap, Sprite as UpstreamSprite } from 'three/src/Three.Core.js';

type Data<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: T[K];
};
type CopiedData<T> = T extends PhysicalMaterial
  ? Record<never, never>
  : T extends SpriteNodeMaterial
    ? Omit<Data<T>, 'sizeAttenuation'>
    : Data<T>;
type NodeKeys<T> = Extract<keyof Data<T>, `${string}Node`>;
/** Instances copy model data; shader methods stay on the shared definition. */
export type NodeMaterialInstance<T extends NodeMaterial = NodeMaterial> = Omit<
  UpstreamInstance,
  'nodeMaterial' | 'copy' | 'clone' | 'fromJSON'
> &
  Omit<CopiedData<T>, keyof UpstreamInstance | NodeKeys<T>> &
  Readonly<Pick<Data<T>, NodeKeys<T>>> & {
    nodeMaterial: T;
    copy<U extends NodeMaterial>(source: NodeMaterialInstance<U>): NodeMaterialInstance<U>;
    copy(source: UpstreamInstance): NodeMaterialInstance;
    clone(): NodeMaterialInstance<T>;
    fromJSON(...args: Parameters<UpstreamInstance['fromJSON']>): NodeMaterialInstance<T>;
  };
export const NodeMaterialInstance = UpstreamInstance as unknown as Omit<
  typeof UpstreamInstance,
  'prototype'
> & {
  readonly prototype: NodeMaterialInstance;
  new <T extends NodeMaterial>(material: T): NodeMaterialInstance<T>;
  new (material: NodeMaterial): NodeMaterialInstance;
};

/** One level only: nested instances and custom definitions fail model admission. */
export function nodeDefinition(material: Material): Material {
  if (material.constructor !== UpstreamInstance) return material;
  const definition = (material as UpstreamInstance).nodeMaterial;
  return definition instanceof Material && !('isNodeMaterialInstance' in definition)
    ? definition
    : material;
}
const instanceBuild = UpstreamInstance.prototype.build;
const instanceCacheKey = UpstreamInstance.prototype.customProgramCacheKey;
export function instanceShaderOverride(material: Material): string | undefined {
  const source = material as UpstreamInstance;
  if (source.build !== instanceBuild) return 'build';
  if (source.customProgramCacheKey !== instanceCacheKey) return 'customProgramCacheKey';
  return undefined;
}

// The source Sprite constructor already accepts these instances at runtime.
export type Sprite<T extends Object3DEventMap = Object3DEventMap> = UpstreamSprite<T>;
export const Sprite = UpstreamSprite as typeof UpstreamSprite & {
  new <T extends Object3DEventMap = Object3DEventMap>(
    material: NodeMaterialInstance<SpriteNodeMaterial>,
  ): UpstreamSprite<T>;
};
