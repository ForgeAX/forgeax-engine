// Type corrections only: r187 registry values are constructors, never Node/Material instances.
import type NodeMaterial from 'three/src/materials/nodes/NodeMaterial.js';
import type Node from 'three/src/nodes/core/Node.js';
import type { Loader, MaterialLoader, ObjectLoader, Texture } from 'three/src/Three.Core.js';

export type NodeTypes = Record<string, new (...args: never[]) => Node>;
export type NodeMaterialTypes = Record<string, new (...args: never[]) => NodeMaterial>;
export interface NodeLoaderContract extends Loader<Node> {
  nodes: NodeTypes;
  textures: Record<string, Texture>;
  setNodes(value: NodeTypes): this;
  setTextures(value: Record<string, Texture>): this;
  parseNodes(input: unknown): Record<string, Node>;
  parse(input: unknown): Node;
  createNodeFromType(type: string): Node;
}
export interface NodeMaterialLoaderContract extends MaterialLoader {
  nodes: Record<string, Node>;
  nodeMaterials: NodeMaterialTypes;
  setNodes(value: Record<string, Node>): this;
  setNodeMaterials(value: NodeMaterialTypes): this;
}
export interface NodeObjectLoaderContract extends ObjectLoader {
  nodes: NodeTypes;
  nodeMaterials: NodeMaterialTypes;
  setNodes(value: NodeTypes): this;
  setNodeMaterials(value: NodeMaterialTypes): this;
  parseNodes(input: unknown, textures: Record<string, Texture>): Record<string, Node>;
}
