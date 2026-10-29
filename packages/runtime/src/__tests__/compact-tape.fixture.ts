import { type EncodedTape, encodeTape, tapeArtifact } from '@forgeax/engine-rhi-debug';

const compacted = new WeakMap<EncodedTape, EncodedTape>();

/** Preserve every seed and event while avoiding large browser evidence transfers. */
export function compactTape(capture: EncodedTape): EncodedTape {
  const previous = compacted.get(capture);
  if (previous !== undefined) return previous;
  const bytes = encodeTape(capture.tape, { compression: 'gzip' }).unwrap();
  const artifact = tapeArtifact([bytes]);
  const result: EncodedTape = {
    tape: capture.tape,
    byteLength: artifact.byteLength,
    get bytes() {
      return artifact.bytes;
    },
    get digest() {
      return artifact.digest;
    },
    chunks: (size) => artifact.chunks(size),
  };
  compacted.set(capture, result);
  compacted.set(result, result);
  return result;
}
