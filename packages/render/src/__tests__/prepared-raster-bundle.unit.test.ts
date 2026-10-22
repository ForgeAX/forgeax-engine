import type { RenderBundleEncoderDescriptor, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
  type PreparedRasterPass,
  PreparedRasterPassCache,
  prepareRasterWindows,
} from '../gpu-driven/prepared-raster-bundle';

function fixture() {
  const trace: unknown[][] = [];
  const methods = [
    'setPipeline',
    'setBindGroup',
    'setVertexBuffer',
    'setIndexBuffer',
    'drawIndexedIndirect',
    'drawIndirect',
  ];
  const create = vi.fn(() =>
    ok({
      ...Object.fromEntries(
        methods.map((method) => [method, (...args: unknown[]) => trace.push([method, ...args])]),
      ),
      finish: () => ok({}),
    }),
  );
  const device = { createRenderBundleEncoder: create } as unknown as RhiDevice;
  const bindings = {
    pipeline: {},
    view: {},
    material: {},
    mesh: {},
    vertex: {},
    index: {},
    indirect: {},
    materialOffset: 256,
    meshOffsets: [0],
    indexFormat: 'uint16',
    indirectOffset: 60,
    indexed: true,
    windows: [{}, {}],
  } as unknown as PreparedRasterBindings;
  const counters: PreparedRasterCounters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
  const descriptor = {
    colorFormats: ['rgba8unorm' as const],
    depthStencilFormat: 'depth32float' as const,
  };
  const cache = new PreparedRasterBundleCache();
  const passes = new PreparedRasterPassCache();
  const pass = (key = 'main', description: RenderBundleEncoderDescriptor = descriptor) =>
    passes.prepare(key, description);
  const resolveRows = (
    pass: PreparedRasterPass,
    observedDevice: RhiDevice,
    rows: readonly PreparedRasterBindings[],
    observedCounters: PreparedRasterCounters,
  ) => {
    const recording = cache.begin(pass, observedDevice, observedCounters);
    for (const row of rows) recording.push(row);
    return recording.finish();
  };
  return {
    resolveRows,
    pass,
    trace,
    create,
    device,
    bindings,
    counters,
    descriptor,
    cache,
    resolve: (b = bindings, key = 'main') => resolveRows(pass(key), device, [b], counters),
  };
}
describe('private streaming prepared raster recording', () => {
  it.each([
    'pipeline',
    'view',
    'material',
    'mesh',
    'vertex',
    'index',
    'indirect',
    'materialOffset',
    'indirectOffset',
    'indexFormat',
    'meshOffsets',
    'indexed',
    'windows',
  ] as const)('observes a changed %s before accepting a retained bundle', (field) => {
    const f = fixture();
    const previous = f.resolve();
    const replacement =
      field === 'windows'
        ? [{}, {}]
        : field === 'meshOffsets'
          ? [0, 768]
          : field === 'indexed'
            ? !f.bindings[field]
            : field === 'indexFormat'
              ? 'uint32'
              : field.endsWith('Offset')
                ? 512
                : {};
    const recording = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    recording.push({ ...f.bindings, [field]: replacement });
    expect(recording.finish()).not.toBe(previous);
  });
  it('reuses a bundle across fresh caller lists without exposing its physical snapshots', () => {
    const f = fixture();
    const first = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    first.push(f.bindings);
    first.push({ ...f.bindings, indirectOffset: 120 });
    const bundle = first.finish();
    const next = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    next.push({ ...f.bindings, windows: [...f.bindings.windows] });
    next.push({ ...f.bindings, indirectOffset: 120 });
    expect(next.finish()).toBe(bundle);
    expect(() => next.finish()).toThrow('already finished');
    expect(f.counters.hits).toBe(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(() => next.push(f.bindings)).toThrow('already finished');
  });
  it('captures scratch values before the caller reuses its row and windows', () => {
    const f = fixture();
    const scratch = { ...f.bindings, windows: [...f.bindings.windows] };
    const recording = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    recording.push(scratch);
    scratch.indirectOffset = 120;
    scratch.windows[0] = f.bindings.view;
    recording.push(scratch);
    scratch.indirectOffset = 180;
    scratch.windows.length = 0;
    recording.finish();
    expect(
      f.trace.filter(([method]) => method === 'drawIndexedIndirect').map((row) => row[2]),
    ).toEqual([60, 80, 120, 140]);
    expect(
      f.trace
        .filter(([method, slot]) => method === 'setBindGroup' && slot === 3)
        .map((row) => row[2]),
    ).toEqual([...f.bindings.windows, f.bindings.view, f.bindings.windows[1]]);
  });
  it.each(['omit', 'append', 'reorder', 'device'] as const)('rejects a changed %s', (change) => {
    const f = fixture();
    const second = { ...f.bindings, indirectOffset: 120 };
    const previous = f.resolveRows(
      f.pass('main', f.descriptor),
      f.device,
      [f.bindings, second],
      f.counters,
    );
    const recording = f.cache.begin(
      f.pass('main', f.descriptor),
      change === 'device' ? { ...f.device } : f.device,
      f.counters,
    );
    for (const row of change === 'omit'
      ? [f.bindings]
      : change === 'append'
        ? [f.bindings, second, f.bindings]
        : change === 'reorder'
          ? [second, f.bindings]
          : [f.bindings, second])
      recording.push(row);
    expect(recording.finish()).not.toBe(previous);
  });
  it('does not publish an abandoned recording or mix early/late keys', () => {
    const f = fixture();
    const previous = f.resolve();
    const abandoned = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    abandoned.push({ ...f.bindings, materialOffset: 512 });
    const late = f.cache.begin(f.pass('late', f.descriptor), f.device, f.counters);
    late.push({ ...f.bindings, indirectOffset: 120 });
    late.finish();
    expect(f.resolve()).toBe(previous);
    abandoned.finish();
    expect(f.resolve()).not.toBe(previous);
  });
  it('rebuilds a recording retired while it was open', () => {
    const f = fixture();
    const previous = f.resolve();
    const recording = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    recording.push(f.bindings);
    f.cache.retire(f.pass('main'), f.counters);
    expect(recording.finish()).not.toBe(previous);
    expect(f.counters).toMatchObject({ builds: 2, evictions: 1 });
  });
  it('does not publish partial state after an encoder failure', () => {
    const f = fixture();
    const previous = f.resolve();
    const recording = f.cache.begin(f.pass('main', f.descriptor), f.device, f.counters);
    recording.push({ ...f.bindings, materialOffset: 512 });
    f.create.mockImplementationOnce(() => {
      throw new Error('encoder failed');
    });
    expect(() => recording.finish()).toThrow('encoder failed');
    expect(f.resolve()).toBe(previous);
    expect(recording.finish()).not.toBe(previous);
  });
  it('materializes frozen window and binding accessors instead of trusting Object.freeze', () => {
    const f = fixture();
    let current = f.bindings.view;
    const windows = Object.freeze(Object.defineProperty([current], '0', { get: () => current }));
    const retained = prepareRasterWindows(windows);
    current = f.bindings.material;
    expect(retained[0]).toBe(f.bindings.view);
    expect(prepareRasterWindows(retained)).toBe(retained);
    expect(prepareRasterWindows(windows)[0]).toBe(current);
    let offset = 256;
    const observed = Object.freeze({
      ...f.bindings,
      get materialOffset() {
        return offset;
      },
    });
    const first = f.resolve(observed);
    offset = 512;
    expect(f.resolve(observed)).not.toBe(first);
  });
  it('copies a frozen caller list with mutable rows', () => {
    const f = fixture();
    const caller = { ...f.bindings, windows: [...f.bindings.windows] };
    const bindings = Object.freeze([caller]);
    const first = f.resolveRows(f.pass('main', f.descriptor), f.device, bindings, f.counters);
    caller.materialOffset = 512;
    caller.windows[0] = f.bindings.view;
    expect(f.resolveRows(f.pass('main', f.descriptor), f.device, bindings, f.counters)).not.toBe(
      first,
    );
  });
});
describe('prepared raster batch physical closure', () => {
  it('shares the same physical entry between single observations and grouped recording', () => {
    const f = fixture();
    const first = f.cache.resolveOne(
      f.pass('main', f.descriptor),
      f.device,
      f.bindings,
      f.counters,
    );
    expect(f.resolve()).toBe(first);
    const changed = { ...f.bindings, indirectOffset: 120 };
    const replacement = f.cache.resolveOne(
      f.pass('main', f.descriptor),
      f.device,
      changed,
      f.counters,
    );
    expect(replacement).not.toBe(first);
    expect(f.resolve(changed)).toBe(replacement);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.counters.hits).toBe(2);
  });
  it('records independent LOD commands once and reads changed buffer contents without recording again', () => {
    const f = fixture();
    const bundle = f.resolve();
    expect(f.trace.filter(([method]) => method === 'drawIndexedIndirect')).toEqual([
      ['drawIndexedIndirect', f.bindings.indirect, 60],
      ['drawIndexedIndirect', f.bindings.indirect, 80],
    ]);
    expect(f.trace.filter(([method]) => method === 'setBindGroup')).toEqual([
      ['setBindGroup', 0, f.bindings.view, [0, 0]],
      ['setBindGroup', 1, f.bindings.material, [256]],
      ['setBindGroup', 2, f.bindings.mesh, [0]],
      ['setBindGroup', 3, f.bindings.windows[0]],
      ['setBindGroup', 3, f.bindings.windows[1]],
    ]);
    Object.assign(f.bindings.indirect, { contents: 'new visible count' });
    expect(f.resolve({ ...f.bindings, windows: [...f.bindings.windows] })).toBe(bundle);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.counters).toEqual({ hits: 1, builds: 1, commands: 10, evictions: 0 });
  });
  it('shares physical state inside a block and rejects member omission or reordering', () => {
    const f = fixture();
    const second = { ...f.bindings, materialOffset: 512, indirectOffset: 100 };
    const bundle = f.resolveRows(
      f.pass('block', f.descriptor),
      f.device,
      [f.bindings, second],
      f.counters,
    );
    expect(f.trace.filter(([method]) => method === 'setPipeline')).toHaveLength(1);
    expect(f.trace.filter(([method]) => method === 'setVertexBuffer')).toHaveLength(1);
    expect(f.trace.filter(([method]) => method === 'setIndexBuffer')).toHaveLength(1);
    expect(
      f.trace.filter(([method, slot]) => method === 'setBindGroup' && slot === 0),
    ).toHaveLength(1);
    expect(
      f.trace.filter(([method]) => method === 'drawIndexedIndirect').map((row) => row[2]),
    ).toEqual([60, 80, 100, 120]);
    expect(
      f.resolveRows(f.pass('block', f.descriptor), f.device, [f.bindings, second], f.counters),
    ).toBe(bundle);
    expect(
      f.resolveRows(f.pass('block', f.descriptor), f.device, [second, f.bindings], f.counters),
    ).not.toBe(bundle);
    expect(f.resolveRows(f.pass('block', f.descriptor), f.device, [second], f.counters)).not.toBe(
      bundle,
    );
    const before = f.counters.evictions;
    f.cache.retire(f.pass('block'), f.counters);
    expect(f.counters.evictions).toBe(before + 1);
  });
  it.each([
    'pipeline',
    'view',
    'material',
    'mesh',
    'vertex',
    'index',
    'indirect',
    'materialOffset',
    'indirectOffset',
    'indexFormat',
    'meshOffsets',
    'indexed',
    'windows',
  ] as const)('invalidates on a changed %s dependency', (field) => {
    const f = fixture();
    const previous = f.resolve();
    const replacement =
      field === 'windows'
        ? [{}, {}]
        : field === 'meshOffsets'
          ? [0, 768]
          : field === 'indexed'
            ? false
            : field === 'indexFormat'
              ? 'uint32'
              : field.endsWith('Offset')
                ? 512
                : {};
    expect(f.resolve({ ...f.bindings, [field]: replacement })).not.toBe(previous);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it('compares against an owned snapshot when the caller mutates its binding or windows', () => {
    const f = fixture();
    const first = f.resolve();
    Object.assign(f.bindings.windows, { 0: {} });
    const replacedWindow = f.resolve();
    expect(replacedWindow).not.toBe(first);
    Object.assign(f.bindings, { view: {} });
    const replacedView = f.resolve();
    expect(replacedView).not.toBe(replacedWindow);
    Object.assign(f.bindings, { materialOffset: 512 });
    expect(f.resolve()).not.toBe(replacedView);
    expect(f.create).toHaveBeenCalledTimes(4);
  });
  it('keeps early/late and attachment variants separate, with bounded resource retention', () => {
    const f = fixture();
    const main = f.resolve();
    f.resolve({ ...f.bindings, indirectOffset: 4096 }, 'late');
    expect(f.resolve()).toBe(main);
    for (let i = 0; i < 9; i++) f.resolve(f.bindings, `variant-${i}`);
    expect(f.counters.evictions).toBe(3);
    expect(f.resolve()).not.toBe(main);
  });
  it('does not admit a failed encoder and retries through the same validation', () => {
    const f = fixture();
    f.create.mockImplementationOnce(() => {
      throw new Error('encoder failed');
    });
    expect(() => f.resolve()).toThrow('encoder failed');
    f.resolve();
    expect(f.counters.builds).toBe(1);
  });
});
describe('prepared raster cache attachment and publication ownership', () => {
  it.each([
    { colorFormats: ['rgba16float' as const] },
    { depthStencilFormat: 'depth24plus-stencil8' as const },
    { sampleCount: 4 },
    { depthReadOnly: true },
    { stencilReadOnly: true },
  ])('keeps distinct attachment compatibility under one pass key: %j', (change) => {
    const f = fixture();
    const first = f.resolve();
    const descriptor = { ...f.descriptor, ...change };
    const other = f.resolveRows(f.pass('main', descriptor), f.device, [f.bindings], f.counters);
    expect(other).not.toBe(first);
    expect(f.resolve()).toBe(first);
    expect(f.resolveRows(f.pass('main', descriptor), f.device, [f.bindings], f.counters)).toBe(
      other,
    );
    expect(f.counters.builds).toBe(2);
  });
  it('normalizes attachment defaults and snapshots mutable descriptor arrays', () => {
    const f = fixture();
    const formats: GPUTextureFormat[] = ['rgba8unorm'];
    const descriptor = { ...f.descriptor, colorFormats: formats };
    const first = f.resolveRows(f.pass('main', descriptor), f.device, [f.bindings], f.counters);
    expect(
      f.resolveRows(
        f.pass('main', {
          ...descriptor,
          sampleCount: 1,
          depthReadOnly: false,
          stencilReadOnly: false,
        }),
        f.device,
        [f.bindings],
        f.counters,
      ),
    ).toBe(first);
    formats[0] = 'rgba16float';
    expect(f.resolveRows(f.pass('main', descriptor), f.device, [f.bindings], f.counters)).not.toBe(
      first,
    );
    expect(f.resolve()).toBe(first);
  });
  it('retains the physical values recorded before an encoder finish callback edits the caller', () => {
    const f = fixture();
    const created = f.create();
    if (!created.ok) throw new Error('fixture encoder unavailable');
    f.create.mockReturnValueOnce(
      ok({
        ...created.value,
        finish: () => {
          Object.assign(f.bindings, { materialOffset: 512 });
          return ok({});
        },
      }),
    );
    const first = f.resolve();
    expect(f.trace.find(([method, slot]) => method === 'setBindGroup' && slot === 1)?.[3]).toEqual([
      256,
    ]);
    expect(f.resolve()).not.toBe(first);
    expect(f.counters.builds).toBe(2);
  });
});

describe('pass preparation ownership', () => {
  it('shares compatible pass identities across batches and observes frozen accessors', () => {
    const passes = new PreparedRasterPassCache();
    let readOnly = false;
    const formats: GPUTextureFormat[] = ['rgba8unorm'];
    const descriptor = Object.freeze({
      colorFormats: formats,
      get depthReadOnly() {
        return readOnly;
      },
    });
    const first = passes.prepare('early', descriptor);
    expect(Object.isFrozen(first.descriptor)).toBe(true);
    expect(Object.isFrozen(first.descriptor.colorFormats)).toBe(true);
    expect(passes.prepare('early', descriptor)).toBe(first);
    expect(passes.prepare('late', descriptor)).not.toBe(first);
    readOnly = true;
    expect(passes.prepare('early', descriptor)).not.toBe(first);
    readOnly = false;
    formats[0] = 'bgra8unorm';
    expect(passes.prepare('early', descriptor)).not.toBe(first);
    formats[0] = 'rgba8unorm';
    expect(passes.prepare('early', descriptor)).toBe(first);
    expect(first.descriptor.depthReadOnly).toBe(false);
  });

  it('normalizes undefined nullable attachment formats for DOM and native consumers', () => {
    const passes = new PreparedRasterPassCache();
    const fromArray = passes.prepare('main', {
      colorFormats: [undefined],
    } as unknown as RenderBundleEncoderDescriptor);
    expect(fromArray.descriptor.colorFormats).toEqual([null]);
    const fromIterable = passes.prepare('main', {
      colorFormats: new Set([undefined]),
    } as unknown as RenderBundleEncoderDescriptor);
    expect(fromIterable).toBe(fromArray);
    expect(passes.prepare('main', { colorFormats: [null] })).toBe(fromArray);
  });

  it('accepts general format iterables and keeps variant retention bounded', () => {
    const passes = new PreparedRasterPassCache();
    const descriptor = {
      colorFormats: new Set<GPUTextureFormat>(['rgba8unorm']),
    } as unknown as RenderBundleEncoderDescriptor;
    const first = passes.prepare('early', descriptor);
    expect(passes.prepare('early', descriptor)).toBe(first);
    for (let i = 0; i < 33; i++) passes.prepare(`selection-${i}`, descriptor);
    expect(passes.prepare('early', descriptor)).not.toBe(first);
  });
});
