import { describe, expect, it } from 'vitest';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const abi = () => ({
  vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  bindings: [{ group: 1, binding: 0, kind: 'uniform', size: 64 }],
  entryPoints: { vertex: 'vs', fragment: 'fs' },
  optional: undefined,
  empty: null,
});

describe('ownRenderFeatureProgramData frozen adoption', () => {
  it('adopts a deep-frozen plain JSON subtree by identity instead of copying it', () => {
    const shared = deepFreeze(abi());
    const first = ownRenderFeatureProgramData({ programs: [{ key: 'a', abi: shared }] });
    const second = ownRenderFeatureProgramData({ programs: [{ key: 'b', abi: shared }] });
    expect(first.programs[0]?.abi).toBe(shared);
    expect(second.programs[0]?.abi).toBe(shared);
    expect(isOwnedRenderFeatureProgramData(first)).toBe(true);
    expect(isOwnedRenderFeatureProgramData(shared)).toBe(true);
    expect(Object.isFrozen(first.programs[0])).toBe(true);
  });

  it('adopts a deep-frozen root as the owned value', () => {
    const root = deepFreeze({ rows: [abi(), abi()] });
    expect(ownRenderFeatureProgramData(root)).toBe(root);
    expect(isOwnedRenderFeatureProgramData(root)).toBe(true);
  });

  it('copies a frozen node whose descendant is still mutable', () => {
    const mutable = { size: 64 };
    const outer = Object.freeze({ binding: mutable });
    const owned = ownRenderFeatureProgramData({ abi: outer });
    expect(owned.abi).not.toBe(outer);
    expect(owned.abi.binding).not.toBe(mutable);
    expect(owned.abi).toEqual({ binding: { size: 64 } });
    mutable.size = 1;
    expect(owned.abi.binding.size).toBe(64);
    expect(isOwnedRenderFeatureProgramData(owned)).toBe(true);
  });

  it('never adopts frozen values with accessors, symbols, prototypes or views', () => {
    const accessor = Object.freeze(
      Object.defineProperty({}, 'size', { get: () => 64, enumerable: true }),
    );
    const symbol = Object.freeze({ [Symbol('s')]: 1, size: 64 });
    const prototyped = Object.freeze(Object.create({ inherited: true }) as object);
    const hidden = Object.freeze(Object.defineProperty({}, 'size', { value: 64 }));
    for (const value of [accessor, symbol, prototyped, hidden]) {
      const owned = ownRenderFeatureProgramData({ value });
      expect(owned.value).not.toBe(value);
      expect(isOwnedRenderFeatureProgramData(owned)).toBe(false);
      expect(isOwnedRenderFeatureProgramData(value)).toBe(false);
    }
    const bytes = new Uint8Array(0);
    Object.freeze(bytes);
    const owned = ownRenderFeatureProgramData({ bytes });
    expect(owned.bytes).not.toBe(bytes);
  });
});
