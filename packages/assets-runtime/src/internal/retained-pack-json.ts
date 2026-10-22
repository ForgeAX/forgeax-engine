import { decodeDocumentText } from '@forgeax/engine-codec';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { retainJsonMaterialFacts } from './retained-material-facts.js';

// Capture optional platform methods without consulting function.call.
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
const platformReadArrayBuffer =
  platformResponsePrototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(platformResponsePrototype, 'arrayBuffer')?.value;

/**
 * Parse a document body. A standard platform Response body is read as bytes so a
 * zstd-stored delivery document decodes here; custom readers own their body and
 * its encoding and keep their original json result.
 */
async function readDocument(
  response: Pick<Response, 'json'>,
  parse: (text: string) => unknown,
): Promise<unknown> {
  const readJson = response.json;
  if (
    typeof platformReadJson !== 'function' ||
    typeof platformReadArrayBuffer !== 'function' ||
    readJson !== platformReadJson ||
    Object.getPrototypeOf(response) !== platformResponsePrototype ||
    Object.hasOwn(response, 'json') ||
    Object.hasOwn(response, 'arrayBuffer') ||
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'json')?.value !==
      platformReadJson ||
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'arrayBuffer')?.value !==
      platformReadArrayBuffer
  )
    return Reflect.apply(readJson, response, []);
  const bytes: ArrayBuffer = await Reflect.apply(platformReadArrayBuffer, response, []);
  const text = await decodeDocumentText(new Uint8Array(bytes));
  if (!text.ok) throw new SyntaxError(`document decode failed: ${text.error.code}`);
  return parse(text.value);
}

/** Read a catalog or other JSON document body. */
export const readDocumentJson = (response: Pick<Response, 'json'>): Promise<unknown> =>
  readDocument(response, JSON.parse);

/** Retain only owner-parsed platform JSON; custom readers keep their original ownership. */
export const readRetainedPackJson = (response: Pick<Response, 'json'>): Promise<unknown> =>
  readDocument(response, parseRetainedPackJson);

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
