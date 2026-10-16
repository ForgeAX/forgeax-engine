import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip } from '../archive.js';

function firstEntry(archive: Buffer): { path: string; bytes: Buffer } {
  expect(archive.readUInt32LE(0)).toBe(0x0403_4b50);
  const method = archive.readUInt16LE(8);
  const compressedBytes = archive.readUInt32LE(18);
  const nameBytes = archive.readUInt16LE(26);
  const payloadOffset = 30 + nameBytes;
  const payload = archive.subarray(payloadOffset, payloadOffset + compressedBytes);
  return {
    path: archive.subarray(30, payloadOffset).toString('utf8'),
    bytes: method === 8 ? inflateRawSync(payload) : payload,
  };
}

describe('release ZIP', () => {
  it('is deterministic, sorted, compressed, and readable', () => {
    const input = [
      { path: 'z.txt', bytes: Buffer.from('last') },
      { path: 'assets/game.js', bytes: Buffer.from('export const game = true;') },
    ];
    const first = createZip(input);
    const second = createZip([...input].reverse());
    expect(first.equals(second)).toBe(true);
    expect(firstEntry(first)).toEqual({
      path: 'assets/game.js',
      bytes: Buffer.from('export const game = true;'),
    });
    expect(first.readUInt32LE(first.byteLength - 22)).toBe(0x0605_4b50);
    expect(first.readUInt16LE(first.byteLength - 14)).toBe(2);
  });

  it('rejects duplicate and escaping paths', () => {
    expect(() =>
      createZip([
        { path: 'same.txt', bytes: new Uint8Array() },
        { path: 'same.txt', bytes: new Uint8Array() },
      ]),
    ).toThrow('duplicate ZIP entry path');
    expect(() => createZip([{ path: '../outside', bytes: new Uint8Array() }])).toThrow(
      'invalid ZIP entry path',
    );
  });
});
