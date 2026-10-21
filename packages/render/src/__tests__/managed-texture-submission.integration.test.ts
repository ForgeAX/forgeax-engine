import {
  AssetRegistry,
  adaptDynamicTextureDevice,
  DynamicTextureStore,
} from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { type FrameRecording, submitFrameRecordings } from '../assembly/frame-recording';
import { GpuResidencyCache } from '../device/gpu-residency';
import type { RenderSystemInternals } from '../record/render-context';

it.each([
  'static',
  'canvas',
] as const)('settles sibling uploads and both views after the %s mip completion throws', async (owner) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm-srgb'])).unwrap();
  const dynamic = new DynamicTextureStore();
  dynamic.configureGpuDevice(adaptDynamicTextureDevice(device));
  const failure = new Error('Injected mip completion failure');
  const submit = vi.spyOn(device.queue, 'submit');
  const completed: boolean[] = [];
  const internals = { gpuStore: store, dynamicTextureStore: dynamic } as RenderSystemInternals;
  const encoder = device.createCommandEncoder().unwrap();
  if (owner === 'static') {
    const buffer = device.createCommandEncoder().unwrap().finish().unwrap();
    vi.spyOn(store, 'prepareTextureMips').mockReturnValueOnce(
      ok({
        buffer,
        complete: () => {
          throw failure;
        },
      }),
    );
  } else {
    const prepare = dynamic.prepareMipmaps.bind(dynamic);
    vi.spyOn(dynamic, 'prepareMipmaps').mockImplementationOnce((target) => {
      const prepared = prepare(target);
      assert(prepared?.ok);
      return ok({
        buffer: prepared.value.buffer,
        complete: (submitted) => {
          prepared.value.complete(submitted);
          throw failure;
        },
      });
    });
  }
  dynamic
    .uploadFrame({}, {} as GPUCopyExternalImageSourceInfo['source'], 8, 8, {
      version: 1,
      generateMipmaps: true,
    })
    ?.unwrap();
  function* view(): FrameRecording {
    const submitted = yield { encoder, device, reportError: () => {} };
    completed.push(submitted.ok);
    return submitted.ok;
  }
  try {
    expect(() => submitFrameRecordings([view(), view()], undefined, internals)).toThrow(failure);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(completed).toEqual([true, true]);
    expect(dynamic.prepareMipmaps(device)).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    dynamic.destroyAll();
    store.destroyAll();
  }
});

it('keeps mip work across a rejected multi-view submission and consumes it exactly once', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm'])).unwrap();
  const assets = new AssetRegistry();
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'generate' },
      data: new Uint8Array(256),
    })
    .unwrap();
  const submit = vi.spyOn(device.queue, 'submit');
  const current = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  store.ensureResident(handle, current()).unwrap();
  expect(submit).not.toHaveBeenCalled();
  const internals = { gpuStore: store } as RenderSystemInternals;
  const frame = () => {
    const encoder = device.createCommandEncoder().unwrap();
    function* view(): FrameRecording {
      const submitted = yield { encoder, device, reportError: () => {} };
      return submitted.ok;
    }
    return submitFrameRecordings([view(), view()], undefined, internals);
  };
  const observer = assets.observe().unwrap();
  try {
    submit.mockReturnValueOnce(
      err(
        new RhiError({ code: 'webgpu-runtime-error', expected: 'test rejection', hint: 'retry' }),
      ),
    );
    expect(frame).toThrowError(expect.objectContaining({ code: 'frame-submit-rejected' }));
    expect(submit.mock.calls[0]?.[0]).toHaveLength(2);
    expect(frame()).toBe(true);
    expect(submit.mock.calls[1]?.[0]).toHaveLength(2);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
    expect(frame()).toBe(true);
    expect(submit.mock.calls[2]?.[0]).toHaveLength(1);
    for (let i = 0; i < 8; i++) {
      assets
        .writeRange(handle, {
          origin: { x: 0, y: 0 },
          size: { width: 1, height: 1 },
          data: new Uint8Array(4).fill(i),
        })
        .unwrap();
      const batch = observer.read().unwrap();
      const change = batch.changes[0];
      assert(change);
      store.adoptTextureChange(change, current()).unwrap();
      batch.accept();
    }
    expect(submit).toHaveBeenCalledTimes(3);
    expect(frame()).toBe(true);
    expect(submit.mock.calls[3]?.[0]).toHaveLength(2);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    submit.mockRestore();
    observer.dispose();
    store.destroyAll();
    assets.dispose();
  }
});

it('submits Canvas mips discovered by either view before their shared scene buffer and retries rejection', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm', 'rgba8unorm-srgb'])).unwrap();
  const dynamic = new DynamicTextureStore();
  dynamic.configureGpuDevice(adaptDynamicTextureDevice(device));
  const assets = new AssetRegistry();
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'generate' },
      data: new Uint8Array(256),
    })
    .unwrap();
  store
    .ensureResident(handle, runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap())
    .unwrap();
  const labels = new Map<object, string | undefined>();
  const create = device.createCommandEncoder.bind(device);
  const encoding = vi.spyOn(device, 'createCommandEncoder').mockImplementation((descriptor) => {
    const result = create(descriptor);
    if (result.ok) {
      const finish = result.value.finish.bind(result.value);
      result.value.finish = () => {
        const completed = finish();
        if (completed.ok) labels.set(completed.value, descriptor?.label);
        return completed;
      };
    }
    return result;
  });
  const submit = vi.spyOn(device.queue, 'submit');
  const copies = vi.spyOn(device.queue, 'copyExternalImageToTexture');
  const internals = { gpuStore: store, dynamicTextureStore: dynamic } as RenderSystemInternals;
  const source = {} as GPUCopyExternalImageSourceInfo['source'];
  const key = {};
  let version = 1;
  const frame = () => {
    const encoder = device.createCommandEncoder({ label: 'test-scene' }).unwrap();
    function* view(): FrameRecording {
      // Actual binding happens during recording, after the first view started.
      dynamic.uploadFrame(key, source, 8, 8, { version, generateMipmaps: true })?.unwrap();
      const submitted = yield { encoder, device, reportError: () => {} };
      return submitted.ok;
    }
    return submitFrameRecordings([view(), view()], undefined, internals);
  };
  const submittedLabels = (index: number) =>
    submit.mock.calls[index]?.[0].map((buffer) => labels.get(buffer));
  try {
    submit.mockReturnValueOnce(
      err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'test rejection',
          hint: 'retry',
        }),
      ),
    );
    expect(frame).toThrowError(expect.objectContaining({ code: 'frame-submit-rejected' }));
    expect(submittedLabels(0)).toEqual(['texture-mips', 'dynamic-texture-mips', 'test-scene']);
    expect(frame()).toBe(true);
    expect(submittedLabels(1)).toEqual(['texture-mips', 'dynamic-texture-mips', 'test-scene']);
    expect(copies).toHaveBeenCalledTimes(1);
    expect(dynamic.prepareMipmaps(device)).toBeUndefined();
    expect(frame()).toBe(true);
    expect(submittedLabels(2)).toEqual(['test-scene']);
    version++;
    expect(frame()).toBe(true);
    expect(submittedLabels(3)).toEqual(['dynamic-texture-mips', 'test-scene']);
    expect(copies).toHaveBeenCalledTimes(2);
    expect(dynamic.prepareMipmaps(device)).toBeUndefined();
  } finally {
    submit.mockRestore();
    copies.mockRestore();
    encoding.mockRestore();
    dynamic.destroyAll();
    store.destroyAll();
    assets.dispose();
  }
});
