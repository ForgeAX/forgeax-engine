// Bounded-memory validation of an on-disk .rhitape: the index is decoded from
// the file prefix, then one sequential pass hashes every blob payload and the
// whole container. Peak memory is one read window plus the JSON index.

import { createHash, type Hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import {
  decodeTapeContainerIndex,
  readTapePreamble,
  TAPE_PREAMBLE_BYTES,
  type TapeBlobEntry,
} from '@forgeax/engine-rhi-debug';

const READ_WINDOW = 16 * 1024 * 1024;

export type TapeFileResult =
  | { readonly ok: true; readonly digest: string; readonly bytes: number }
  | { readonly ok: false; readonly hint: string };

export async function verifyTapeFile(path: string): Promise<TapeFileResult> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const preamble = new Uint8Array(Math.min(size, TAPE_PREAMBLE_BYTES));
    await file.read(preamble, 0, preamble.byteLength, 0);
    const declared = readTapePreamble(preamble);
    if (!declared.ok) return { ok: false, hint: declared.error.hint };
    if (declared.value.byteLength !== size || declared.value.indexEnd > size)
      return { ok: false, hint: 'container length does not match the uploaded byte count' };
    const prefix = new Uint8Array(declared.value.indexEnd);
    await file.read(prefix, 0, prefix.byteLength, 0);
    const index = decodeTapeContainerIndex(prefix, size);
    if (!index.ok) return { ok: false, hint: index.error.hint };

    const whole = createHash('sha256');
    const blobs = [...index.value.blobs]
      .map((blob) => ({ blob, start: index.value.payloadStart + blob.offset }))
      .sort((a, b) => a.start - b.start);
    const active: { blob: TapeBlobEntry; start: number; end: number; hash: Hash }[] = [];
    let next = 0;
    const window = new Uint8Array(Math.min(READ_WINDOW, Math.max(1, size)));
    for (let offset = 0; offset < size; offset += window.byteLength) {
      const length = Math.min(window.byteLength, size - offset);
      const { bytesRead } = await file.read(window, 0, length, offset);
      if (bytesRead !== length) return { ok: false, hint: 'container ended while reading' };
      const view = window.subarray(0, length);
      whole.update(view);
      const end = offset + length;
      while (next < blobs.length && (blobs[next]?.start ?? end) < end) {
        const entry = blobs[next++];
        if (entry === undefined) break;
        active.push({ ...entry, end: entry.start + entry.blob.length, hash: createHash('sha256') });
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const entry = active[i];
        if (entry === undefined) continue;
        const from = Math.max(entry.start, offset) - offset;
        const to = Math.min(entry.end, end) - offset;
        if (to > from) entry.hash.update(view.subarray(from, to));
        if (entry.end <= end) {
          active.splice(i, 1);
          if (`sha256:${entry.hash.digest('hex')}` !== entry.blob.digest)
            return { ok: false, hint: `blob digest mismatch for ${entry.blob.hash}` };
        }
      }
    }
    // Blobs still open here are zero-length ones at the container end.
    const empty = `sha256:${createHash('sha256').digest('hex')}`;
    for (const entry of [
      ...active.map(({ blob }) => blob),
      ...blobs.slice(next).map(({ blob }) => blob),
    ]) {
      if (entry.length !== 0 || entry.digest !== empty)
        return { ok: false, hint: `blob digest mismatch for ${entry.hash}` };
    }
    return { ok: true, digest: `sha256:${whole.digest('hex')}`, bytes: size };
  } finally {
    await file.close();
  }
}
