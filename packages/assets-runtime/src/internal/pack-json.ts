import { decodeDocumentText } from '@forgeax/engine-codec';

// Capture optional platform methods without consulting function.call.
// The fast path assumes standard platform Body semantics, not arbitrary polyfills.
// A global subclass or adapter prototype must keep the original json-reader path.
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
export async function readDocumentJson(response: Pick<Response, 'json'>): Promise<unknown> {
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
  return JSON.parse(text.value);
}
