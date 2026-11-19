/**
 * True when `value` is a deep-frozen plain JSON tree: every node is frozen, has
 * the plain array or object prototype, and exposes only enumerable string-keyed
 * data properties whose values are JSON primitives, `undefined`, or such trees.
 * No owner can change such a value, so holders may share it by identity instead
 * of keeping a private copy. Cycles are not JSON and are not supported.
 */
export function isDeepFrozenJson(value: object): boolean {
  return isDeepFrozenJsonNode(value, new Set());
}

/**
 * Trees already proven deep-frozen JSON. A frozen node's properties and their
 * frozen descendants can never change, so a positive answer is permanent and
 * later checks of the same tree, or of any subtree it contains, are O(1).
 */
const verifiedFrozenJson = new WeakSet<object>();

function isEnumerableDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor;
}

function isDeepFrozenJsonNode(value: object, ancestors: Set<object>): boolean {
  if (verifiedFrozenJson.has(value)) return true;
  if (!Object.isFrozen(value) || ArrayBuffer.isView(value) || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataProperty(descriptor)) return false;
      const child: unknown = descriptor.value;
      if (child === null || child === undefined) continue;
      const type = typeof child;
      if (type === 'object') {
        if (!isDeepFrozenJsonNode(child as object, ancestors)) return false;
      } else if (type !== 'string' && type !== 'number' && type !== 'boolean') return false;
    }
    verifiedFrozenJson.add(value);
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Freezes a freshly owned plain JSON tree in place and returns it. The owner
 * calls this once when it builds the tree, so no table or proof is kept: the
 * frozen tree is shared by identity exactly as long as its owner holds it.
 * A frozen node is an adopted subtree and is not walked again; freezing a node
 * before its children also lets a cyclic graph terminate.
 */
export function freezeJson<T extends object>(node: T): T {
  if (Object.isFrozen(node)) return node;
  Object.freeze(node);
  for (const child of Object.values(node))
    if (child !== null && typeof child === 'object') freezeJson(child);
  return node;
}
