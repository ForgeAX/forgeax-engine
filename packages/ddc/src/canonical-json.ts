import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

// Base64 chunks must end on a complete three-byte group.
const CHUNK_SIZE = 48 * 1024;
const NUMERIC_RUN_SIZE = 1024;

interface VerifiedReadbackJson {
  readonly value: object;
  readonly json: Uint8Array;
}

function* textChunks(input: string): Generator<string> {
  for (let offset = 0; offset < input.length; ) {
    let end = Math.min(offset + CHUNK_SIZE, input.length);
    const last = input.charCodeAt(end - 1);
    const next = input.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
    yield input.slice(offset, end);
    offset = end;
  }
}

function* readbackTextChunks(bytes: Uint8Array): Generator<string> {
  const decoder = new TextDecoder();
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    yield decoder.decode(bytes.subarray(offset, offset + CHUNK_SIZE), { stream: true });
  }
  yield decoder.decode();
}

/** One canonical byte sequence, consumed either as JSON text or incrementally. */
function* canonicalDdcChunks(
  value: unknown,
  readerOwned = false,
  verified?: VerifiedReadbackJson,
): Generator<string> {
  const binary = new Map<object, Buffer>();
  function sortValue(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input;
    if (input instanceof Uint8Array) {
      const encoded = { encoding: 'base64', bytes: '' };
      // Author getters require a snapshot. Private readback buffers have no
      // external writer and can stream their existing view instead.
      binary.set(
        encoded,
        readerOwned
          ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
          : Buffer.from(input),
      );
      return encoded;
    }
    if (Array.isArray(input)) return readerOwned ? input : input.map(sortValue);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const child = (input as Record<string, unknown>)[key];
      result[key] = readerOwned ? child : sortValue(child);
    }
    return result;
  }

  function* emit(input: unknown, key: string, prefix = ''): Generator<string, boolean> {
    const original = input;
    // Parsed readback owns its JSON graph. Order one object at a time instead
    // of duplicating every decoded array before the first bounded chunk.
    if (readerOwned) input = sortValue(input);
    if (typeof input === 'string') {
      if (prefix) yield prefix;
      yield '"';
      for (const chunk of textChunks(input)) yield JSON.stringify(chunk).slice(1, -1);
      yield '"';
      return true;
    }
    if (
      ((input !== null && typeof input === 'object') || typeof input === 'function') &&
      'toJSON' in input &&
      typeof input.toJSON === 'function'
    ) {
      // Native JSON owns arbitrary user callbacks, including their property key.
      // Producer POD and binary inputs take the bounded streaming path below.
      // Expose ordinary writable values before any callback can inspect them.
      for (const [wrapper, snapshot] of binary) {
        Object.assign(wrapper, { bytes: snapshot.toString('base64') });
      }
      binary.clear();
      const json = JSON.stringify({ [key]: input });
      if (json === '{}') return false;
      if (prefix) yield prefix;
      yield json.slice(JSON.stringify(key).length + 2, -1);
      return true;
    }
    // Preserve key-dependent toJSON handling before reusing a payload fragment.
    if (verified !== undefined && original === verified.value) {
      if (prefix) yield prefix;
      yield* readbackTextChunks(verified.json);
      return true;
    }
    if (input === null || typeof input !== 'object') {
      // JSON numbers use ECMAScript Number::toString, except non-finite values.
      // Large cooked byte arrays must not invoke the native JSON encoder per byte.
      const json =
        typeof input === 'number'
          ? Number.isFinite(input)
            ? String(input)
            : 'null'
          : JSON.stringify(input);
      if (json === undefined) return false;
      if (prefix) yield prefix;
      yield json;
      return true;
    }
    if (prefix) yield prefix;
    const bytes = binary.get(input);
    if (bytes !== undefined) {
      if (readerOwned) binary.delete(input);
      // This order predates streaming: binary wrappers bypass object sorting.
      yield '{"encoding":"base64","bytes":"';
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
        yield Buffer.from(
          bytes.buffer,
          bytes.byteOffset + offset,
          Math.min(CHUNK_SIZE, bytes.byteLength - offset),
        ).toString('base64');
      }
      yield '"}';
      return true;
    }
    if (Array.isArray(input)) {
      yield '[';
      // A callback may later install Array.prototype.toJSON. This internal
      // buffer must encode only its own numeric values, never author callbacks.
      const numbers: number[] = [];
      Object.setPrototypeOf(numbers, null);
      let runStart = 0;
      function flushNumbers(): string {
        const json = `${runStart > 0 ? ',' : ''}${JSON.stringify(numbers).slice(1, -1)}`;
        numbers.length = 0;
        return json;
      }
      for (let index = 0; index < input.length; index++) {
        const item = input[index];
        // Cooked JSON contains large numeric byte arrays. Yield bounded runs,
        // rather than forwarding each byte through every ancestor generator.
        if (typeof item === 'number') {
          if (numbers.length === 0) runStart = index;
          numbers[numbers.length] = item;
          if (numbers.length === NUMERIC_RUN_SIZE) yield flushNumbers();
          continue;
        }
        if (numbers.length > 0) yield flushNumbers();
        if (index > 0) yield ',';
        if (!(yield* emit(item, String(index)))) yield 'null';
      }
      if (numbers.length > 0) yield flushNumbers();
      yield ']';
      return true;
    }
    yield '{';
    let first = true;
    // Object.keys retains ECMAScript integer-index order after canonical sorting.
    for (const property of Object.keys(input)) {
      if (
        yield* emit(
          (input as Record<string, unknown>)[property],
          property,
          `${first ? '' : ','}${JSON.stringify(property)}:`,
        )
      )
        first = false;
    }
    yield '}';
    return true;
  }
  if (!(yield* emit(readerOwned ? value : sortValue(value), ''))) yield 'null';
}

