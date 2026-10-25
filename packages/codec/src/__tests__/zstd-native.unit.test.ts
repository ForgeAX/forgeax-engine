import assert from 'node:assert/strict';
import { Zstd } from '@hpcc-js/wasm-zstd';
import { afterEach, expect, it, vi } from 'vitest';
import { _setZstdImporter, decompressZstd } from '../zstd.js';

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function rawFrame(bytes: Uint8Array, known = false): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, known ? 0x20 : 0, known ? bytes.length : 0x60),
  ];
  if (bytes.length === 0) parts.push(Uint8Array.of(1, 0, 0));
  for (let offset = 0; offset < bytes.length; offset += 131072) {
    const part = bytes.subarray(offset, offset + 131072);
    const header = (part.length << 3) | (offset + part.length === bytes.length ? 1 : 0);
    parts.push(Uint8Array.of(header & 255, (header >>> 8) & 255, (header >>> 16) & 255), part);
  }
  return join(...parts);
}

afterEach(() => {
  _setZstdImporter();
  vi.restoreAllMocks();
});

it('shares native initialization and respects input views and owned output bytes', async () => {
  const load = vi.spyOn(Zstd, 'load');
  const decoder = await Zstd.load();
  load.mockClear();
  const decode = vi.spyOn(decoder, 'decompressChunk');
  const input = Uint8Array.of(11, 22, 33);
  const frame = rawFrame(input, true);
  const padded = join(Uint8Array.of(99), frame, Uint8Array.of(88));
  const results = await Promise.all([
    decompressZstd(padded.subarray(1, -1)),
    decompressZstd(frame),
    decompressZstd(frame),
  ]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledTimes(3);
  for (const result of results) expect(result).toEqual({ ok: true, value: input });
  const first = results[0];
  if (!first?.ok) throw new Error('expected decoded output');
  first.value[0] = 77;
  expect(results[1]).toEqual({ ok: true, value: input });
  expect(await decompressZstd(frame)).toEqual({ ok: true, value: input });
});

it('decodes unknown sizes, multiple raw blocks, concatenated and skippable frames', async () => {
  const input = new Uint8Array(2 * 1024 * 1024).fill(37);
  const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 8, 9, 10);
  const prefix = Uint8Array.of(1, 2, 3);
  assert.deepEqual(await decompressZstd(rawFrame(input)), { ok: true, value: input });
  assert.deepEqual(
    await decompressZstd(join(skip, rawFrame(prefix, true), skip, rawFrame(input), skip)),
    { ok: true, value: join(prefix, input) },
  );
  expect(await decompressZstd(skip)).toEqual({ ok: true, value: new Uint8Array(0) });
});

it('preserves empty input and empty compressed frames', async () => {
  expect(await decompressZstd(new Uint8Array(0))).toEqual({ ok: true, value: new Uint8Array(0) });
  expect(await decompressZstd(rawFrame(new Uint8Array(0), true))).toEqual({
    ok: true,
    value: new Uint8Array(0),
  });
});

it('reports truncated and corrupt frames and remains usable after errors', async () => {
  const input = Uint8Array.of(1, 2, 3);
  const frame = rawFrame(input, true);
  for (const invalid of [frame.subarray(0, -1), Uint8Array.of(0, 1, 2, 3, 4)]) {
    const result = await decompressZstd(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('invalid frame accepted');
    expect(result.error.code).toBe('decompression-failed');
  }
  expect(await decompressZstd(frame)).toEqual({ ok: true, value: input });
});
