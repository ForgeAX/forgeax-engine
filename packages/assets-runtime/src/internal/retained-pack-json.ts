import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { retainJsonMaterialFacts } from './retained-material-facts.js';

// Capture optional platform methods without consulting response.text or function.call.
// The fast path assumes standard platform Body semantics, not arbitrary polyfills.
// A global subclass or adapter prototype must retain the original json-reader path.
const responsePrototype = globalThis.Response?.prototype;
const platformResponsePrototype =
  responsePrototype !== null &&
  typeof responsePrototype === 'object' &&
  Object.getPrototypeOf(responsePrototype) === Object.prototype
    ? responsePrototype
    : undefined;
const platformReadJson =
  platformResponsePrototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(platformResponsePrototype, 'json')?.value;
const platformReadText =
  platformResponsePrototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(platformResponsePrototype, 'text')?.value;

/** Retain only owner-parsed platform JSON; custom readers keep their original ownership. */
export async function readRetainedPackJson(response: Pick<Response, 'json'>): Promise<unknown> {
  const readJson = response.json;
  if (
    typeof platformReadJson === 'function' &&
    typeof platformReadText === 'function' &&
    readJson === platformReadJson &&
    Object.getPrototypeOf(response) === platformResponsePrototype &&
    !Object.hasOwn(response, 'json') &&
    !Object.hasOwn(response, 'text') &&
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'json')?.value ===
      platformReadJson &&
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'text')?.value === platformReadText
  ) {
    return parseRetainedPackJson(await Reflect.apply(platformReadText, response, []));
  }
  return Reflect.apply(readJson, response, []);
}

// Only JSON text parsed by this owner can acquire the retained-tree brand.
// Public cache objects, including proxies around parsed nodes, are never branded.
const parsedShapes = new WeakMap<object, number | readonly string[]>();

export function parseRetainedPackJson(text: string): unknown {
  const decoded = decodeMaterialProgramWire(JSON.parse(text));
  if (!decoded.ok) throw new SyntaxError('Invalid package material program table');
  const value: unknown = decoded.value;
  // Retention is consumed only by plugin definition reads. Resource-only
  // production packages never need an ownership audit over every payload.
  if (value !== null && typeof value === 'object') {
    const pack = value as { readonly kind?: unknown; readonly assets?: unknown };
    if (
      pack.kind === 'internal-text-package' &&
      Array.isArray(pack.assets) &&
      pack.assets.length > 0 &&
      pack.assets.every(
        (asset) =>
          asset !== null &&
          typeof asset === 'object' &&
          typeof asset.kind === 'string' &&
          asset.kind !== 'plugin' &&
          asset.payload !== null &&
          typeof asset.payload === 'object' &&
          asset.payload.kind === asset.kind,
      )
    ) {
      retainJsonMaterialFacts(pack.assets);
      return value;
    }
  }
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    // JSON arrays are dense. Their length describes every own key without
    // retaining millions of index strings beside mesh and texture payloads.
    if (Array.isArray(node)) {
      parsedShapes.set(node, node.length);
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === 'object') pending.push(child);
      }
    } else {
      const keys = Object.keys(node);
      parsedShapes.set(node, keys);
      for (const key of keys) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') pending.push(child);
      }
    }
  }
  return value;
}

/** Recheck current data descriptors and ownership; a parse-time brand alone is insufficient. */
export function isRetainedJsonTree(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !parsedShapes.has(value)) return false;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    const original = parsedShapes.get(node);
    if (original === undefined || visited.has(node)) return false;
    visited.add(node);
    const array = typeof original === 'number';
    if (Object.getPrototypeOf(node) !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(node);
    if (keys.length !== (typeof original === 'number' ? original + 1 : original.length))
      return false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const expected =
        typeof original === 'number' ? (i === original ? 'length' : String(i)) : original[i];
      if (typeof key !== 'string' || key !== expected) return false;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
      if (array && key === 'length') {
        if (
          descriptor.enumerable ||
          !Number.isSafeInteger(descriptor.value) ||
          descriptor.value !== keys.length - 1
        )
          return false;
        continue;
      }
      if (!descriptor.enumerable) return false;
      const child: unknown = descriptor.value;
      if (child === null || typeof child === 'string' || typeof child === 'boolean') continue;
      if (typeof child === 'number') {
        if (!Number.isFinite(child)) return false;
      } else if (typeof child === 'object') {
        pending.push(child);
      } else {
        return false;
      }
    }
  }
  return true;
}
