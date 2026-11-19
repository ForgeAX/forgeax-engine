import { materialReference as original } from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import type { Material } from 'three/src/Three.Core.js';
import type { MaterialReferenceNode } from './node-code';

/** Original CPU factory, with its required source type and inferred node result. */
export const materialReference = original as unknown as <T extends string>(
  property: string,
  type: T,
  material?: Material | null,
) => MaterialReferenceNode<T>;

import { reference as originalReference } from 'three/src/nodes/accessors/ReferenceNode.js';
import type { NodeUserData } from 'three/src/nodes/accessors/UserDataNode.js';
import { userData as originalUserData } from 'three/src/nodes/accessors/UserDataNode.js';
import type { ReferenceNode, UserDataNode } from './reference-nodes';

export const reference = originalReference as unknown as <T extends string, O = object>(
  property: string,
  type: T,
  object?: O | null,
) => ReferenceNode<T, O>;
export const userData = originalUserData as unknown as <T extends string>(
  property: string,
  type: T,
  data?: NodeUserData | null,
) => UserDataNode<T>;