export function writeCanonicalDdcJson(value: unknown, write: (chunk: string) => void): void {
  for (const chunk of canonicalDdcChunks(value)) write(chunk);
}

export function canonicalDdcDigest(value: unknown): string {
  const hash = createHash('sha256');
  // Small scalar/punctuation chunks must not cross the native hash boundary
  // individually. Bound the joined text while retaining exactly the same bytes.
  let pending = '';
  writeCanonicalDdcJson(value, (chunk) => {
    pending += chunk;
    if (pending.length >= CHUNK_SIZE) {
      hash.update(pending);
      pending = '';
    }
  });
  if (pending.length > 0) hash.update(pending);
  return hash.digest('hex');
}

/** Only reader-owned JSON/bytes: source callbacks must stay on the synchronous path. */
export async function canonicalDdcReadbackDigest(value: unknown): Promise<string> {
  return readbackDigest(value);
}

/** Reuse only file text proven equal to the private payload's canonical bytes. */
export async function canonicalDdcReadbackDigests(
  values: { readonly payload: unknown; readonly output: unknown; readonly entry: unknown },
  payloadJson: Uint8Array,
): Promise<{ readonly payload: string; readonly output: string; readonly entry: string }> {
  const payload = await readbackDigest(values.payload);
  const verified =
    values.payload !== null &&
    typeof values.payload === 'object' &&
    (await digestChunks(readbackTextChunks(payloadJson))) === payload
      ? { value: values.payload, json: payloadJson }
      : undefined;
  return {
    payload,
    output: await readbackDigest(values.output, verified),
    entry: await readbackDigest(values.entry, verified),
  };
}

async function readbackDigest(value: unknown, verified?: VerifiedReadbackJson): Promise<string> {
  return digestChunks(canonicalDdcChunks(value, true, verified));
}

async function digestChunks(chunks: Iterable<string>): Promise<string> {
  const hash = createHash('sha256');
  let pending = '';
  let yieldedAt = performance.now();
  for (const chunk of chunks) {
    pending += chunk;
    if (pending.length >= CHUNK_SIZE) {
      hash.update(pending);
      pending = '';
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate();
        yieldedAt = performance.now();
      }
    }
  }
  if (pending.length > 0) hash.update(pending);
  return hash.digest('hex');
}
