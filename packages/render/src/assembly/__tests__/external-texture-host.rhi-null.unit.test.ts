import type { DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderError } from '../../errors/render';
import { createExternalTextureSource } from '../../textures/external-texture';
import { createExternalTextureHost } from '../external-texture-host';

function detailOf(error: RenderError): unknown {
  return 'detail' in error ? error.detail : undefined;
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${String(result.error)}`);
  return result.value;
}

class FakeVideoFrame {
  constructor(
    readonly displayWidth: number,
    readonly displayHeight: number,
  ) {}
}

function gpuTexture(overrides: Partial<GPUTexture> = {}): GPUTexture {
  return {
    format: 'rgba8unorm',
    dimension: '2d',
    depthOrArrayLayers: 1,
    sampleCount: 1,
    mipLevelCount: 1,
    width: 4,
    height: 4,
    usage: 0x04 | 0x02,
    label: '',
    createView: () => ({}) as GPUTextureView,
    destroy: () => {
      throw new Error('the engine must never destroy a caller texture');
    },
    ...overrides,
  } as unknown as GPUTexture;
}

interface Upload {
  readonly key: object;
  readonly flipY: boolean | undefined;
  readonly version: number | undefined;
}

function fakeStore(uploads: Upload[]): DynamicTextureStore {
  const views = new Map<object, object>();
  return {
    uploadFrame(
      key: object,
      _source: unknown,
      _w: number,
      _h: number,
      options?: { version?: number; flipY?: boolean },
    ) {
      uploads.push({ key, flipY: options?.flipY, version: options?.version });
      const view = views.get(key) ?? {};
      views.set(key, view);
      return { ok: true, value: view };
    },
    getView: (key: object) => views.get(key),
  } as unknown as DynamicTextureStore;
}

describe('external texture host lifecycle on RhiNull', () => {
  let device: RhiNullDevice;
  let generation: number;
  let errors: (RenderError | RhiError)[];
  let uploads: Upload[];
  let currentDevice: RhiDevice;

  beforeEach(async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    currentDevice = device;
    generation = 1;
    errors = [];
    uploads = [];
    (globalThis as { VideoFrame?: unknown }).VideoFrame = FakeVideoFrame;
  });
  afterEach(() => {
    delete (globalThis as { VideoFrame?: unknown }).VideoFrame;
  });

  const host = (store = fakeStore(uploads)) =>
    createExternalTextureHost({
      getDevice: () => currentDevice,
      getGeneration: () => generation,
      isDeviceLost: () => false,
      getDynamicTextureStore: () => store,
      onError: (error) => errors.push(error),
    });

  it('imports a same-device GPUTexture and binds its view into ordinary and external slots', async () => {
    const h = host();
    const imported = must(await h.importTexture({ kind: 'gpu-texture', texture: gpuTexture() }));
    expect(imported.kind).toBe('gpu-texture');
    expect(h.resolve(imported.source, false)?.kind).toBe('textureView');
    expect(h.resolve(imported.source, true)?.kind).toBe('textureView');
    expect(errors).toEqual([]);
  });

  it.each([
    ['format', { format: 'depth24plus' as GPUTextureFormat }],
    ['dimension', { dimension: '3d' as GPUTextureDimension }],
    ['dimension', { depthOrArrayLayers: 2 }],
    ['dimension', { sampleCount: 4 }],
    ['usage', { usage: 0x02 }],
  ] as const)('rejects a %s mismatch with a structured import error', async (reason, overrides) => {
    const result = await host().importTexture({
      kind: 'gpu-texture',
      texture: gpuTexture(overrides),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('external-texture-invalid');
    expect(detailOf(result.error)).toMatchObject({
      operation: 'import',
      kind: 'gpu-texture',
      reason,
    });
  });

  it('rejects a non-texture and a non-video source as source-unsupported', async () => {
    const h = host();
    const tex = await h.importTexture({ kind: 'gpu-texture', texture: {} as GPUTexture });
    const video = await h.importTexture({ kind: 'video', source: {} as VideoFrame });
    for (const result of [tex, video]) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(detailOf(result.error)).toMatchObject({ reason: 'source-unsupported' });
    }
  });

  it('reports capability absence as data when the backend cannot import textures', async () => {
    currentDevice = Object.create(device, {
      caps: { value: { ...device.caps, textureImport: false } },
    }) as RhiDevice;
    const result = await host().importTexture({ kind: 'gpu-texture', texture: gpuTexture() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(detailOf(result.error)).toMatchObject({ reason: 'capability-absent' });
    const native = host().nativeDevice();
    expect(native.ok).toBe(false);
    if (!native.ok) expect(detailOf(native.error)).toMatchObject({ operation: 'native-device' });
  });

  it('rejects an import whose device was replaced mid-flight as device-lost', async () => {
    const h = host();
    const replacement = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const original = device.importTexture.bind(device);
    device.importTexture = async (texture) => {
      const result = await original(texture);
      currentDevice = replacement;
      return result;
    };
    const result = await h.importTexture({ kind: 'gpu-texture', texture: gpuTexture() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(detailOf(result.error)).toMatchObject({ reason: 'device-lost' });
  });

  it('replaces and releases; release is terminal and bind reports released once', async () => {
    const h = host();
    const handle = must(await h.importTexture({ kind: 'gpu-texture', texture: gpuTexture() }));
    const before = h.resolve(handle.source, false);
    expect((await handle.replace({ kind: 'gpu-texture', texture: gpuTexture() })).ok).toBe(true);
    const after = h.resolve(handle.source, false);
    expect(after?.kind).toBe('textureView');
    expect(after?.value).not.toBe(before?.value);
    expect(handle.release().ok).toBe(true);
    expect(h.resolve(handle.source, false)).toBeUndefined();
    expect(h.resolve(handle.source, false)).toBeUndefined();
    expect(errors.map((e) => ('detail' in e ? e.detail : undefined))).toEqual([
      { operation: 'bind', reason: 'released', generation: 1 },
    ]);
    const again = handle.release();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('external-texture-state-invalid');
    const replaced = await handle.replace({ kind: 'gpu-texture', texture: gpuTexture() });
    expect(replaced.ok).toBe(false);
  });

  it('makes GPUTexture sources stale after recovery until replaced on the new generation', async () => {
    const h = host();
    const handle = must(await h.importTexture({ kind: 'gpu-texture', texture: gpuTexture() }));
    generation = 2;
    h.recover();
    expect(h.resolve(handle.source, false)).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'external-texture-state-invalid',
      detail: { reason: 'stale-generation', generation: 1 },
    });
    expect((await handle.replace({ kind: 'gpu-texture', texture: gpuTexture() })).ok).toBe(true);
    expect(h.resolve(handle.source, false)?.kind).toBe('textureView');
  });

  it('reports a source minted by another renderer as foreign once', () => {
    const h = host();
    const foreign = createExternalTextureSource();
    expect(h.resolve(foreign, false)).toBeUndefined();
    expect(h.resolve(foreign, false)).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ detail: { reason: 'foreign-renderer' } });
  });

  it('zero-copies video into external slots once per frame and copies for ordinary slots', async () => {
    const h = host();
    const frame = new FakeVideoFrame(8, 4) as unknown as VideoFrame;
    const handle = must(await h.importTexture({ kind: 'video', source: frame }));
    const a = h.resolve(handle.source, true);
    const b = h.resolve(handle.source, true);
    expect(a?.kind).toBe('externalTexture');
    expect(b?.value).toBe(a?.value);
    h.beginFrame();
    expect(h.resolve(handle.source, true)?.value).not.toBe(a?.value);
    expect(h.resolve(handle.source, false)?.kind).toBe('textureView');
    expect(uploads).toEqual([expect.objectContaining({ flipY: true, version: 1 })]);
  });

  it('reports a video source that fails to import as source-expired once until it recovers', async () => {
    let fail = true;
    const importExternal = device.importExternalTexture.bind(device);
    device.importExternalTexture = (desc) =>
      fail ? err({ code: 'rhi-descriptor-invalid' } as RhiError) : importExternal(desc);
    const h = host();
    const frame = new FakeVideoFrame(8, 4) as unknown as VideoFrame;
    const handle = must(await h.importTexture({ kind: 'video', source: frame }));
    expect(h.resolve(handle.source, true)).toBeUndefined();
    h.beginFrame();
    expect(h.resolve(handle.source, true)).toBeUndefined();
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'external-texture-state-invalid',
        detail: { operation: 'bind', reason: 'source-expired', generation: 1 },
      }),
    ]);
    expect(uploads).toEqual([]);
    fail = false;
    h.beginFrame();
    expect(h.resolve(handle.source, true)?.kind).toBe('externalTexture');
  });

  it('falls back to an unflipped copy in external slots when caps.externalTexture is absent', async () => {
    currentDevice = Object.create(device, {
      caps: { value: { ...device.caps, externalTexture: false } },
    }) as RhiDevice;
    const h = host();
    const frame = new FakeVideoFrame(8, 4) as unknown as VideoFrame;
    const handle = must(await h.importTexture({ kind: 'video', source: frame }));
    expect(h.resolve(handle.source, true)?.kind).toBe('textureView');
    expect(h.resolve(handle.source, false)?.kind).toBe('textureView');
    expect(uploads.map((u) => u.flipY)).toEqual([false, true]);
    expect(uploads[0]?.key).not.toBe(uploads[1]?.key);
    expect((await handle.replace({ kind: 'video', source: frame })).ok).toBe(true);
    h.resolve(handle.source, true);
    expect(uploads[2]).toMatchObject({ version: 2, flipY: false });
  });

  it('never destroys the caller texture across release and dispose', async () => {
    const h = host();
    const texture = gpuTexture();
    const a = must(await h.importTexture({ kind: 'gpu-texture', texture }));
    await h.importTexture({ kind: 'gpu-texture', texture });
    a.release();
    expect(() => h.dispose()).not.toThrow();
  });
});
