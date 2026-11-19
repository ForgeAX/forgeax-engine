import OriginalObserver from 'three/src/materials/nodes/manager/NodeMaterialObserver.js';
import type NodeBuilder from 'three/src/nodes/core/NodeBuilder.js';
import type { Material, Object3D } from 'three/src/Three.Core.js';

/** The CPU constructor/containsNode path only reads these authored facts. */
export interface NodeMaterialObserverContext {
  readonly material: Material;
  readonly object: Object3D;
  readonly context: {
    readonly modelViewMatrix?: unknown;
    readonly modelNormalViewMatrix?: unknown;
    readonly getAO?: unknown;
    readonly getShadow?: unknown;
    readonly getGI?: unknown;
  };
}
export interface NodeMaterialObserver extends Omit<OriginalObserver, 'containsNode'> {
  containsNode(context: NodeMaterialObserverContext | NodeBuilder): boolean;
}
export const NodeMaterialObserver = OriginalObserver as unknown as Omit<
  typeof OriginalObserver,
  'prototype'
> & {
  readonly prototype: NodeMaterialObserver;
  new (context: NodeMaterialObserverContext | NodeBuilder): NodeMaterialObserver;
};
