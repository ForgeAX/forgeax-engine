import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { textureDigest } from '../render-system-extract';

function original(data: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}

it('retains exact byte digests for offset views and observes in-place edits', () => {
  const data = Uint8Array.from({ length: 4096 }, (_, i) => i * 71).subarray(17, 4000);
  const texture = { data } as TextureAsset;
  const original = () => {
    let hash = 2166136261;
    for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
  };
  const before = textureDigest(texture);
  expect(before).toBe(original());
  const edited = data[10];
  if (edited === undefined) throw new Error('missing texture mutation byte');
  data[10] = edited ^ 1;
  expect(textureDigest(texture)).toBe(original());
  expect(textureDigest(texture)).not.toBe(before);
  expect(textureDigest({ data: new Uint8Array() } as TextureAsset)).toBe('fnv1a:811c9dc5');
});

it('compares every live byte of cached offset views and replacement buffers', () => {
  const data = Uint8Array.from({ length: 67_301 }, (_, index) => index * 71).subarray(13);
  let current = data;
  const texture = {
    get data() {
      return current;
    },
  } as TextureAsset;
  expect(textureDigest(texture)).toBe(original(data));
  expect(textureDigest(texture)).toBe(original(data));
  for (const index of [0, 15, 16, 4095, data.length - 1]) {
    data[index] = (data[index] as number) ^ 1;
    expect(textureDigest(texture)).toBe(original(data));
    expect(textureDigest(texture)).toBe(original(data));
  }
  current = new Uint8Array(data);
  texture.data[8] = (texture.data[8] as number) ^ 1;
  expect(textureDigest(texture)).toBe(original(texture.data));
  current = new Uint8Array(4096).fill(13);
  expect(textureDigest(texture)).toBe(original(texture.data));
  structuredClone(texture.data.buffer, { transfer: [texture.data.buffer as ArrayBuffer] });
  expect(() => textureDigest(texture)).toThrow(TypeError);
});

it('keeps custom iterators and oversized or shared sources on live hashing', () => {
  let calls = 0;
  const data = new Uint8Array(4096);
  Object.defineProperty(data, Symbol.iterator, {
    value: function* () {
      calls++;
      yield calls;
    },
  });
  const texture = { data } as TextureAsset;
  const before = textureDigest(texture);
  expect(calls).toBe(1);
  expect(textureDigest(texture)).not.toBe(before);
  expect(calls).toBe(2);
  let prototypeReads = 0;
  const proxy = new Proxy(data, {
    getPrototypeOf() {
      prototypeReads++;
      throw Error('iteration does not require this trap');
    },
  });
  expect(textureDigest({ data: proxy } as TextureAsset)).toBe(original(Uint8Array.of(3)));
  expect(prototypeReads).toBe(0);
  for (const bytes of [new Uint8Array(1_048_577), new Uint8Array(new SharedArrayBuffer(4096))]) {
    const source = { data: bytes } as TextureAsset;
    expect(textureDigest(source)).toBe(original(bytes));
    bytes[bytes.length - 1] = 1;
    expect(textureDigest(source)).toBe(original(bytes));
  }
});
