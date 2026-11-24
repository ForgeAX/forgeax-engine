import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { SceneFieldReceiverProof } from './scene-field-projection';

/** Private GPU projection of the existing accepted receiver rows, not an identity roster. */
export interface FieldReceiverGpuSource {
  readonly state: 'ready';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly words: Uint32Array<ArrayBuffer>;
}
export interface FieldReceiverGpuRow {
  readonly rasterRow: number;
  readonly canonicalRow: number;
  readonly primitiveFirst: number;
  readonly primitiveCount: number;
  readonly forward: ArrayLike<number>;
  readonly receiverProof: SceneFieldReceiverProof;
}
export const FIELD_RECEIVER_GPU = {
  magic: 0x43525031,
  version: 2,
  headerWords: 16,
  rowWords: 20,
  opaquePrimitive: 1,
  rasterAlphaLocal: 2,
} as const;

function receiverRowValid(row: FieldReceiverGpuRow, rowCount: number, liveCount: number): boolean {
  return !(
    !Number.isInteger(row.rasterRow) ||
    row.rasterRow < 1 ||
    row.rasterRow > rowCount ||
    row.forward.length !== 16 ||
    row.primitiveCount < 1 ||
    row.canonicalRow >= liveCount ||
    (row.receiverProof !== 'opaque-primitive' && row.receiverProof !== 'raster-alpha-local')
  );
}

export function packFieldReceiverGpuSource(
  rows: Iterable<FieldReceiverGpuRow>,
  rowCount: number,
  expected: readonly [number, number, number, number],
  frame: number,
  revision: number,
  limits: { readonly maxTextureDimension2D: number; readonly maxBytes: number },
): Result<FieldReceiverGpuSource, RhiError> {
  const logical = FIELD_RECEIVER_GPU.headerWords + rowCount * FIELD_RECEIVER_GPU.rowWords;
  const texels = Math.ceil(logical / 4);
  const width = Math.min(1024, limits.maxTextureDimension2D, texels);
  const height = Math.ceil(texels / width);
  const bytes = width * height * 16;
  if (
    ![rowCount, logical, frame, revision, width, height, bytes].every(Number.isSafeInteger) ||
    rowCount < 0 ||
    logical > 0xffffffff ||
    frame < 0 ||
    frame > 0xffffffff ||
    revision < 0 ||
    revision > 0xffffffff ||
    width < 1 ||
    height > limits.maxTextureDimension2D ||
    bytes > limits.maxBytes ||
    expected[3] === 0
  )
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected:
          'a complete receiver source projection within the existing device and allocation budgets',
        hint: 'retain unavailable receivers instead of truncating rows or changing their identity',
      }),
    );
  const words = new Uint32Array(bytes / 4);
  words.set([FIELD_RECEIVER_GPU.magic, FIELD_RECEIVER_GPU.version, rowCount, frame]);
  words.set(expected, 4);
  words.set([width, logical, revision, 0], 8);
  const floats = new Float32Array(words.buffer);
  for (const row of rows) {
    if (!receiverRowValid(row, rowCount, expected[2])) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'only admitted canonical receiver rows with complete forward matrices',
          hint: 'derive this projection from the accepted FieldReceiverFrame',
        }),
      );
    }
    const at = FIELD_RECEIVER_GPU.headerWords + (row.rasterRow - 1) * FIELD_RECEIVER_GPU.rowWords;
    const proof =
      row.receiverProof === 'opaque-primitive'
        ? FIELD_RECEIVER_GPU.opaquePrimitive
        : FIELD_RECEIVER_GPU.rasterAlphaLocal;
    words.set([row.canonicalRow + 1, row.primitiveFirst, row.primitiveCount, proof], at);
    floats.set(row.forward, at + 4);
  }
  return ok({ state: 'ready', width, height, bytes, words });
}
