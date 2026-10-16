import { type EncodedTape, encodeTape, tapeArtifact } from '@forgeax/engine-rhi-debug';

/** Preserve every seed and event while avoiding large browser evidence transfers. */
export function compactTape(capture: EncodedTape): EncodedTape {
  const bytes = encodeTape(capture.tape, { compression: 'gzip' }).unwrap();
  return { ...tapeArtifact([bytes]), tape: capture.tape };
}
