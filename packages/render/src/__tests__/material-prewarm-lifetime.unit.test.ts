import { Hash } from 'node:crypto';
import { err, ok, type Result, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import {
  ADMIT_EVERY_VARIANT,
  prewarmMaterialShaderVariants,
  selectBootVariant,
} from '../assembly/shader-prewarm-policy';
import { RhiErrorListenerRegistry } from '../lifecycle';

const variant = (key: string, source = key) => ({
  definesKey: key,
  defines: {},
  composedWgsl: source,
});

it('reuses admitted source across string retries, cached hits and same-label replacement', () => {
  const hash = vi.spyOn(Hash.prototype, 'update');
  const descriptor = vi.spyOn(ShaderSource.prototype, 'descriptor');
  const module = {} as ShaderModule;
  const compile = vi.fn(() => ok(module));
  const adapter = makeShaderDeviceAdapter(
    {} as never,
    new RhiErrorListenerRegistry(),
    undefined,
    compile,
    'immediate',
  );
  const code = '// repeated immutable source\n'.repeat(1024);
  try {
    for (let frame = 0; frame < 256; frame++)
      expect(adapter.createShaderModule({ code, label: 'stable-source' })).toEqual(ok(module));
    expect(hash).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(descriptor).toHaveBeenCalledTimes(1);
    // A same-length content change must still retire the cached module.
    const changed = code.replace('repeated', 'replaced');
    expect(changed.length).toBe(code.length);
    expect(adapter.createShaderModule({ code: changed, label: 'stable-source' })).toEqual(
      ok(module),
    );
    expect(hash).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(2);
    adapter.invalidateModule('stable-source');
    expect(adapter.createShaderModule({ code: changed, label: 'stable-source' })).toEqual(
      ok(module),
    );
    expect(adapter.createShaderModule({ code: changed, label: 'stable-source' })).toEqual(
      ok(module),
    );
    expect(hash).toHaveBeenCalledTimes(3);
    expect(compile).toHaveBeenCalledTimes(3);
  } finally {
    adapter.dispose();
    descriptor.mockRestore();
    hash.mockRestore();
  }
});

it('reuses source admission while the async module is pending', async () => {
  const hash = vi.spyOn(Hash.prototype, 'update');
  const module = {} as ShaderModule;
  let complete: ((result: Result<ShaderModule, RhiError>) => void) | undefined;
  const compile = vi.fn(
    () =>
      new Promise<Result<ShaderModule, RhiError>>((resolve) => {
        complete = resolve;
      }),
  );
  const adapter = makeShaderDeviceAdapter(
    {} as never,
    new RhiErrorListenerRegistry(),
    compile,
    undefined,
  );
  try {
    for (let frame = 0; frame < 256; frame++)
      expect(adapter.createShaderModule({ code: 'pending source', label: 'pending' }).ok).toBe(
        false,
      );
    expect(hash).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    complete?.(ok(module));
    await Promise.resolve();
    expect(adapter.createShaderModule({ code: 'pending source', label: 'pending' })).toEqual(
      ok(module),
    );
    expect(hash).toHaveBeenCalledTimes(1);
  } finally {
    adapter.dispose();
    hash.mockRestore();
  }
});

it.each([
  { path: 'labeled raw text', labeled: true, owned: false, hashes: 1, scans: 255 },
  { path: 'unlabeled raw text', labeled: false, owned: false, hashes: 256, scans: 0 },
  { path: 'labeled source owner', labeled: true, owned: true, hashes: 1, scans: 0 },
  { path: 'unlabeled source owner', labeled: false, owned: true, hashes: 1, scans: 0 },
])('bounds hashing and matching for $path', ({ labeled, owned, hashes, scans }) => {
  // Observe actual Node digests, independently of the portable UTF-8 encoder.
  const hash = vi.spyOn(Hash.prototype, 'update');
  const match = vi.spyOn(ShaderSource.prototype, 'matches');
  const code = '// exact source hash counter\n'.repeat(1024);
  const source = new ShaderSource([code]);
  const module = {} as ShaderModule;
  const compile = vi.fn(() => ok(module));
  const adapter = makeShaderDeviceAdapter(
    {} as never,
    new RhiErrorListenerRegistry(),
    undefined,
    compile,
    'immediate',
  );
  try {
    for (let retry = 0; retry < 256; retry++) {
      const label = labeled ? 'hash-counter' : undefined;
      const desc = owned ? source.descriptor(label) : { code, label };
      expect(adapter.createShaderModule(desc)).toEqual(ok(module));
    }
    expect(hash.mock.calls.filter(([input]) => input === code)).toHaveLength(hashes);
    expect(match).toHaveBeenCalledTimes(scans);
    expect(compile).toHaveBeenCalledTimes(1);
  } finally {
    adapter.dispose();
    match.mockRestore();
    hash.mockRestore();
  }
});

describe('material prewarm candidate lifetime', () => {
  it('deduplicates sources across bounded batches and preserves every exact draw label', async () => {
    const variants = Array.from({ length: 25 }, (_, i) => variant(String(i), String(i % 9)));
    const modules = new Map<string, ShaderModule>();
    const seeded = new Map<string, ShaderModule>();
    let active = 0;
    let peak = 0;
    const compile = vi.fn(async (row: ReturnType<typeof variant>) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return ok({ source: row.composedWgsl } as unknown as ShaderModule);
    });
    await prewarmMaterialShaderVariants(
      'material',
      variants,
      modules,
      compile,
      (label, module) => seeded.set(label, module),
      ADMIT_EVERY_VARIANT,
    );
    expect(compile).toHaveBeenCalledTimes(9);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(seeded.size).toBe(25);
    for (const row of variants)
      expect(seeded.get(`module-material#${row.definesKey}`)).toBe(modules.get(row.composedWgsl));
  });

  it('settles late sibling compilation before rejecting a failed candidate', async () => {
    const failure = new RhiError({
      code: 'shader-compile-failed',
      expected: 'valid fixture shader',
      hint: 'intentional compile failure',
    });
    let finishLate = () => {};
    const late = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const seed = vi.fn();
    let terminal = false;
    const pending = prewarmMaterialShaderVariants(
      'material',
      [variant('bad'), variant('late')],
      new Map(),
      async (row) => {
        if (row.definesKey === 'bad') return err(failure);
        await late;
        return ok({} as ShaderModule);
      },
      seed,
      ADMIT_EVERY_VARIANT,
    );
    const checked = pending.catch((error: unknown) => {
      terminal = true;
      expect(error).toBe(failure);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(seed).not.toHaveBeenCalled();
    finishLate();
    await checked;
    expect(terminal).toBe(true);
    expect(seed).not.toHaveBeenCalled();
  });
});

describe('recovery variant admission', () => {
  it('compiles only admitted labels and still seeds sources the build already holds', async () => {
    const held = { source: 'held' } as unknown as ShaderModule;
    const modules = new Map<string, ShaderModule>([['held', held]]);
    const seeded = new Map<string, ShaderModule>();
    const compile = vi.fn(async (row: ReturnType<typeof variant>) =>
      ok({ source: row.composedWgsl } as unknown as ShaderModule),
    );
    await prewarmMaterialShaderVariants(
      'material',
      [variant('drawn'), variant('unused'), variant('alias', 'held')],
      modules,
      compile,
      (label, module) => seeded.set(label, module),
      (label) => label === 'module-material#drawn',
    );
    expect(compile.mock.calls.map(([row]) => row.definesKey)).toEqual(['drawn']);
    expect([...seeded.keys()].sort()).toEqual(['module-material#alias', 'module-material#drawn']);
    expect(seeded.get('module-material#alias')).toBe(held);
  });

  it('reports only modules a pipeline requested, not boot-seeded ones', () => {
    const module = {} as ShaderModule;
    const adapter = makeShaderDeviceAdapter(
      {} as never,
      new RhiErrorListenerRegistry(),
      undefined,
      undefined,
    );
    adapter.seedModule('module-material#drawn', module, '');
    adapter.seedModule('module-material#unused', module, '');
    expect(adapter.hasModule('module-material#drawn')).toBe(false);
    expect(adapter.createShaderModule({ code: '', label: 'module-material#drawn' })).toEqual(
      ok(module),
    );
    expect(adapter.hasModule('module-material#drawn')).toBe(true);
    expect(adapter.hasModule('module-material#unused')).toBe(false);
  });
});

describe('pending material module request lifetime', () => {
  function fixture() {
    const complete: ((result: Result<ShaderModule, RhiError>) => void)[] = [];
    const compile = vi.fn(
      () => new Promise<Result<ShaderModule, RhiError>>((resolve) => complete.push(resolve)),
    );
    const adapter = makeShaderDeviceAdapter(
      {} as never,
      new RhiErrorListenerRegistry(),
      compile,
      undefined,
    );
    return { adapter, complete, compile };
  }

  it('retains one structured pending signal across retries and retires it on completion', async () => {
    const { adapter, complete, compile } = fixture();
    const desc = { code: 'valid source', label: 'actual-shared-module' };
    const first = adapter.createShaderModule(desc);
    expect(first.ok).toBe(false);
    if (first.ok) throw Error('Expected a pending module');
    expect(first.error).toMatchObject({
      code: 'rhi-not-available',
      expected: 'shader module pre-bake to complete asynchronously',
    });
    expect(first.error.hint).toContain(desc.label);
    for (let retry = 0; retry < 256; retry++) {
      const result = adapter.createShaderModule(desc);
      expect(result.ok).toBe(false);
      if (result.ok) throw Error('Pending module became ready without completion');
      expect(result.error).toBe(first.error);
    }
    expect(compile).toHaveBeenCalledTimes(1);
    const module = {} as ShaderModule;
    complete[0]?.(ok(module));
    await Promise.resolve();
    expect(adapter.createShaderModule(desc)).toEqual(ok(module));
    expect(adapter.hasModule(desc.label)).toBe(true);
  });

  it('starts a distinct request after invalidation and ignores late old completion', async () => {
    const { adapter, complete, compile } = fixture();
    const desc = { code: 'first source', label: 'replaced-module' };
    const first = adapter.createShaderModule(desc);
    adapter.invalidateModule(desc.label);
    const replacement = { ...desc, code: 'replacement source' };
    const second = adapter.createShaderModule(replacement);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) throw Error('Expected pending requests');
    expect(second.error).not.toBe(first.error);
    complete[0]?.(ok({ old: true } as unknown as ShaderModule));
    await Promise.resolve();
    expect(adapter.createShaderModule(replacement)).toEqual(err(second.error));
    expect(adapter.hasModule(desc.label)).toBe(false);
    const terminal = new RhiError({
      code: 'shader-compile-failed',
      expected: 'replacement source compiles',
      hint: 'intentional failure',
    });
    complete[1]?.(err(terminal));
    await Promise.resolve();
    expect(adapter.createShaderModule(replacement)).toEqual(err(terminal));
    adapter.invalidateModule(desc.label);
    const third = adapter.createShaderModule(desc);
    expect(third.ok).toBe(false);
    if (third.ok) throw Error('Expected another pending request');
    expect(third.error).not.toBe(second.error);
    expect(third.error).not.toBe(terminal);
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('rejects a seed alias when its first request carries different source', () => {
    const { adapter, compile } = fixture();
    adapter.seedModule('reused-label', {} as ShaderModule, 'old source');
    expect(adapter.createShaderModule({ label: 'reused-label', code: 'new source' }).ok).toBe(
      false,
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('retires seeded and pending modules with their device generation', async () => {
    const { adapter, complete, compile } = fixture();
    const descriptor = { code: 'source', label: 'generation-module' };
    adapter.createShaderModule(descriptor);
    const seeded = {} as ShaderModule;
    adapter.seedModule(descriptor.label, seeded, descriptor.code);
    complete[0]?.(ok({ stale: true } as unknown as ShaderModule));
    await Promise.resolve();
    expect(adapter.createShaderModule(descriptor)).toEqual(ok(seeded));
    adapter.dispose();
    adapter.seedModule(descriptor.label, seeded, descriptor.code);
    expect(adapter.hasModule(descriptor.label)).toBe(false);
    expect(adapter.createShaderModule(descriptor).ok).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('isolates device adapters and keeps seeded modules ready during pending compilation', async () => {
    const first = fixture(),
      second = fixture(),
      desc = { code: 'source', label: 'same-label' };
    const a = first.adapter.createShaderModule(desc),
      b = second.adapter.createShaderModule(desc);
    if (a.ok || b.ok) throw Error('Expected independent pending requests');
    expect(a.error).not.toBe(b.error);
    const seeded = {} as ShaderModule;
    first.adapter.seedModule(desc.label, seeded, desc.code);
    expect(first.adapter.createShaderModule(desc)).toEqual(ok(seeded));
    expect(second.adapter.createShaderModule(desc)).toEqual(err(b.error));
    expect(first.compile).toHaveBeenCalledTimes(1);
    expect(second.compile).toHaveBeenCalledTimes(1);
  });
});

describe('boot variant selection', () => {
  type ManifestEntry = Parameters<typeof selectBootVariant>[0];
  const row = (defines: Record<string, boolean>) => ({
    definesKey: Object.entries(defines)
      .map(([axis, value]) => `${axis}=${value}`)
      .join('+'),
    defines,
    composedWgsl: JSON.stringify(defines),
  });

  it('seeds the unlit atmosphere axis the device draws, not the first manifest row', () => {
    const entry = {
      identifier: 'forgeax::default-unlit',
      variants: [true, false].flatMap((atmosphere) =>
        [false, true].map((vertexColor) =>
          row({
            ATMOSPHERE_AVAILABLE: atmosphere,
            COVERAGE_ONLY: false,
            STORAGE_BUFFER_AVAILABLE: true,
            VERTEX_COLOR_AVAILABLE: vertexColor,
          }),
        ),
      ),
    } as unknown as ManifestEntry;
    for (const atmosphere of [false, true]) {
      for (const vertexColor of [false, true]) {
        const selected = selectBootVariant(entry, {
          VERTEX_COLOR_AVAILABLE: vertexColor,
          STORAGE_BUFFER_AVAILABLE: true,
          ATMOSPHERE_AVAILABLE: atmosphere,
          COVERAGE_ONLY: false,
        });
        expect(selected?.defines).toMatchObject({
          ATMOSPHERE_AVAILABLE: atmosphere,
          VERTEX_COLOR_AVAILABLE: vertexColor,
        });
      }
    }
  });

  it('seeds both sprite region variants on the device atmosphere axis', () => {
    // Row order mirrors the compiled forgeax::sprite manifest: the atmosphere
    // rows come first, so matching only region and storage picks them.
    const entry = {
      identifier: 'forgeax::sprite',
      variants: [
        row({
          ATMOSPHERE_AVAILABLE: true,
          PER_INSTANCE_REGION: true,
          STORAGE_BUFFER_AVAILABLE: true,
        }),
        row({
          ATMOSPHERE_AVAILABLE: true,
          PER_INSTANCE_REGION: false,
          STORAGE_BUFFER_AVAILABLE: true,
        }),
        row({
          ATMOSPHERE_AVAILABLE: false,
          PER_INSTANCE_REGION: true,
          STORAGE_BUFFER_AVAILABLE: true,
        }),
        row({
          ATMOSPHERE_AVAILABLE: false,
          PER_INSTANCE_REGION: false,
          STORAGE_BUFFER_AVAILABLE: true,
        }),
        row({ PER_INSTANCE_REGION: true, STORAGE_BUFFER_AVAILABLE: false }),
        row({ PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: false }),
      ],
    } as unknown as ManifestEntry;
    for (const [storage, atmosphere] of [
      [true, true],
      [true, false],
      [false, false],
    ] as const) {
      for (const region of [false, true]) {
        const selected = selectBootVariant(entry, {
          PER_INSTANCE_REGION: region,
          STORAGE_BUFFER_AVAILABLE: storage,
          ATMOSPHERE_AVAILABLE: atmosphere,
        });
        expect(selected?.defines.ATMOSPHERE_AVAILABLE ?? false).toBe(atmosphere);
        expect(selected?.defines.PER_INSTANCE_REGION).toBe(region);
        expect(selected?.defines.STORAGE_BUFFER_AVAILABLE).toBe(storage);
      }
    }
  });
});

it('does not let a reused label alias changed source or accept a stale completion', async () => {
  const completions: ((result: ReturnType<typeof ok<ShaderModule>>) => void)[] = [];
  const compile = vi.fn(
    () => new Promise<ReturnType<typeof ok<ShaderModule>>>((resolve) => completions.push(resolve)),
  );
  const adapter = makeShaderDeviceAdapter(
    {} as never,
    new RhiErrorListenerRegistry(),
    compile,
    undefined,
  );
  const old = adapter.createShaderModule({ code: 'old source', label: 'shared-label' });
  const next = adapter.createShaderModule({ code: 'new source', label: 'shared-label' });
  expect(compile).toHaveBeenCalledTimes(2);
  if (old.ok || next.ok) throw new Error('Expected separate pending source requests');
  completions[0]?.(ok({} as ShaderModule));
  await Promise.resolve();
  expect(adapter.createShaderModule({ code: 'new source', label: 'shared-label' })).toEqual(next);
  const module = {} as ShaderModule;
  completions[1]?.(ok(module));
  await Promise.resolve();
  expect(adapter.createShaderModule({ code: 'new source', label: 'shared-label' })).toEqual(
    ok(module),
  );
});
