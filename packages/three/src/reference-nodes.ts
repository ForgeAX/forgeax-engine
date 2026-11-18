import OriginalBase from 'three/src/nodes/accessors/ReferenceBaseNode.js';
import OriginalReference from 'three/src/nodes/accessors/ReferenceNode.js';
import type { NodeUserData } from 'three/src/nodes/accessors/UserDataNode.js';
import OriginalUserData from 'three/src/nodes/accessors/UserDataNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import type UniformGroupNode from 'three/src/nodes/core/UniformGroupNode.js';

type ReferenceData<T, O> = Omit<
  OriginalReference<unknown, O>,
  keyof Node<unknown> | 'object' | 'setGroup'
> &
  Node<T> & { object: O | null };

/** Original constructors; nullable source targets and inferred node types only. */
export type ReferenceNode<T = unknown, O = unknown> = Omit<
  ReferenceData<T, O>,
  'setName' | 'label' | 'setGroup'
> & {
  name: string | null;
  setGroup(group: UniformGroupNode): ReferenceNode<T, O>;
  setName(name: string): ReferenceNode<T, O>;
  label(name: string): ReferenceNode<T, O>;
};
export const ReferenceNode = OriginalReference as unknown as Omit<
  typeof OriginalReference,
  'prototype'
> & {
  new <T extends string, O = object>(
    property: string,
    type: T,
    object?: O | null,
    count?: number | null,
  ): ReferenceNode<T, O>;
  readonly prototype: ReferenceNode;
};

// Preserve the existing object-type parameter first; the inferred node type is second.
export type ReferenceBaseNode<O = unknown, T = unknown> = ReferenceData<T, O> & {
  setGroup(group: UniformGroupNode): ReferenceBaseNode<O, T>;
};
export const ReferenceBaseNode = OriginalBase as unknown as Omit<
  typeof OriginalBase,
  'prototype'
> & {
  new <O = object, T extends string = string>(
    property: string,
    type: T,
    object?: O | null,
    count?: number | null,
  ): ReferenceBaseNode<O, T>;
  readonly prototype: ReferenceBaseNode;
};

export type UserDataNode<T = unknown> = Omit<
  ReferenceData<T, NodeUserData>,
  'setName' | 'label' | 'setGroup'
> & {
  name: string | null;
  setGroup(group: UniformGroupNode): UserDataNode<T>;
  setName(name: string): UserDataNode<T>;
  label(name: string): UserDataNode<T>;
  userData: NodeUserData | null;
};
export const UserDataNode = OriginalUserData as unknown as Omit<
  typeof OriginalUserData,
  'prototype'
> & {
  new <T extends string>(
    property: string,
    type: T,
    userData?: NodeUserData | null,
  ): UserDataNode<T>;
  readonly prototype: UserDataNode;
};
