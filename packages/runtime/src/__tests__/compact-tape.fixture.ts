import {
  decodeTapeContainerIndex,
  type EncodedTape,
  encodeTape,
  tapeArtifact,
} from '@forgeax/engine-rhi-debug';

const compacted = new WeakMap<EncodedTape, EncodedTape>();

/** Preserve every seed and event while avoiding large browser evidence transfers. */
export function compactTape(capture: EncodedTape): EncodedTape {
  const previous = compacted.get(capture);
  if (previous !== undefined) return previous;
  // The recorder already selects lossless storage per blob. Keep that container,
  // including incompressible raw blocks, instead of decoding and gzipping it again.
  const index = decodeTapeContainerIndex(capture.bytes, capture.byteLength).unwrap();
  if (index.blobs.some((blob) => blob.compression === 'gzip')) {
    compacted.set(capture, capture);
    return capture;
  }
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
