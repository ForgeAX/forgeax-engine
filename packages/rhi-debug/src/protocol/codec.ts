import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import pako from 'pako';
import { createRhiDebugError } from '../errors';
import {
  type RhiCallEvent,
  TAPE_FORMAT_VERSION,
  TAPE_MAGIC,
  type Tape,
  type TapeBlobCompression,
  type TapeEncodeOptions,
} from './types';
import { validateTape } from './validation';

const MAGIC_BYTES = new TextEncoder().encode(TAPE_MAGIC);
/** Fixed container preamble: magic, version, index length, payload length. */
export const TAPE_PREAMBLE_BYTES = MAGIC_BYTES.byteLength + 12;

type TapeInvalid = ReturnType<typeof createRhiDebugError<'tape-invalid'>>;
type TapeDecodeError =
  | TapeInvalid
  | ReturnType<typeof createRhiDebugError<'tape-version-unsupported'>>;

/** One blob-table row: where a payload lives in the container and its SHA-256. */
export interface TapeBlobEntry {
  readonly hash: string;
  readonly offset: number;
  readonly length: number;
  readonly compression: TapeBlobCompression;
  readonly digest: string;
}

/** The validated container index; blob payloads are located, not resident. */
export interface TapeContainerIndex {
  readonly header: Tape['header'];
  readonly bootstrap: Tape['bootstrap'];
  readonly events: readonly RhiCallEvent[];
  readonly blobs: readonly TapeBlobEntry[];
  /** Absolute container offset of the first payload byte. */
  readonly payloadStart: number;
  /** Exact container length the preamble declares. */
  readonly byteLength: number;
}

/** A container as ordered zero-copy parts: preamble+index, then blob payloads. */
export interface EncodedTapeParts {
  readonly parts: readonly Uint8Array[];
  readonly byteLength: number;
}

/** @internal Recorder blob hashes are SHA-256 of the raw bytes, so uncompressed digests are known. */
export interface EncodePartsOptions extends TapeEncodeOptions {
  readonly contentHashes?: boolean;
}

export function encodeTapeParts(
  tape: Tape,
  options: EncodePartsOptions = {},
): Result<EncodedTapeParts, TapeInvalid> {
  const validation = validateTape(tape);
  if (!validation.ok) return validation;
  const compression = options.compression ?? tape.blobs[0]?.compression ?? 'none';
  const payloads: Uint8Array[] = [];
  const blobs: TapeBlobEntry[] = [];
  let offset = 0;
  for (const blob of tape.blobs) {
    // Parts borrow the blob bytes; callers that need ownership materialize once.
    const raw = blob.bytes;
    const payload = compression === 'gzip' ? pako.gzip(raw) : raw;
    payloads.push(payload);
    const known = options.contentHashes === true && compression === 'none';
    blobs.push({
      hash: blob.hash,
      offset,
      length: payload.byteLength,
      compression,
      digest: known ? blob.hash : digestBytes(payload),
    });
    offset += payload.byteLength;
  }
  const json = canonicalJson({
    header: { ...tape.header, blobCount: blobs.length },
    bootstrap: tape.bootstrap,
    events: tape.events,
    blobs,
  });
  const jsonBytes = new TextEncoder().encode(json);
  const head = new Uint8Array(TAPE_PREAMBLE_BYTES + jsonBytes.byteLength);
  head.set(MAGIC_BYTES, 0);
  const view = new DataView(head.buffer);
  view.setUint32(MAGIC_BYTES.byteLength, TAPE_FORMAT_VERSION, true);
  view.setUint32(MAGIC_BYTES.byteLength + 4, jsonBytes.byteLength, true);
  view.setUint32(MAGIC_BYTES.byteLength + 8, offset, true);
  head.set(jsonBytes, TAPE_PREAMBLE_BYTES);
  return ok({ parts: [head, ...payloads], byteLength: head.byteLength + offset });
}

