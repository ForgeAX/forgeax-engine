import type { MaterialShaderVertexInput } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  hasGpuDrivenVertexColor,
  hasRequiredVertexInputs,
  ownGpuDrivenVertexInputs,
} from '../gpu-driven/prepared-draw';

function inputs(): [MaterialShaderVertexInput] {
  return [{ semantic: 'position', location: 0, format: 'float32x3' }];
}

describe('owned vertex input admission', () => {
  it('shares canonical frozen receipt tables across scene owners', () => {
    const receipt = Object.freeze(inputs().map((input) => Object.freeze(input)));
    expect(ownGpuDrivenVertexInputs(receipt)).toBe(receipt);
    expect(ownGpuDrivenVertexInputs(receipt)).toBe(receipt);
  });

  it('retains acceptance and rejection for immutable requirements', () => {
    const actual = ownGpuDrivenVertexInputs(inputs());
    const accepted = ownGpuDrivenVertexInputs(inputs());
    const rejected = ownGpuDrivenVertexInputs([{ ...inputs()[0], location: 1 }]);
    const scans = vi.spyOn(Array.prototype, 'some');
    try {
      for (let frame = 0; frame < 8; frame++) {
        expect(hasRequiredVertexInputs(accepted, actual)).toBe(true);
        expect(hasRequiredVertexInputs(rejected, actual)).toBe(false);
      }
      expect(scans).toHaveBeenCalledTimes(2);
    } finally {
      scans.mockRestore();
    }
  });

  it('captures values without freezing caller objects', () => {
    const source = inputs();
    const owned = ownGpuDrivenVertexInputs(source);
    Object.assign(source[0], { location: 3 });
    expect(owned[0]?.location).toBe(0);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned[0])).toBe(true);
    expect(ownGpuDrivenVertexInputs(owned)).toBe(owned);
    const republished = ownGpuDrivenVertexInputs(source);
    expect(republished).not.toBe(owned);
    expect(republished[0]?.location).toBe(3);
    expect(hasRequiredVertexInputs(owned, republished)).toBe(false);
  });

  it('observes mutable requirements and borrowed geometry on every call', () => {
    const required = inputs();
    const actual = inputs();
    const owned = ownGpuDrivenVertexInputs(actual);
    expect(hasRequiredVertexInputs(required, owned)).toBe(true);
    Object.assign(required[0], { location: 2 });
    expect(hasRequiredVertexInputs(required, owned)).toBe(false);
    Object.assign(required[0], { location: 0 });
    const immutable = ownGpuDrivenVertexInputs(required);
    expect(hasRequiredVertexInputs(immutable, actual)).toBe(true);
    Object.assign(actual[0], { format: 'float32x2' });
    expect(hasRequiredVertexInputs(immutable, actual)).toBe(false);
  });

  it('derives color from owned values while observing mutable and accessor inputs on every call', () => {
    const raw = inputs();
    const owned = ownGpuDrivenVertexInputs(raw);
    const scans = vi.spyOn(Array.prototype, 'some');
    try {
      for (let frame = 0; frame < 8; frame++) expect(hasGpuDrivenVertexColor(owned)).toBe(false);
      expect(scans).not.toHaveBeenCalled();
      Object.assign(raw[0], { semantic: 'color' });
      expect(hasGpuDrivenVertexColor(raw)).toBe(true);
      expect(hasGpuDrivenVertexColor(owned)).toBe(false);
      let semantic = 'color';
      const accessor = Object.freeze([
        Object.freeze({
          get semantic() {
            return semantic;
          },
          location: 0,
          format: 'float32x3',
        }),
      ]);
      expect(hasGpuDrivenVertexColor(accessor)).toBe(true);
      semantic = 'position';
      expect(hasGpuDrivenVertexColor(accessor)).toBe(false);
    } finally {
      scans.mockRestore();
    }
    expect(
      hasGpuDrivenVertexColor(
        ownGpuDrivenVertexInputs([{ semantic: 'color', location: 3, format: 'float32x4' }]),
      ),
    ).toBe(true);
  });

  it('keeps frozen accessor requirements live', () => {
    let location = 0;
    const required = Object.freeze([
      Object.freeze({
        semantic: 'position',
        get location() {
          return location;
        },
        format: 'float32x3',
      }),
    ]) as readonly MaterialShaderVertexInput[];
    const actual = ownGpuDrivenVertexInputs(inputs());
    expect(hasRequiredVertexInputs(required, actual)).toBe(true);
    location = 1;
    expect(hasRequiredVertexInputs(required, actual)).toBe(false);
  });

  it('snapshots frozen field accessors again on each publication', () => {
    let location = 0;
    const read = vi.fn(() => location);
    const source = Object.freeze([
      Object.freeze({
        semantic: 'position',
        get location() {
          return read();
        },
        format: 'float32x3',
      }),
    ]) as readonly MaterialShaderVertexInput[];
    const first = ownGpuDrivenVertexInputs(source);
    expect(read).toHaveBeenCalledTimes(1);
    location = 2;
    const second = ownGpuDrivenVertexInputs(source);
    expect(read).toHaveBeenCalledTimes(2);
    expect(first[0]?.location).toBe(0);
    expect(second[0]?.location).toBe(2);
    expect(second).not.toBe(first);
    expect(first).not.toBe(source);
  });

  it('reads frozen array accessors only during the original copying operation', () => {
    const source = inputs();
    const read = vi.fn(() => Object.freeze(inputs()[0]));
    Object.defineProperty(source, 0, { get: read });
    Object.freeze(source);
    const first = ownGpuDrivenVertexInputs(source);
    expect(read).toHaveBeenCalledTimes(1);
    const second = ownGpuDrivenVertexInputs(source);
    expect(read).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(source);
    expect(second).not.toBe(first);
  });

  it('preserves a custom map getter failure and retries the next publication', () => {
    const source = inputs().map((input) => Object.freeze(input));
    const failure = new Error('map temporarily unavailable');
    let fail = true;
    const read = vi.fn(() => {
      if (fail) throw failure;
      return Array.prototype.map;
    });
    Object.defineProperty(source, 'map', { get: read });
    Object.freeze(source);
    expect(() => ownGpuDrivenVertexInputs(source)).toThrow(failure);
    expect(read).toHaveBeenCalledTimes(1);
    fail = false;
    const first = ownGpuDrivenVertexInputs(source);
    expect(read).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(source);
    expect(first).toEqual(inputs());
    expect(ownGpuDrivenVertexInputs(source)).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps frozen getter tables returned by a custom map outside owned caches', () => {
    let semantic = 'color';
    const read = vi.fn(() => semantic);
    const returned = Object.freeze([
      Object.freeze({
        get semantic() {
          return read();
        },
        location: 0,
        format: 'float32x3',
      }),
    ]);
    const source = inputs();
    const map = vi.fn(() => returned);
    Object.defineProperty(source, 'map', { value: map });
    Object.freeze(source);
    const owned = ownGpuDrivenVertexInputs(source);
    expect(owned).toBe(returned);
    expect(read).not.toHaveBeenCalled();
    expect(hasGpuDrivenVertexColor(owned)).toBe(true);
    semantic = 'position';
    expect(hasGpuDrivenVertexColor(owned)).toBe(false);
    const required = ownGpuDrivenVertexInputs(inputs());
    expect(hasRequiredVertexInputs(required, owned)).toBe(true);
    semantic = 'color';
    expect(hasRequiredVertexInputs(required, owned)).toBe(false);
    expect(read).toHaveBeenCalledTimes(4);
    expect(ownGpuDrivenVertexInputs(source)).toBe(returned);
    expect(map).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('keeps custom some methods on Array species results live until consumption', () => {
    let matches = true;
    let fail = false;
    const failure = new Error('some temporarily unavailable');
    const read = vi.fn();
    class VertexInputs extends Array<MaterialShaderVertexInput> {
      override some(
        predicate: (
          value: MaterialShaderVertexInput,
          index: number,
          array: MaterialShaderVertexInput[],
        ) => unknown,
        thisArg?: unknown,
      ): boolean {
        read();
        if (fail) throw failure;
        return matches && super.some(predicate, thisArg);
      }
    }
    const source = new VertexInputs({ semantic: 'color', location: 3, format: 'float32x4' });
    const owned = ownGpuDrivenVertexInputs(source);
    expect(owned).toBeInstanceOf(VertexInputs);
    expect(owned).not.toBe(source);
    expect(read).not.toHaveBeenCalled();
    expect(hasGpuDrivenVertexColor(owned)).toBe(true);
    matches = false;
    expect(hasGpuDrivenVertexColor(owned)).toBe(false);
    fail = true;
    expect(() => hasGpuDrivenVertexColor(owned)).toThrow(failure);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps custom some observations live without invoking them while copying', () => {
    const source = inputs().map((input) => Object.freeze(input));
    const failure = new Error('some temporarily unavailable');
    let matches = true;
    let fail = false;
    const read = vi.fn(() => {
      if (fail) throw failure;
      return () => matches;
    });
    Object.defineProperty(source, 'some', { get: read });
    Object.freeze(source);
    const required = ownGpuDrivenVertexInputs(inputs());
    const owned = ownGpuDrivenVertexInputs(source);
    expect(owned).not.toBe(source);
    expect(read).not.toHaveBeenCalled();
    expect(hasRequiredVertexInputs(required, source)).toBe(true);
    matches = false;
    expect(hasRequiredVertexInputs(required, source)).toBe(false);
    fail = true;
    expect(() => hasRequiredVertexInputs(required, source)).toThrow(failure);
    fail = false;
    expect(hasRequiredVertexInputs(required, source)).toBe(false);
    expect(read).toHaveBeenCalledTimes(4);
    expect(hasRequiredVertexInputs(required, owned)).toBe(true);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('keeps frozen custom every requirements live', () => {
    const required = inputs().map((input) => Object.freeze(input));
    let matches = true;
    const every = vi.fn(() => matches);
    Object.defineProperty(required, 'every', { value: every });
    Object.freeze(required);
    const owned = ownGpuDrivenVertexInputs(inputs());
    expect(hasRequiredVertexInputs(required, owned)).toBe(true);
    matches = false;
    expect(hasRequiredVertexInputs(required, owned)).toBe(false);
    expect(every).toHaveBeenCalledTimes(2);
  });
});
