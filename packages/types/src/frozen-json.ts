/**
 * True when `value` is a deep-frozen plain JSON tree: every node is frozen, has
 * the plain array or object prototype, and exposes only enumerable string-keyed
 * data properties whose values are JSON primitives, `undefined`, or such trees.
 * No owner can change such a value, so holders may share it by identity instead
 * of keeping a private copy. Cycles are not JSON and are not supported.
 */
export function isDeepFrozenJson(value: object): boolean {
  if (!Object.isFrozen(value) || ArrayBuffer.isView(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor))
      return false;
    const child: unknown = descriptor.value;
    if (child === null || child === undefined) continue;
    const type = typeof child;
    if (type === 'object') {
      if (!isDeepFrozenJson(child as object)) return false;
    } else if (type !== 'string' && type !== 'number' && type !== 'boolean') return false;
  }
  return true;
}