export function encodeTape(
  tape: Tape,
  options: TapeEncodeOptions = {},
): Result<Uint8Array, TapeInvalid> {
  const encoded = encodeTapeParts(tape, options);
  if (!encoded.ok) return encoded;
  return ok(concatParts(encoded.value.parts, encoded.value.byteLength));
}

export function concatParts(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

/** Fixed-size container windows; a window inside one part is a view, a spanning one a copy. */
export function* sliceParts(
  parts: readonly Uint8Array[],
  chunkBytes: number,
): Generator<{ readonly offset: number; readonly bytes: Uint8Array }> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  let partIndex = 0;
  let partOffset = 0;
  for (let offset = 0; offset < total; offset += chunkBytes) {
    const length = Math.min(chunkBytes, total - offset);
    let part = parts[partIndex] ?? new Uint8Array();
    while (partOffset === part.byteLength && partIndex < parts.length - 1) {
      partIndex += 1;
      partOffset = 0;
      part = parts[partIndex] ?? new Uint8Array();
    }
    if (part.byteLength - partOffset >= length) {
      yield { offset, bytes: part.subarray(partOffset, partOffset + length) };
      partOffset += length;
      continue;
    }
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      part = parts[partIndex] ?? new Uint8Array();
      const take = Math.min(length - filled, part.byteLength - partOffset);
      bytes.set(part.subarray(partOffset, partOffset + take), filled);
      filled += take;
      partOffset += take;
      if (partOffset === part.byteLength && partIndex < parts.length - 1) {
        partIndex += 1;
        partOffset = 0;
      }
    }
    yield { offset, bytes };
  }
}

/** Reads the preamble and returns where the index ends and how long the container is. */
export function readTapePreamble(
  preamble: Uint8Array,
): Result<{ readonly indexEnd: number; readonly byteLength: number }, TapeDecodeError> {
  if (preamble.byteLength < TAPE_PREAMBLE_BYTES)
    return err(
      createRhiDebugError('tape-invalid', { stage: 'decode', cause: 'container is truncated' }),
    );
  for (let i = 0; i < MAGIC_BYTES.byteLength; i++) {
    if (preamble[i] !== MAGIC_BYTES[i])
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'decode',
          cause: 'magic does not match RHITAPE',
        }),
      );
  }
  const view = new DataView(preamble.buffer, preamble.byteOffset, TAPE_PREAMBLE_BYTES);
  const version = view.getUint32(MAGIC_BYTES.byteLength, true);
  if (version !== TAPE_FORMAT_VERSION)
    return err(
      createRhiDebugError('tape-version-unsupported', {
        foundVersion: version,
        expectedVersion: 7,
      }),
    );
  const indexEnd = TAPE_PREAMBLE_BYTES + view.getUint32(MAGIC_BYTES.byteLength + 4, true);
  const payloadLength = view.getUint32(MAGIC_BYTES.byteLength + 8, true);
  return ok({ indexEnd, byteLength: indexEnd + payloadLength });
}

/**
 * Decodes and structurally validates the container index without touching blob
 * payloads. `prefix` must hold at least the preamble and canonical JSON.
 */
