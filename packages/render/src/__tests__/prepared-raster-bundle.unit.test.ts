import type { RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
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
    skin: false,
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
  return {
    trace,
    create,
    device,
    bindings,
    counters,
    descriptor,
    cache,
    resolve: (b = bindings, key = 'main') => cache.resolve(key, device, descriptor, [b], counters),
  };
}

describe('prepared raster batch physical closure', () => {
  it('shares the same physical entry between single observations and grouped recording', () => {
    const f = fixture();
    const first = f.cache.resolveOne('main', f.device, f.descriptor, f.bindings, f.counters);
    expect(f.resolve()).toBe(first);
    const changed = { ...f.bindings, indirectOffset: 120 };
    const replacement = f.cache.resolveOne('main', f.device, f.descriptor, changed, f.counters);
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
    const bundle = f.cache.resolve(
      'block',
      f.device,
      f.descriptor,
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
    expect(f.cache.resolve('block', f.device, f.descriptor, [f.bindings, second], f.counters)).toBe(
      bundle,
    );
    expect(
      f.cache.resolve('block', f.device, f.descriptor, [second, f.bindings], f.counters),
    ).not.toBe(bundle);
    expect(f.cache.resolve('block', f.device, f.descriptor, [second], f.counters)).not.toBe(bundle);
    const before = f.counters.evictions;
    f.cache.retire('block', f.counters);
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
    'skin',
    'indexed',
    'windows',
  ] as const)('invalidates on a changed %s dependency', (field) => {
    const f = fixture();
    const previous = f.resolve();
    const replacement =
      field === 'windows'
        ? [{}, {}]
        : field === 'skin'
          ? true
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
