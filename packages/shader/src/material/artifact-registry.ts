import { err, isDeepFrozenJson, ok, type Result } from '@forgeax/engine-types';

export interface MaterialRuntimeArtifact {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly digest?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MaterialArtifactInspection {
  readonly key: string;
  readonly digest?: string;
  readonly byteLength: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MaterialArtifactConflictError {
  readonly code: 'material-artifact-conflict';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly key: string;
    readonly dimension: 'bytes' | 'param-schema' | 'receipt';
    readonly existingDigest?: string;
    readonly incomingDigest?: string;
  };
}

type IntrinsicGetter = (this: unknown) => unknown;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicGetter = (owner: object, key: PropertyKey): IntrinsicGetter | undefined =>
  Object.getOwnPropertyDescriptor(owner, key)?.get;
const byteStorageTag = intrinsicGetter(typedArrayPrototype, Symbol.toStringTag);
const byteStorageBuffer = intrinsicGetter(typedArrayPrototype, 'buffer');
const byteStorageOffset = intrinsicGetter(typedArrayPrototype, 'byteOffset');
const byteStorageLength = intrinsicGetter(typedArrayPrototype, 'byteLength');
const ordinaryBufferLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');
const ordinaryBufferPrototype = ArrayBuffer.prototype;
const nativeGetPrototypeOf = Object.getPrototypeOf;

/** Private native view without author property reads; shared/non-byte storage stays byte-wise. */
function ordinaryByteWords(value: Uint8Array, length: number): Uint32Array | undefined {
  if (
    !byteStorageTag ||
    !byteStorageBuffer ||
    !byteStorageOffset ||
    !byteStorageLength ||
    !ordinaryBufferLength
  )
    return undefined;
  try {
    if (byteStorageTag.call(value) !== 'Uint8Array') return undefined;
    const buffer = byteStorageBuffer.call(value);
    // Cheap ordinary-owner admission avoids throwing for each SharedArrayBuffer comparison.
    // Unknown/cross-realm prototypes keep the original byte path. The intrinsic still
    // rejects a shared buffer whose prototype was replaced by an author.
    if (nativeGetPrototypeOf(buffer) !== ordinaryBufferPrototype) return undefined;
    ordinaryBufferLength.call(buffer);
    const offset = byteStorageOffset.call(value);
    const available = byteStorageLength.call(value);
    if (
      typeof offset !== 'number' ||
      offset % 4 !== 0 ||
      typeof available !== 'number' ||
      length > available
    )
      return undefined;
    return new Uint32Array(buffer as ArrayBuffer, offset + 16, Math.floor((length - 16) / 4));
  } catch {
    return undefined;
  }
}

export function equalMaterialArtifactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.length;
  if (length !== right.length) return false;
  // Preserve TypedArray.every's detached/out-of-bounds validation without a byte callback.
  Uint8Array.prototype.values.call(left);
  if (left === right) return true;
  let index = 0;
  if (Number.isSafeInteger(length) && length >= 256) {
    // Preserve cheap ordered early conflicts before allocating any word views.
    for (; index < 16; index++) if (left[index] !== right[index]) return false;
    const rightWords = ordinaryByteWords(right, length);
    const leftWords = rightWords === undefined ? undefined : ordinaryByteWords(left, length);
    if (leftWords !== undefined && rightWords !== undefined) {
      for (let word = 0; word < leftWords.length; word++)
        if (leftWords[word] !== rightWords[word]) return false;
      index += leftWords.length * 4;
    }
  }
  for (; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * `JSON.stringify(left) === JSON.stringify(right)` for deep-frozen JSON, without
 * building either string. Returns undefined where the serializer's own rules
 * decide (`undefined` members, non-finite numbers), so the caller keeps the
 * canonical comparison there. Members compare in key order, as they serialize.
 */
function equalFrozenJson(left: unknown, right: unknown): boolean | undefined {
  if (left === right) return typeof left === 'number' && !Number.isFinite(left) ? undefined : true;
  if (left === undefined || right === undefined) return undefined;
  if (typeof left !== typeof right) return undefined;
  if (typeof left === 'number')
    return Number.isFinite(left) && Number.isFinite(right) ? false : undefined;
  if (typeof left === 'string' || typeof left === 'boolean') return false;
  if (left === null || right === null || typeof left !== 'object') return undefined;
  return equalFrozenJsonNodes(left as object, right as object);
}

/** Arrays serialize by index over their length: a hole is `null`, a named property is not emitted. */
function equalFrozenJsonArrays(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean | undefined {
  if (left.length !== right.length) return false;
  let undecided = false;
  for (let index = 0; index < left.length; index++) {
    const equal = equalFrozenJson(left[index], right[index]);
    if (equal === false) return false;
    if (equal === undefined) undecided = true;
  }
  return undecided ? undefined : true;
}

function equalFrozenJsonNodes(left: object, right: object): boolean | undefined {
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) return equalFrozenJsonArrays(left, right as readonly unknown[]);
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return undefined;
  let undecided = false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index] as string;
    if (key !== rightKeys[index]) return undefined;
    const equal = equalFrozenJson(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    );
    if (equal === false) return false;
    if (equal === undefined) undecided = true;
  }
  return undecided ? undefined : true;
}