export function decodeTapeContainerIndex(
  prefix: Uint8Array,
  byteLength: number,
): Result<TapeContainerIndex, TapeDecodeError> {
  const preamble = readTapePreamble(prefix);
  if (!preamble.ok) return preamble;
  const { indexEnd } = preamble.value;
  if (indexEnd > prefix.byteLength || preamble.value.byteLength !== byteLength)
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'decode',
        cause: 'container length is out of bounds',
      }),
    );
  let wire: Omit<TapeContainerIndex, 'payloadStart' | 'byteLength'>;
  try {
    wire = JSON.parse(new TextDecoder().decode(prefix.subarray(TAPE_PREAMBLE_BYTES, indexEnd)));
  } catch {
    return err(
      createRhiDebugError('tape-invalid', { stage: 'decode', cause: 'canonical JSON is invalid' }),
    );
  }
  if (
    wire?.header?.formatVersion !== TAPE_FORMAT_VERSION ||
    !Array.isArray(wire.events) ||
    !Array.isArray(wire.blobs)
  )
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: 'required v7 fields are missing',
      }),
    );
  const payloadLength = byteLength - indexEnd;
  for (const blob of wire.blobs) {
    if (
      typeof blob?.hash !== 'string' ||
      typeof blob.digest !== 'string' ||
      (blob.compression !== 'none' && blob.compression !== 'gzip') ||
      !Number.isInteger(blob.offset) ||
      !Number.isInteger(blob.length) ||
      blob.offset < 0 ||
      blob.length < 0 ||
      blob.offset + blob.length > payloadLength
    )
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: 'blob table entry is out of bounds',
        }),
      );
  }
  const index: TapeContainerIndex = {
    header: wire.header,
    bootstrap: wire.bootstrap ?? [],
    events: wire.events,
    blobs: wire.blobs,
    payloadStart: indexEnd,
    byteLength,
  };
  return validateTape(index);
}

export function decodeTape(bytes: Uint8Array): Result<Tape, TapeDecodeError> {
  const legacy = decodeLegacyVersion(bytes);
  if (legacy !== undefined)
    return err(
      createRhiDebugError('tape-version-unsupported', { foundVersion: legacy, expectedVersion: 7 }),
    );
  const decoded = decodeTapeContainerIndex(bytes, bytes.byteLength);
  if (!decoded.ok) return decoded;
  const index = decoded.value;
  const payload = bytes.subarray(index.payloadStart);
  const blobs = [];
  for (const blob of index.blobs) {
    // Borrow the container bytes: copying every blob doubled peak memory on
    // half-gigabyte tapes. Uncompressed blobs alias the caller's buffer.
    const stored = payload.subarray(blob.offset, blob.offset + blob.length);
    if (digestBytes(stored) !== blob.digest)
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `blob digest mismatch for ${blob.hash}`,
        }),
      );
    let raw: Uint8Array;
    try {
      raw = blob.compression === 'gzip' ? new Uint8Array(pako.ungzip(stored)) : stored;
    } catch {
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'decode',
          cause: `blob decompression failed for ${blob.hash}`,
        }),
      );
    }
    blobs.push({ hash: blob.hash, bytes: raw, compression: blob.compression });
  }
  return ok({ header: index.header, bootstrap: index.bootstrap, events: index.events, blobs });
}

function decodeLegacyVersion(bytes: Uint8Array): number | undefined {
  if (bytes.length === 0 || bytes[0] !== 123) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { formatVersion?: unknown };
    return typeof parsed.formatVersion === 'number' && parsed.formatVersion !== 7
      ? parsed.formatVersion
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

interface NodeHash {
  update(bytes: Uint8Array): NodeHash;
  digest(encoding: 'hex'): string;
}

interface NodeCrypto {
  createHash(algorithm: 'sha256'): NodeHash;
}

// Node exposes a synchronous native SHA-256 (~20x the portable JS hash on
// half-gigabyte tapes); browsers keep the portable implementation.
const nodeCrypto: NodeCrypto | undefined = (
  globalThis as {
    readonly process?: { readonly getBuiltinModule?: (id: string) => unknown };
  }
).process?.getBuiltinModule?.('node:crypto') as NodeCrypto | undefined;

export function digestBytes(bytes: Uint8Array): string {
  return digestParts([bytes]);
}

/** SHA-256 of the concatenation of `parts`, without materializing it. */
export function digestParts(parts: readonly Uint8Array[]): string {
  if (nodeCrypto !== undefined) {
    const hash = nodeCrypto.createHash('sha256');
    for (const part of parts) hash.update(part);
    return `sha256:${hash.digest('hex')}`;
  }
  const hash = sha256.create();
  for (const part of parts) hash.update(part);
  return `sha256:${bytesToHex(hash.digest())}`;
}

export { digestBytesAsync } from './digest-async';
