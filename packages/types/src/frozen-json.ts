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

/**
 * Realm-wide structural sharing of plain JSON. Nodes are canonicalized
 * bottom-up: a node whose content equals an already canonical node is
 * replaced by that node, so equal subtrees received or parsed separately are
 * held once. A node key spells its primitive fields exactly (negative zero
 * stays distinct) and refers to children by explicitly terminated canonical
 * ids, so a child's decimal id cannot merge with the next field-length prefix.
 * Canonical nodes are frozen before they become
 * shareable; the table holds them weakly.
 */
const canonicalIds = new WeakMap<object, number>();
const canonicalNodes = new Map<string, WeakRef<object>>();
const collectedNodes =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<string>((key) => {
        if (canonicalNodes.get(key)?.deref() === undefined) canonicalNodes.delete(key);
      })
    : undefined;
let nextCanonicalId = 1;

function leafKey(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`;
    case 'number':
      // JSON text cannot carry non-finite numbers; -0 stays distinct from 0.
      return Number.isFinite(value) ? (Object.is(value, -0) ? 'n-0,' : `n${value},`) : undefined;
    case 'boolean':
      return value ? 't' : 'f';
    default:
      return value === null ? 'z' : undefined;
  }
}

/**
 * The canonical deep-frozen node equal to `node`, or undefined when `node` is
 * not plain exact JSON. Unfrozen input nodes are adopted in place: their
 * object children are replaced by the canonical equal nodes and the node is
 * frozen when it becomes canonical, so only pass freshly owned JSON (a parsed
 * document or a Worker structured clone). Independently frozen input nodes are
 * copied only when adopting a canonical child requires a write. Sparse arrays,
 * observable properties and cycles are rejected. The result satisfies
 * {@link isDeepFrozenJson}, so holders may share it by identity.
 */
export function internJson<T extends object>(node: T): T | undefined {
  if (canonicalIds.has(node)) return node;
  return internJsonNode(node, new Set()) as T | undefined;
}

/** JSON has enumerable data fields and dense arrays; reject other observations before reading. */
function jsonFields(node: object, array: boolean): readonly string[] | undefined {
  const keys = Reflect.ownKeys(node);
  const fields: string[] = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor?.enumerable !== true || !('value' in descriptor)) return undefined;
    if (array && key !== String(fields.length)) return undefined;
    fields.push(key);
  }
  if (array && fields.length !== (node as readonly unknown[]).length) return undefined;
  return fields;
}

function internJsonNode(node: object, ancestors: Set<object>): object | undefined {
  if (canonicalIds.has(node)) return node;
  if (ancestors.has(node)) return undefined;
  const array = Array.isArray(node);
  if (Object.getPrototypeOf(node) !== (array ? Array.prototype : Object.prototype))
    return undefined;
  const fields = jsonFields(node, array);
  if (fields === undefined) return undefined;
  ancestors.add(node);
  try {
    return internJsonFields(node, fields, array, ancestors);
  } finally {
    ancestors.delete(node);
  }
}

function internJsonFields(
  node: object,
  fields: readonly string[],
  array: boolean,
  ancestors: Set<object>,
): object | undefined {
  let record = node as Record<string, unknown>;
  let key = array ? '[' : '{';
  for (const field of fields) {
    if (!array) key += `${field.length}:${field}`;
    const child = record[field];
    if (child !== null && typeof child === 'object') {
      const canonical = internJsonNode(child, ancestors);
      if (canonical === undefined) return undefined;
      if (canonical !== child) {
        // Independently frozen input is safe too: copy only if adopting a
        // canonical child would otherwise write a readonly property.
        if (Object.getOwnPropertyDescriptor(record, field)?.writable !== true)
          record = (array ? [...(record as unknown as unknown[])] : { ...record }) as Record<
            string,
            unknown
          >;
        record[field] = canonical;
      }
      key += `#${canonicalIds.get(canonical)};`;
    } else {
      const leaf = leafKey(child);
      if (leaf === undefined) return undefined;
      key += leaf;
    }
  }
  const known = canonicalNodes.get(key)?.deref();
  if (known !== undefined) return known;
  Object.freeze(record);
  canonicalIds.set(record, nextCanonicalId++);
  canonicalNodes.set(key, new WeakRef(record));
  collectedNodes?.register(record, key);
  return record;
}
