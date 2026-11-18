import UpstreamEventNode from 'three/src/nodes/utils/EventNode.js';
import type { NodeFrame } from './node-authoring';

// r187 has nine actual event phases. @types only admits OBJECT and MATERIAL.
export type EventNodeType =
  | typeof UpstreamEventNode.OBJECT
  | typeof UpstreamEventNode.MATERIAL
  | typeof UpstreamEventNode.FRAME
  | typeof UpstreamEventNode.AFTER_OBJECT
  | typeof UpstreamEventNode.BEFORE_OBJECT
  | typeof UpstreamEventNode.BEFORE_MATERIAL
  | typeof UpstreamEventNode.BEFORE_FRAME
  | typeof UpstreamEventNode.BEFORE_RENDER_PIPELINE
  | typeof UpstreamEventNode.AFTER_RENDER_PIPELINE;

export interface EventNode extends Omit<UpstreamEventNode, 'eventType' | 'callback'> {
  eventType: EventNodeType;
  callback: (frame: NodeFrame) => void;
}
export const EventNode = UpstreamEventNode as unknown as Omit<
  typeof UpstreamEventNode,
  'prototype'
> & {
  new (eventType: EventNodeType, callback: (frame: NodeFrame) => void): EventNode;
  readonly prototype: EventNode;
};
