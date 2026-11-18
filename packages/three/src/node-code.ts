// Actual r187 data fields and optional CPU inspection parameters; no runtime wrappers.

import UpstreamMaterialReferenceNode from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import UpstreamCodeNode, { type CodeNodeInclude } from 'three/src/nodes/code/CodeNode.js';
import UpstreamFunctionNode, {
  type FunctionNodeArguments,
} from 'three/src/nodes/code/FunctionNode.js';
import UpstreamAssignNode from 'three/src/nodes/core/AssignNode.js';
import UpstreamAttributeNode from 'three/src/nodes/core/AttributeNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import type NodeBuilder from 'three/src/nodes/core/NodeBuilder.js';
import UpstreamStructNode from 'three/src/nodes/core/StructNode.js';
import type StructTypeNode from 'three/src/nodes/core/StructTypeNode.js';
import type UniformGroupNode from 'three/src/nodes/core/UniformGroupNode.js';
import UpstreamOverloadingNode from 'three/src/nodes/utils/FunctionOverloadingNode.js';
import type { Material } from 'three/src/Three.Core.js';

export interface StructNode extends Omit<UpstreamStructNode, 'values'> {
  structTypeNode: StructTypeNode;
  values: Node[] | Record<string, Node>;
}
export const StructNode = UpstreamStructNode as unknown as Omit<
  typeof UpstreamStructNode,
  'prototype'
> & {
  new (structTypeNode: StructTypeNode, values: Node[] | Record<string, Node>): StructNode;
  readonly prototype: StructNode;
};
export type AttributeNode = UpstreamAttributeNode & {
  getAttributeName(builder?: NodeBuilder): string;
};
export const AttributeNode = UpstreamAttributeNode as {
  new (name: string, nodeType?: string | null): AttributeNode;
  readonly type: string;
  readonly prototype: AttributeNode;
};
export interface CodeNode extends UpstreamCodeNode {
  includes: CodeNodeInclude[];
  getIncludes(builder?: NodeBuilder): CodeNodeInclude[];
}
export const CodeNode = UpstreamCodeNode as unknown as {
  new (code?: string, includes?: CodeNodeInclude[], language?: string): CodeNode;
  readonly type: string;
  readonly prototype: CodeNode;
} & typeof UpstreamCodeNode;
export type FunctionNode<P extends FunctionNodeArguments = FunctionNodeArguments> =
  UpstreamFunctionNode<P> & CodeNode;
export const FunctionNode = UpstreamFunctionNode as unknown as {
  new <P extends FunctionNodeArguments = FunctionNodeArguments>(
    code?: string,
    includes?: CodeNodeInclude[],
    language?: string,
  ): FunctionNode<P>;
  readonly type: string;
  readonly prototype: FunctionNode;
};
export interface FunctionOverloadingNode
  extends Omit<UpstreamOverloadingNode, 'functionNodes' | 'parameterNodes'> {
  functionNodes: unknown[];
  parametersNodes: Node[];
}
export const FunctionOverloadingNode = UpstreamOverloadingNode as unknown as Omit<
  typeof UpstreamOverloadingNode,
  'prototype'
> & {
  new (functionNodes?: unknown[], ...parametersNodes: Node[]): FunctionOverloadingNode;
  readonly prototype: FunctionOverloadingNode;
};

export interface AssignNode extends UpstreamAssignNode {
  targetNode: Node;
  sourceNode: Node;
}
export const AssignNode = UpstreamAssignNode as {
  new (targetNode: Node, sourceNode: Node): AssignNode;
  readonly prototype: AssignNode;
} & typeof UpstreamAssignNode;

export type MaterialReferenceNode<T = unknown> = Omit<
  UpstreamMaterialReferenceNode,
  keyof Node<unknown> | 'setGroup'
> &
  Omit<Node<T>, 'setName' | 'label' | 'setGroup'> & {
    material: Material | null;
    setGroup(group: UniformGroupNode): MaterialReferenceNode<T>;
    setName(name: string): MaterialReferenceNode<T>;
    label(name: string): MaterialReferenceNode<T>;
  };
export const MaterialReferenceNode = UpstreamMaterialReferenceNode as unknown as Omit<
  typeof UpstreamMaterialReferenceNode,
  'prototype'
> & {
  new <T extends string>(
    property: string,
    inputType: T,
    material?: Material | null,
  ): MaterialReferenceNode<T>;
  new (property: string, inputType: string, material?: Material | null): MaterialReferenceNode;
  readonly prototype: MaterialReferenceNode;
};
