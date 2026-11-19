// Runtime identities stay upstream; these declarations admit actual r187 authoring data.
import type Node from 'three/src/nodes/core/Node.js';
import UpstreamNodeFrame from 'three/src/nodes/core/NodeFrame.js';
import UpstreamJoinNode from 'three/src/nodes/utils/JoinNode.js';
import UpstreamMemberNode from 'three/src/nodes/utils/MemberNode.js';
import UpstreamSetNode from 'three/src/nodes/utils/SetNode.js';

export interface NodeFrame extends UpstreamNodeFrame {
  updateAfterNode(node: Node): void;
}
export const NodeFrame = UpstreamNodeFrame as {
  new (): NodeFrame;
  readonly prototype: NodeFrame;
};

export type JoinNode<TNodeType = unknown> = UpstreamJoinNode<TNodeType>;
export const JoinNode = UpstreamJoinNode as {
  new <TNodeType = unknown>(nodes?: Node[], nodeType?: string | null): JoinNode<TNodeType>;
  readonly type: 'JoinNode';
  readonly prototype: JoinNode;
};

export interface MemberNode extends Omit<UpstreamMemberNode, 'node'> {
  structNode: Node;
}
export const MemberNode = UpstreamMemberNode as unknown as Omit<
  typeof UpstreamMemberNode,
  'prototype'
> & {
  new (structNode: Node, property: string): MemberNode;
  readonly prototype: MemberNode;
};

export interface SetNode extends Omit<UpstreamSetNode, 'components'> {
  components: string | string[];
}
export const SetNode = UpstreamSetNode as unknown as Omit<typeof UpstreamSetNode, 'prototype'> & {
  new (sourceNode: Node, components: string | string[], targetNode: Node): SetNode;
  readonly prototype: SetNode;
};
