import { describe, expect, it } from 'vitest';
import { MaterialArtifactRegistry } from '../material/artifact-registry';

function registry(bytes: Uint8Array) {
  const owner = new MaterialArtifactRegistry();
  owner.register({ key: 'shared', bytes }).unwrap();
  return owner;
}

function dimension(owner: MaterialArtifactRegistry, bytes: Uint8Array) {
  const result = owner.register({ key: 'shared', bytes });
  return result.ok ? 'equal' : result.error.detail.dimension;
}

describe('material artifact byte observation', () => {
  it.each([
    0, 1, 15, 16, 17, 127, 128, 129, 131, 255, 256, 257, 1024,
  ])('retains exact equal and changed byte decisions at length %i', (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251),
      owner = registry(bytes);
    expect(dimension(owner, bytes.slice())).toBe('equal');
    for (const position of new Set([0, 15, 16, 17, 18, 63, length - 1])) {
      if (position < 0 || position >= length) continue;
      const changed = bytes.slice();
      changed[position] = (changed[position] ?? 0) ^ 128;
      expect(dimension(owner, changed)).toBe('bytes');
    }
  });

  it('keeps published bytes independently mutable and preserves metadata failure ordering', () => {
    const bytes = new Uint8Array(1024).fill(7),
      owner = registry(bytes);
    bytes[401] = 8;
    expect(dimension(owner, new Uint8Array(1024).fill(7))).toBe('bytes');
    const calls: string[] = [];
    expect(
      owner.register({
        key: 'shared',
        bytes: new Uint8Array(1024).fill(9),
        get metadata(): Readonly<Record<string, unknown>> {
          calls.push('metadata');
          throw Error('metadata should not be read');
        },
      }),
    ).toMatchObject({ ok: false, error: { detail: { dimension: 'bytes' } } });
    expect(calls).toEqual([]);
  });

  it('does not invoke typed-array subclass buffer, offset or tag accessors', () => {
    class Adapter extends Uint8Array {
      override get buffer(): ArrayBuffer {
        throw Error('buffer getter');
      }
      override get byteOffset(): number {
        throw Error('offset getter');
      }
      override get [Symbol.toStringTag](): 'Uint8Array' {
        throw Error('tag getter');
      }
    }
    const bytes = new Adapter(1024);
    bytes.fill(7);
    expect(dimension(registry(bytes), new Adapter(bytes))).toBe('equal');
  });

  it('retains right proxy indexed reads and their first error', () => {
    const bytes = new Uint8Array(513).fill(7),
      calls: string[] = [];
    const failure = Error('right index');
    const right = new Proxy(bytes.slice(), {
      get(target, key) {
        calls.push(String(key));
        if (key === '19') throw failure;
        return Reflect.get(target, key, target);
      },
    });
    let thrown: unknown;
    try {
      dimension(registry(bytes), right);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(calls).toEqual(['length', ...Array.from({ length: 20 }, (_, i) => String(i))]);
  });

  it('preserves the original left brand rejection before any indexed reads', () => {
    const calls: string[] = [],
      bytes = new Uint8Array(128);
    const left = new Proxy(bytes, {
      get(target, key) {
        calls.push(String(key));
        return Reflect.get(target, key, target);
      },
    });
    expect(() => dimension(registry(left), bytes.slice())).toThrow(TypeError);
    expect(calls).toEqual(['length']);
  });

  it('preserves ordinary comparisons for shared, unaligned and non-byte incoming views', () => {
    const bytes = new Uint8Array(513).fill(7),
      owner = registry(bytes);
    const shared = new Uint8Array(new SharedArrayBuffer(513));
    shared.set(bytes);
    expect(dimension(owner, shared)).toBe('equal');
    shared[113] = 8;
    expect(dimension(owner, shared)).toBe('bytes');
    const unaligned = new Uint8Array(514).subarray(1);
    unaligned.set(bytes);
    expect(dimension(owner, unaligned)).toBe('equal');
    const words = new Uint16Array(513).fill(7);
    expect(dimension(owner, words as unknown as Uint8Array)).toBe('equal');
    words[100] = 256;
    expect(dimension(owner, words as unknown as Uint8Array)).toBe('bytes');
  });
  it('preserves captured length and right-length side effects before native validation', () => {
    const bytes = new Uint8Array(1024).fill(7),
      calls: string[] = [];
    class Left extends Uint8Array {
      override get length(): number {
        calls.push('left.length');
        return 512;
      }
    }
    class Right extends Uint8Array {
      override get length(): number {
        calls.push('right.length');
        this[401] = 8;
        return 512;
      }
    }
    expect(dimension(registry(new Left(bytes)), new Right(bytes))).toBe('bytes');
    expect(calls).toEqual(['left.length', 'right.length']);
  });

  it('preserves left detached validation after a right length getter transfers storage', () => {
    const left = new Uint8Array(256).fill(7),
      owner = registry(left),
      calls: string[] = [];
    class Right extends Uint8Array {
      override get length(): number {
        calls.push('right.length');
        structuredClone(left.buffer, { transfer: [left.buffer] });
        return 256;
      }
    }
    expect(() => dimension(owner, new Right(256).fill(7))).toThrow(TypeError);
    expect(calls).toEqual(['right.length']);
  });

  it('keeps non-integer declared length comparisons in their original numeric loop', () => {
    class Adapter extends Uint8Array {
      override get length(): number {
        return 128.5;
      }
    }
    const left = new Adapter(130).fill(7),
      right = new Adapter(left);
    expect(dimension(registry(left), right)).toBe('equal');
    right[128] = 8;
    expect(dimension(registry(left), right)).toBe('bytes');
  });

  it('keeps author-replaced buffer prototypes on the byte fallback without treating them as native ordinary owners', () => {
    const bytes = new Uint8Array(512).fill(7),
      owner = registry(bytes);
    const sharedBuffer = new SharedArrayBuffer(512),
      shared = new Uint8Array(sharedBuffer);
    shared.set(bytes);
    Object.setPrototypeOf(sharedBuffer, ArrayBuffer.prototype);
    expect(dimension(owner, shared)).toBe('equal');
    shared[255] = 8;
    expect(dimension(owner, shared)).toBe('bytes');
    const buffer = new ArrayBuffer(512),
      altered = new Uint8Array(buffer);
    altered.set(bytes);
    Object.setPrototypeOf(buffer, Object.create(null));
    expect(dimension(owner, altered)).toBe('equal');
    altered[255] = 8;
    expect(dimension(owner, altered)).toBe('bytes');
  });
});
