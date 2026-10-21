const SIDE_BYTES = 1_048_576;
const MIN_BYTES = 4096;

interface EqualityKernel {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly equal: (first: number, second: number, length: number) => number;
}

let kernel: EqualityKernel | false | undefined;

function equalityKernel(): EqualityKernel | undefined {
  if (kernel !== undefined) return kernel === false ? undefined : kernel;
  kernel = false;
  if (typeof WebAssembly === 'undefined') return undefined;
  try {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32 });
    // (a,b,n) scans n/16 vectors, returning zero on the first unequal byte.
    // The module imports only its bounded scratch memory; it has no host calls.
    const module = new WebAssembly.Module(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 1, 96, 3, 127, 127, 127, 1, 127, 2, 16, 1, 3, 101, 110,
        118, 6, 109, 101, 109, 111, 114, 121, 2, 1, 32, 32, 3, 2, 1, 0, 7, 9, 1, 5, 101, 113, 117,
        97, 108, 0, 0, 10, 59, 1, 57, 1, 1, 127, 2, 64, 3, 64, 32, 3, 32, 2, 79, 13, 1, 32, 0, 32,
        3, 106, 253, 0, 4, 0, 32, 1, 32, 3, 106, 253, 0, 4, 0, 253, 35, 253, 99, 69, 4, 64, 65, 0,
        15, 11, 32, 3, 65, 16, 106, 33, 3, 12, 0, 11, 11, 65, 1, 11,
      ]),
    );
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    kernel = {
      bytes: new Uint8Array(memory.buffer),
      equal: instance.exports.equal as EqualityKernel['equal'],
    };
    return kernel;
  } catch {
    // Hosts without SIMD or permission to compile retain the ordinary JS scan.
    return undefined;
  }
}

/** Exact live bytes, including NaN payloads; undefined retains the caller's scan. */
export function compareBufferBytes(
  first: ArrayBufferLike,
  firstOffset: number,
  second: ArrayBufferLike,
  secondOffset: number,
  byteLength: number,
): boolean | undefined {
  // Shared memory must retain the caller's live reads instead of a copied snapshot.
  if (byteLength < MIN_BYTES || !(first instanceof ArrayBuffer) || !(second instanceof ArrayBuffer))
    return undefined;
  const current = equalityKernel();
  if (current === undefined) return undefined;
  const a = new Uint8Array(first, firstOffset, byteLength);
  const b = new Uint8Array(second, secondOffset, byteLength);
  // Reject an early mismatch before copying a large candidate into scratch.
  for (let index = 0; index < 64; index++) if (a[index] !== b[index]) return false;
  const aligned = byteLength - (byteLength % 16);
  for (let offset = 0; offset < aligned; offset += SIDE_BYTES) {
    const length = Math.min(SIDE_BYTES, aligned - offset);
    current.bytes.set(a.subarray(offset, offset + length), 0);
    current.bytes.set(b.subarray(offset, offset + length), SIDE_BYTES);
    if (current.equal(0, SIDE_BYTES, length) === 0) return false;
  }
  for (let index = aligned; index < byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}
