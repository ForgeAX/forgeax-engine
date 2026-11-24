import { expect, it } from 'vitest';
import {
  SCREEN_PROBE_HISTORY_BYTES,
  SCREEN_PROBE_RADIANCE_BYTES,
} from '../../raytracing/screen-probe-plan';
import { packPointRadiance, unpackRadianceAmplitudes } from './screen-probe-radiance.fixture';

it.each([
  1, 4, 16, 20,
])('keeps every history header and production packet offset for %i probes', (probes) => {
  const headerWords = 24;
  const logicalStride = headerWords + 64 * 8;
  const values = new Float32Array(probes * logicalStride);
  const words = new Uint32Array(values.buffer);
  for (let probe = 0; probe < probes; probe++) {
    words[probe * logicalStride + 7] = 0x7fc01234 + probe;
    for (let texel = 0; texel < 64; texel++)
      values.set(
        [probe + 0.25, texel + 0.5, 3, 2, -1, 1, 0, 0],
        probe * logicalStride + headerWords + texel * 8,
      );
  }
  const packet = packPointRadiance(values, probes, headerWords, logicalStride);
  expect(packet.byteLength).toBe(probes * SCREEN_PROBE_HISTORY_BYTES);
  const bytes = new DataView(packet.buffer);
  for (let probe = 0; probe < probes; probe++) {
    const start = probe * SCREEN_PROBE_HISTORY_BYTES;
    expect(bytes.getUint32(start + 28, true)).toBe(0x7fc01234 + probe);
    for (let texel = 0; texel < 64; texel++) {
      const offset = start + headerWords * 4 + texel * SCREEN_PROBE_RADIANCE_BYTES;
      expect(bytes.getFloat32(offset, true)).toBe(probe + 0.25);
      expect(bytes.getFloat32(offset + 4, true)).toBe(texel + 0.5);
      expect(bytes.getFloat32(offset + 32, true)).toBe(2);
      expect(bytes.getFloat32(offset + 36, true)).toBe(-1);
    }
  }
  unpackRadianceAmplitudes(packet, probes, headerWords, logicalStride);
  const decodedWords = new Uint32Array(packet.buffer);
  for (let probe = 0; probe < probes; probe++) {
    expect(decodedWords[probe * logicalStride + 7]).toBe(0x7fc01234 + probe);
    for (let texel = 0; texel < 64; texel++)
      expect(
        Array.from(
          packet.slice(
            probe * logicalStride + headerWords + texel * 8,
            probe * logicalStride + headerWords + texel * 8 + 6,
          ),
        ),
      ).toEqual([probe + 0.25, texel + 0.5, 3, 2, -1, 1]);
  }
});

it('expands a sliced logical point image without reading its backing-buffer prefix', () => {
  const storage = new Float32Array(64 * 8 + 8).fill(-100);
  const values = storage.subarray(8);
  for (let texel = 0; texel < 64; texel++) values.set([1, 2, 3, 4, -1, 1, 0, 0], texel * 8);
  const packet = packPointRadiance(values, 1);
  expect(packet.byteLength).toBe(64 * SCREEN_PROBE_RADIANCE_BYTES);
  expect(packet[0]).toBe(1);
  expect(packet[63 * 10 + 8]).toBe(4);
  expect(storage[0]).toBe(-100);
});

it('decodes independently authored physical stages without changing adjacent bytes', () => {
  const stageBytes = 2 * 64 * SCREEN_PROBE_RADIANCE_BYTES;
  const storage = new Uint8Array(32 + stageBytes * 2 + 32).fill(0x5a);
  const data = new DataView(storage.buffer);
  for (let stage = 0; stage < 2; stage++)
    for (let probe = 0; probe < 2; probe++)
      for (let texel = 0; texel < 64; texel++) {
        const first = 32 + stage * stageBytes + (probe * 64 + texel) * 40;
        for (let word = 0; word < 10; word++) data.setUint32(first + word * 4, 0, true);
        data.setFloat32(first, stage + probe + 0.25, true);
        data.setFloat32(first + 4, texel + 0.5, true);
        data.setFloat32(first + 8, 3, true);
        data.setFloat32(first + 12, 1, true);
        data.setFloat32(first + 32, 2, true);
        data.setFloat32(first + 36, -1, true);
      }
  const before = storage.slice();
  for (let stage = 0; stage < 2; stage++) {
    const view = new Float32Array(storage.buffer, 32 + stage * stageBytes, stageBytes / 4);
    unpackRadianceAmplitudes(view, 2);
    for (let probe = 0; probe < 2; probe++)
      for (let texel = 0; texel < 64; texel++)
        expect(
          Array.from(view.subarray((probe * 64 + texel) * 8, (probe * 64 + texel) * 8 + 6)),
        ).toEqual([stage + probe + 0.25, texel + 0.5, 3, 2, -1, 1]);
    if (stage === 0)
      expect(storage.subarray(32 + stageBytes, 32 + 2 * stageBytes)).toEqual(
        before.subarray(32 + stageBytes, 32 + 2 * stageBytes),
      );
  }
  expect(storage.subarray(0, 32)).toEqual(before.subarray(0, 32));
  expect(storage.subarray(32 + 2 * stageBytes)).toEqual(before.subarray(32 + 2 * stageBytes));
});
