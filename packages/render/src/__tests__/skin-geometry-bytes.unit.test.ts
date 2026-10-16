import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('bounded live skin geometry equality', () => {
  it('detects mutations in every vector lane, unaligned views and the scalar tail', async () => {
    const { compareSkinGeometryBytes: equal } = await import('../skin-geometry-bytes');
    const length = 4109;
    const first = new ArrayBuffer(length + 3);
    const second = new ArrayBuffer(length + 5);
    const a = new Uint8Array(first, 3, length);
    const b = new Uint8Array(second, 5, length);
    for (let index = 0; index < length; index++) a[index] = b[index] = (index * 73 + 19) % 256;
    expect(equal(first, 3, second, 5, length)).toBe(true);
    for (const index of [...Array.from({ length: 32 }, (_, index) => index), 4095, 4096, 4108]) {
      b[index] = (b[index] as number) ^ 1;
      expect(equal(first, 3, second, 5, length), `mutated byte ${index}`).toBe(false);
      b[index] = a[index] as number;
      expect(equal(first, 3, second, 5, length)).toBe(true);
    }
    // The comparison owns no retained geometry result or object-identity shortcut.
    a[2048] = (a[2048] as number) ^ 1;
    expect(equal(first, 3, second, 5, length)).toBe(false);
  });

  it('preserves NaN payload bits and both fixed scratch boundaries', async () => {
    const { compareSkinGeometryBytes: equal } = await import('../skin-geometry-bytes');
    const first = new ArrayBuffer(1_048_577);
    const second = new ArrayBuffer(1_048_577);
    expect(equal(first, 0, second, 0, 4095)).toBeUndefined();
    expect(equal(first, 0, second, 0, 1_048_577)).toBeUndefined();
    expect(equal(first, 0, second, 0, 1_048_576)).toBe(true);
    new Uint8Array(second)[1_048_575] = 1;
    expect(equal(first, 0, second, 0, 1_048_576)).toBe(false);
    new DataView(first).setUint32(128, 0x7fc00001, true);
    new DataView(second).setUint32(128, 0x7fc00002, true);
    expect(equal(first, 0, second, 0, 4096)).toBe(false);
  });

  it('retains the caller scan when WebAssembly is absent', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    const { compareSkinGeometryBytes: equal } = await import('../skin-geometry-bytes');
    expect(equal(new ArrayBuffer(4096), 0, new ArrayBuffer(4096), 0, 4096)).toBeUndefined();
  });

  it('attempts a denied compiler only once and retains the caller scan', async () => {
    let attempts = 0;
    vi.stubGlobal('WebAssembly', {
      Memory: WebAssembly.Memory,
      Module: class {
        constructor() {
          attempts++;
          throw new Error('Compilation denied by host policy');
        }
      },
    });
    const { compareSkinGeometryBytes: equal } = await import('../skin-geometry-bytes');
    const a = new ArrayBuffer(4096);
    const b = new ArrayBuffer(4096);
    expect(equal(a, 0, b, 0, 4096)).toBeUndefined();
    expect(equal(a, 0, b, 0, 4096)).toBeUndefined();
    expect(attempts).toBe(1);
  });
});
