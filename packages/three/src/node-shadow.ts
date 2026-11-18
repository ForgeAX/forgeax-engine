import UpstreamPointShadowNode from 'three/src/nodes/lighting/PointShadowNode.js';
import UpstreamShadowNode from 'three/src/nodes/lighting/ShadowNode.js';
import type { Light, LightShadow, RenderTarget } from 'three/src/Three.Core.js';

/** Actual CPU references; no native shadow target is created by construction. */
export interface ShadowNode extends UpstreamShadowNode {
  shadow: LightShadow | undefined;
  shadowMap: RenderTarget | null;
  depthLayer: number;
}
export interface PointShadowNode extends UpstreamPointShadowNode, ShadowNode {}
export const ShadowNode = UpstreamShadowNode as unknown as Omit<
  typeof UpstreamShadowNode,
  'prototype'
> & {
  readonly prototype: ShadowNode;
  new (light: Light, shadow?: LightShadow | null): ShadowNode;
};
export const PointShadowNode = UpstreamPointShadowNode as unknown as Omit<
  typeof UpstreamPointShadowNode,
  'prototype'
> & {
  readonly prototype: PointShadowNode;
  new (light: Light, shadow?: LightShadow | null): PointShadowNode;
};
