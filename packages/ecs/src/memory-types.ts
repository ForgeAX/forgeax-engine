export type MemoryArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;
export interface MemoryArrayConstructor<T extends MemoryArray = MemoryArray> {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
}
const CONSTRUCTORS = new Set<MemoryArrayConstructor>([
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
]);
export type MemoryErrorDetail =
  | { readonly kind: 'request'; readonly reason: 'layout' | 'count' | 'configuration' }
  | { readonly kind: 'budget'; readonly requestedBytes: number; readonly limitBytes: number }
  | { readonly kind: 'allocation'; readonly requestedBytes: number; readonly cause: unknown }
  | {
      readonly kind: 'scope';
      readonly reason: 'closed' | 'reentrant' | 'asynchronous' | 'callback-failed';
      readonly cause?: unknown;
    }
  | {
      readonly kind: 'handle';
      readonly reason: 'wrong-owner' | 'released' | 'borrowed' | 'lease-released';
    };
export type MemoryErrorCode =
  | 'memory-request-invalid'
  | 'memory-budget-exceeded'
  | 'memory-allocation-failed'
  | 'memory-scope-invalid'
  | 'memory-handle-invalid';
export class MemoryError extends Error {
  override readonly name = 'MemoryError';
  readonly code: MemoryErrorCode;
  readonly expected = 'valid owned storage within its admitted lifetime and byte budget';
  readonly hint = 'Inspect detail; repair the request, budget or lifetime before retrying.';
  constructor(readonly detail: MemoryErrorDetail) {
    super(`ECS memory ${detail.kind} failure. Inspect detail before retrying.`);
    switch (detail.kind) {
      case 'request':
        this.code = 'memory-request-invalid';
        break;
      case 'budget':
        this.code = 'memory-budget-exceeded';
        break;
      case 'allocation':
        this.code = 'memory-allocation-failed';
        break;
      case 'scope':
        this.code = 'memory-scope-invalid';
        break;
      case 'handle':
        this.code = 'memory-handle-invalid';
        break;
    }
  }
}
export function memoryByteLength(
  ctor: MemoryArrayConstructor,
  count: number,
): number | MemoryError {
  if (!CONSTRUCTORS.has(ctor)) return new MemoryError({ kind: 'request', reason: 'layout' });
  const bytes = count * ctor.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytes))
    return new MemoryError({ kind: 'request', reason: 'count' });
  return bytes;
}
export interface MemoryBudget {
  /** Hard limit for backing owned by this service, including idle capacity. */
  readonly maxBytes?: number;
  /** Soft idle retention target, enforced at safe trim boundaries. */
  readonly retainBytes?: number;
}
export interface WorldMemoryOptions {
  readonly arena?: MemoryBudget & { readonly maxScopeBytes?: number };
  /** Covers owned-buffer requests against the shared pool; component admission remains unchanged. */
  readonly buffers?: MemoryBudget;
}
export function memoryLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new MemoryError({ kind: 'request', reason: 'configuration' });
  return result;
}

/** Synchronous execution cannot admit a reader suspended past scope close. */
export function isSuspendedMemoryResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && ('then' in value || 'next' in value);
}
