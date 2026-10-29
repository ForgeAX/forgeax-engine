import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureGpuBufferRef } from '../features/prepared-gpu-work';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';

describe('native prepared graphics input at the detached store boundary', () => {
  it('reuses equal native descriptions without re-capturing or stringifying their values', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1);
    const request = {
      shader: 'shader',
      vertexLayout: 'none',
      colorFormats: ['rgba8unorm' as const],
      renderState: {
        blend: {
          color: { srcFactor: 'src-alpha' as const, dstFactor: 'one-minus-src-alpha' as const },
          alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const },
        },
      },
    };
    const p = first.prepare('pipeline', 'p', request).unwrap(),
      b = first
        .prepare('bindings', 'b', {
          pipeline: p,
          values: { data: [1, 2], nested: { a: 'buffer' } },
        })
        .unwrap();
    first.commit().unwrap();
    const next = store.beginFrame('fx', 1),
      json = vi.spyOn(JSON, 'stringify'),
      freeze = vi.spyOn(Object, 'freeze');
    try {
      expect(next.prepare('pipeline', 'p', { ...request }, true).unwrap()).toBe(p);
      expect(
        next
          .prepare(
            'bindings',
            'b',
            { pipeline: p, values: { data: [1, 2], nested: { a: 'buffer' } } },
            true,
          )
          .unwrap(),
      ).toBe(b);
      expect(json).not.toHaveBeenCalled();
      expect(freeze).not.toHaveBeenCalled();
    } finally {
      json.mockRestore();
      freeze.mockRestore();
    }
    expect(
      next
        .commit()
        .unwrap()
        .items.map((x) => x.reference),
    ).toEqual([p, b]);
  });
  it('captures changed native values and keeps later caller mutation detached', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      p = first
        .prepare('pipeline', 'p', {
          shader: 'shader',
          vertexLayout: 'none',
          colorFormats: ['rgba8unorm'],
        })
        .unwrap();
    const original = first
      .prepare('bindings', 'b', { pipeline: p, values: { data: [1, 2], nested: { a: 'old' } } })
      .unwrap();
    first.commit().unwrap();
    const next = store.beginFrame('fx', 1);
    next
      .prepare(
        'pipeline',
        'p',
        { shader: 'shader', vertexLayout: 'none', colorFormats: ['rgba8unorm'] },
        true,
      )
      .unwrap();
    const values = { data: [1, 3], nested: { a: 'new' } },
      changed = next.prepare('bindings', 'b', { pipeline: p, values }, true).unwrap();
    expect(changed).not.toBe(original);
    values.data[1] = 99;
    values.nested.a = 'mutation';
    expect(next.lookup(changed)?.descriptor).toMatchObject({
      values: { data: [1, 3], nested: { a: 'new' } },
    });
    expect(
      next.prepare(
        'bindings',
        'b',
        { pipeline: p, values: { data: [1, 4], nested: { a: 'new' } } },
        true,
      ).ok,
    ).toBe(false);
    next.abort();
    expect(next.lookup(changed)).toBeUndefined();
    expect(next.prepare('bindings', 'b', { pipeline: p, values: {} }, true).ok).toBe(false);
  });
  it('keeps raw getters and generations on their original capture paths', () => {
    const store = createPreparedGraphicsStore(),
      request = { shader: 'shader', vertexLayout: 'none', colorFormats: ['rgba8unorm' as const] },
      first = store.beginFrame('fx', 1),
      p = first.prepare('pipeline', 'p', request).unwrap();
    first.commit().unwrap();
    const read = vi.fn(() => request.colorFormats),
      next = store.beginFrame('fx', 1),
      json = vi.spyOn(JSON, 'stringify');
    try {
      expect(
        next
          .prepare('pipeline', 'p', {
            ...request,
            get colorFormats() {
              return read();
            },
          })
          .unwrap(),
      ).toBe(p);
      expect(read).toHaveBeenCalled();
      expect(json).toHaveBeenCalled();
    } finally {
      json.mockRestore();
    }
    next.abort();
    store.invalidate('fx', 2);
    expect(store.beginFrame('fx', 2).prepare('pipeline', 'p', request, true).unwrap()).not.toBe(p);
  });
  it('does not confuse different array lengths or foreign binding refs', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      p = first
        .prepare('pipeline', 'p', {
          shader: 'shader',
          vertexLayout: 'none',
          colorFormats: ['rgba8unorm'],
        })
        .unwrap();
    const b = first.prepare('bindings', 'b', { pipeline: p, values: { a: [1] } }).unwrap();
    first.commit().unwrap();
    const next = store.beginFrame('fx', 1);
    expect(
      next.prepare('bindings', 'b', { pipeline: p, values: { a: [1, undefined] } }, true).unwrap(),
    ).not.toBe(b);
    const foreign = store
      .beginFrame('other', 1)
      .prepare('pipeline', 'p', {
        shader: 'shader',
        vertexLayout: 'none',
        colorFormats: ['rgba8unorm'],
      })
      .unwrap();
    expect(
      next.prepare('bindings', 'foreign', { pipeline: foreign, values: { a: [1] } }, true).unwrap(),
    ).not.toBe(b);
  });
  it('keeps custom callable JSON values on their exact normalization path', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      p = first
        .prepare('pipeline', 'p', {
          shader: 'shader',
          vertexLayout: 'none',
          colorFormats: ['rgba8unorm'],
        })
        .unwrap();
    let version = 1;
    const values = { toJSON: () => ({ version }) };
    const b = first.prepare('bindings', 'b', { pipeline: p, values }).unwrap();
    first.commit().unwrap();
    version = 2;
    const next = store.beginFrame('fx', 1);
    expect(next.prepare('bindings', 'b', { pipeline: p, values }, true).unwrap()).not.toBe(b);
  });
  it('does not double-read native top-level or nested getters when values miss', () => {
    const store = createPreparedGraphicsStore(),
      request = { shader: 'shader', vertexLayout: 'none', colorFormats: ['rgba8unorm' as const] },
      first = store.beginFrame('fx', 1),
      p = first.prepare('pipeline', 'p', request).unwrap();
    const previous = first
      .prepare('bindings', 'b', { pipeline: p, values: { nested: { value: 1 } } })
      .unwrap();
    first.commit().unwrap();
    const shader = vi.fn(() => 'changed'),
      nested = vi.fn(() => 2),
      next = store.beginFrame('fx', 1);
    expect(
      next
        .prepare(
          'pipeline',
          'p',
          {
            ...request,
            get shader() {
              return shader();
            },
          },
          true,
        )
        .unwrap(),
    ).not.toBe(p);
    expect(shader).toHaveBeenCalledTimes(1);
    expect(
      next
        .prepare(
          'bindings',
          'b',
          {
            pipeline: p,
            values: {
              nested: {
                get value() {
                  return nested();
                },
              },
            },
          },
          true,
        )
        .unwrap(),
    ).not.toBe(previous);
    expect(nested).toHaveBeenCalledTimes(1);
  });
  it('keeps live typed views and custom array conversion on the original path', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      p = first
        .prepare('pipeline', 'p', {
          shader: 'shader',
          vertexLayout: 'none',
          colorFormats: ['rgba8unorm'],
        })
        .unwrap();
    const bytes = new Float32Array([1, 2]),
      b = first.prepare('bindings', 'b', { pipeline: p, values: { data: bytes } }).unwrap();
    first.commit().unwrap();
    const next = store.beginFrame('fx', 1),
      json = vi.spyOn(JSON, 'stringify');
    try {
      expect(
        next.prepare('bindings', 'b', { pipeline: p, values: { data: bytes } }, true).unwrap(),
      ).toBe(b);
      expect(json).toHaveBeenCalledTimes(1);
    } finally {
      json.mockRestore();
    }
    bytes[1] = 3;
    expect(
      next.prepare('bindings', 'b', { pipeline: p, values: { data: bytes } }, true).unwrap(),
    ).not.toBe(b);
    next.abort();
    let value = 4;
    const values = [1];
    Object.defineProperty(values, 'map', { value: () => [value] });
    const custom = store.beginFrame('fx', 1),
      original = custom
        .prepare('bindings', 'custom', { pipeline: p, values: { data: values } })
        .unwrap();
    custom.commit().unwrap();
    value = 5;
    expect(
      store
        .beginFrame('fx', 1)
        .prepare('bindings', 'custom', { pipeline: p, values: { data: values } }, true)
        .unwrap(),
    ).not.toBe(original);
  });
  it('revalidates shader preparation, all pipeline fields and physical buffer ranges', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      request = { shader: 'shader', vertexLayout: 'none', colorFormats: ['rgba8unorm' as const] },
      p = first.prepare('pipeline', 'p', request).unwrap();
    const buffer = { name: 'b', generation: 1 } as RenderFeatureGpuBufferRef,
      vertex = { layout: 'vertex', buffer, offset: 0, size: 16 },
      v = first.prepare('vertex-data', 'v', vertex).unwrap(),
      index = { format: 'uint16' as const, buffer, offset: 0, size: 16 },
      i = first.prepare('index-data', 'i', index).unwrap();
    first.commit().unwrap();
    for (const patch of [
      { shader: 'changed' },
      { preparePipelines: true },
      { vertexLayout: 'position' },
      { colorFormats: ['bgra8unorm' as const] },
      { depthFormat: 'depth32float' as const },
      { sampleCount: 4 as const },
      { topology: 'line-list' as const },
      { indexFormat: 'uint16' as const },
    ])
      expect(
        store
          .beginFrame('fx', 1)
          .prepare('pipeline', 'p', { ...request, ...patch }, true)
          .unwrap(),
      ).not.toBe(p);
    expect(
      store
        .beginFrame('fx', 1)
        .prepare('vertex-data', 'v', { ...vertex }, true)
        .unwrap(),
    ).toBe(v);
    expect(
      store
        .beginFrame('fx', 1)
        .prepare('index-data', 'i', { ...index }, true)
        .unwrap(),
    ).toBe(i);
    for (const patch of [
      { buffer: { name: 'b', generation: 1 } as RenderFeatureGpuBufferRef },
      { offset: 4 },
      { size: 8 },
    ]) {
      expect(
        store
          .beginFrame('fx', 1)
          .prepare('vertex-data', 'v', { ...vertex, ...patch }, true)
          .unwrap(),
      ).not.toBe(v);
      expect(
        store
          .beginFrame('fx', 1)
          .prepare('index-data', 'i', { ...index, ...patch }, true)
          .unwrap(),
      ).not.toBe(i);
    }
    expect(
      store
        .beginFrame('fx', 1)
        .prepare('index-data', 'i', { ...index, format: 'uint32' }, true)
        .unwrap(),
    ).not.toBe(i);
  });
  it('preserves nonenumerable accessors and custom array iterators/species', () => {
    const store = createPreparedGraphicsStore(),
      first = store.beginFrame('fx', 1),
      request = { shader: 'shader', vertexLayout: 'none', colorFormats: ['rgba8unorm' as const] },
      p = first.prepare('pipeline', 'p', request).unwrap();
    first.commit().unwrap();
    const getter = vi.fn(() => 'changed'),
      next = store.beginFrame('fx', 1),
      changed = { ...request };
    Object.defineProperty(changed, 'shader', { get: getter, enumerable: false });
    expect(next.prepare('pipeline', 'p', changed, true).unwrap()).not.toBe(p);
    expect(getter).toHaveBeenCalledTimes(1);
    let format: GPUTextureFormat = 'rgba8unorm';
    const formats: GPUTextureFormat[] = ['rgba8unorm'];
    Object.defineProperty(formats, Symbol.iterator, {
      value: function* () {
        yield format;
      },
    });
    const a = store.beginFrame('array', 1),
      input = { ...request, colorFormats: formats },
      original = a.prepare('pipeline', 'p', input).unwrap();
    a.commit().unwrap();
    format = 'bgra8unorm';
    expect(store.beginFrame('array', 1).prepare('pipeline', 'p', input, true).unwrap()).not.toBe(
      original,
    );
    let version = 1;
    const array = [1],
      values = { data: array };
    class CapturedArray extends Array<unknown> {
      constructor(length: number) {
        super(length);
        Object.defineProperty(this, 'toJSON', { value: () => [version] });
      }
    }
    Object.defineProperty(array, 'constructor', { value: { [Symbol.species]: CapturedArray } });
    const species = store.beginFrame('species', 1),
      b = species.prepare('bindings', 'b', { pipeline: p, values }).unwrap();
    species.commit().unwrap();
    version = 2;
    expect(
      store
        .beginFrame('species', 1)
        .prepare('bindings', 'b', { pipeline: p, values }, true)
        .unwrap(),
    ).not.toBe(b);
  });
});

