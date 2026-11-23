import MaterialReferenceNode from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import ReferenceBaseNode from 'three/src/nodes/accessors/ReferenceBaseNode.js';
import ReferenceNode from 'three/src/nodes/accessors/ReferenceNode.js';
import UserDataNode from 'three/src/nodes/accessors/UserDataNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import { Material } from 'three/src/Three.Core.js';
import { unsupported } from './errors';
import { nodeDefinition } from './node-material-instance';

export type ReferenceInput = Node &
  Pick<
    ReferenceNode<unknown, unknown>,
    'property' | 'properties' | 'uniformType' | 'count' | 'node'
  >;
const constructors = new Set<object>([
  MaterialReferenceNode,
  ReferenceNode,
  ReferenceBaseNode,
  UserDataNode,
]);
export function isValueReference(input: object): input is ReferenceInput {
  return constructors.has(input.constructor);
}
const valueTypes = new Set(['float', 'color', 'vec3', 'vec4']);
const directProperty = /^[A-Za-z_$][\w$]*$/;

/** One direct material field, not an object path, buffer, texture or graph. */
export function admitReference(material: Material, subject: string, input: ReferenceInput) {
  if (
    typeof input.property !== 'string' ||
    !directProperty.test(input.property) ||
    !Array.isArray(input.properties) ||
    input.properties.length !== 1 ||
    input.properties[0] !== input.property ||
    input.count !== null ||
    !valueTypes.has(input.uniformType)
  )
    return unsupported(`${subject} requires a direct value reference`, material.uuid);
  const target = referenceTarget(material, input);
  if (target === null || (typeof target !== 'object' && typeof target !== 'function'))
    return unsupported(
      `${subject} requires an explicit reference object or userData`,
      material.uuid,
    );
  if (
    input.node !== null &&
    (!(input.node instanceof UniformNode) ||
      input.node.constructor !== UniformNode ||
      input.node.nodeType !== input.uniformType)
  )
    return unsupported(
      `${subject} reference cache requires an original scalar/color uniform`,
      material.uuid,
    );
  return undefined;
}

/** Source selector authority; never the mutable last-update reference cache. */
export function referenceTarget(material: Material, input: ReferenceInput): unknown {
  if (input.constructor === MaterialReferenceNode) {
    const target =
      (input as MaterialReferenceNode & { material: Material | null }).material ?? material;
    if (!(target instanceof Material)) return undefined;
    if ('isNodeMaterialInstance' in target && nodeDefinition(target) === target) return undefined;
    return target;
  }
  return Reflect.get(input, input.constructor === UserDataNode ? 'userData' : 'object');
}

/** One direct field read, without graph evaluation, cache mutation or mirrored parameters. */
export function referenceValue(material: Material, input: ReferenceInput): unknown {
  const target = referenceTarget(material, input);
  return target !== null && (typeof target === 'object' || typeof target === 'function')
    ? Reflect.get(target, input.properties[0] ?? '')
    : undefined;
}