// Structural verdict for distinct deep-frozen values; undefined leaves the
// decision to the canonical JSON comparison.
function frozenJsonVerdict(left: unknown, right: unknown): boolean | undefined {
  if (left === right) return typeof left === 'object' && left !== null ? true : undefined;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return undefined;
  if (!isDeepFrozenJson(left) || !isDeepFrozenJson(right)) return undefined;
  return equalFrozenJson(left, right);
}

function equalParamSchema(left: MaterialRuntimeArtifact, right: MaterialRuntimeArtifact): boolean {
  const a = left.metadata?.paramSchema;
  const b = right.metadata?.paramSchema;
  if (a === b) return true;
  return frozenJsonVerdict(a, b) ?? JSON.stringify(a) === JSON.stringify(b);
}

function equalReceipt(left: MaterialRuntimeArtifact, right: MaterialRuntimeArtifact): boolean {
  const leftAbi = left.metadata?.abi;
  const leftReceipt = left.metadata?.receipt;
  const rightAbi = right.metadata?.abi;
  const rightReceipt = right.metadata?.receipt;
  if (leftAbi === rightAbi && leftReceipt === rightReceipt) return true;
  const abi = leftAbi === rightAbi ? true : frozenJsonVerdict(leftAbi, rightAbi);
  const receipt =
    leftReceipt === rightReceipt ? true : frozenJsonVerdict(leftReceipt, rightReceipt);
  if (abi === false || receipt === false) return false;
  if (abi === true && receipt === true) return true;
  return JSON.stringify([leftAbi, leftReceipt]) === JSON.stringify([rightAbi, rightReceipt]);
}

/**
 * Content identity of two artifacts registered under one key. A published
 * digest is the content address computed once, when the program was cooked
 * and verified on load; equal digests therefore denote equal bytes without
 * another comparison. Bytes without a digest on either side, or with differing
 * digest spellings, keep the byte comparison.
 */
function sameArtifactContent(
  previous: MaterialRuntimeArtifact,
  incoming: MaterialRuntimeArtifact,
): boolean {
  if (previous.digest !== undefined && previous.digest === incoming.digest) return true;
  return equalMaterialArtifactBytes(previous.bytes, incoming.bytes);
}

function artifactConflict(
  previous: MaterialRuntimeArtifact,
  incoming: MaterialRuntimeArtifact,
  dimension: MaterialArtifactConflictError['detail']['dimension'],
  expected: string,
  hint: string,
): MaterialArtifactConflictError {
  return {
    code: 'material-artifact-conflict',
    expected,
    hint,
    detail: {
      key: incoming.key,
      dimension,
      ...(previous.digest ? { existingDigest: previous.digest } : {}),
      ...(incoming.digest ? { incomingDigest: incoming.digest } : {}),
    },
  };
}

/**
 * The conflict between an artifact already held for a key and an incoming
 * artifact for the same key, or undefined when the incoming one is the same
 * immutable artifact. Callers preflight a whole set with this before mutating
 * any registry.
 */
export function materialArtifactConflict(
  previous: MaterialRuntimeArtifact,
  incoming: MaterialRuntimeArtifact,
): MaterialArtifactConflictError | undefined {
  if (!sameArtifactContent(previous, incoming))
    return artifactConflict(
      previous,
      incoming,
      'bytes',
      'one immutable artifact byte sequence per specialization key',
      're-cook the conflicting specialization and publish one artifact digest',
    );
  if (!equalParamSchema(previous, incoming))
    return artifactConflict(
      previous,
      incoming,
      'param-schema',
      'one immutable parameter schema per specialization key',
      're-cook the conflicting specialization with one canonical parameter schema',
    );
  if (!equalReceipt(previous, incoming))
    return artifactConflict(
      previous,
      incoming,
      'receipt',
      'one immutable ABI receipt per specialization key',
      're-cook the conflicting specialization with one canonical ABI receipt',
    );
  return undefined;
}

export class MaterialArtifactRegistry {
  readonly #artifacts = new Map<string, MaterialRuntimeArtifact>();

  register(
    artifact: MaterialRuntimeArtifact,
  ): Result<MaterialRuntimeArtifact, MaterialArtifactConflictError> {
    const previous = this.#artifacts.get(artifact.key);
    if (previous !== undefined) {
      const conflict = materialArtifactConflict(previous, artifact);
      return conflict === undefined ? ok(previous) : err(conflict);
    }
    const immutable = Object.freeze(artifact);
    this.#artifacts.set(artifact.key, immutable);
    return ok(immutable);
  }

  get(key: string): MaterialRuntimeArtifact | undefined {
    return this.#artifacts.get(key);
  }

  inspect(key: string): MaterialArtifactInspection | undefined {
    const artifact = this.#artifacts.get(key);
    if (artifact === undefined) return undefined;
    return {
      key: artifact.key,
      ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
      byteLength: artifact.bytes.byteLength,
      ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
    };
  }
}