describe('frozen native requests proven by identity', () => {
  it('skips the structural walk for an identical frozen request and releases replaced proofs', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const store = createPreparedGraphicsStore();
    const pipeline = (format: 'rgba8unorm' | 'bgra8unorm') =>
      Object.freeze({
        shader: 'shader',
        vertexLayout: 'none',
        colorFormats: Object.freeze([format]),
      });
    const released = (() => {
      const request = pipeline('rgba8unorm');
      const first = store.beginFrame('fx', 1);
      const reference = first.prepare('pipeline', 'p', request).unwrap();
      first.commit().unwrap();
      const second = store.beginFrame('fx', 1);
      expect(second.prepare('pipeline', 'p', request, true).unwrap()).toBe(reference);
      second.commit().unwrap();
      const keys = vi.spyOn(Reflect, 'ownKeys');
      try {
        const third = store.beginFrame('fx', 1);
        expect(third.prepare('pipeline', 'p', request, true).unwrap()).toBe(reference);
        third.commit().unwrap();
        expect(keys).not.toHaveBeenCalled();
      } finally {
        keys.mockRestore();
      }
      return new WeakRef(request);
    })();
    const replacement = pipeline('bgra8unorm');
    for (let frame = 0; frame < 3; frame++) {
      const replaced = store.beginFrame('fx', 1);
      replaced.prepare('pipeline', 'p', replacement, true).unwrap();
      replaced.commit().unwrap();
    }
    for (let attempt = 0; attempt < 10 && released.deref() !== undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    expect(released.deref()).toBeUndefined();
  });
});
