import { err, type Result, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullAdapter, RhiNullDevice } from '@forgeax/engine-rhi-null';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
} from '../../device/gpu-residency';
import {
  createIblPipelines,
  getOrCreateIblCache,
  type RunIblPrecomputeOptions,
  runIblPrecompute,
} from '../../ibl/IblPipelineCache';

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function fixture() {
  const device = unwrap(await new RhiNullAdapter().requestDevice());
  if (!(device instanceof RhiNullDevice)) throw new Error('Expected null backend');
  const scope = DeviceScope.create(1, 'ibl-submission-test');
  unwrap(await createIblPipelines(scope, device, createShaderModule));
  const texture = unwrap(
    device.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      usage: 20,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
    }),
  );
  const view = unwrap(device.createTextureView(texture, { dimension: 'cube' }));
  const options: RunIblPrecomputeOptions = {
    scope,
    device,
    equirectView: view,
    cubeView: view,
    cubeFaceViews: Array.from({ length: 6 }, (_, face) =>
      unwrap(
        device.createTextureView(texture, {
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        }),
      ),
    ),
    faceUniformsBuffer: unwrap(createFaceUniformsBuffer(device)),
    prefilterUniformsBuffer: unwrap(createPrefilterUniformsBuffer(device)),
    cubeVertexBuffer: unwrap(
      device.createBuffer({ size: 432, usage: 32, mappedAtCreation: false }),
    ),
  };
  return { ...options, device, cache: getOrCreateIblCache(scope), options };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('IBL precompute completion boundaries', () => {
  it('falls back to a timer when worker requestAnimationFrame rejects', async () => {
    const { device, scope, cache, options } = await fixture();
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new DOMException(
        'requestAnimationFrame not supported in this Worker',
        'NotSupportedError',
      );
    });

    const result = await runIblPrecompute(options);

    expect(result.unwrap().prefilterTexture).toBeDefined();
    expect(device.framePassNames).toHaveLength(73);
    expect(device.totalDrawCount).toBe(73);
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      1, 1, 1,
    ]);
    scope.dispose();
  });

  it('queues bounded faces and publishes only after one final completion', async () => {
    const { device, scope, cache, options } = await fixture();
    const passes: string[][] = [];
    let offset = 0;
    const renderOpportunities: number[] = [];
    const submit = device.queue.submit.bind(device.queue);
    vi.spyOn(device.queue, 'submit').mockImplementation((buffers) => {
      passes.push(device.framePassNames.slice(offset));
      offset = device.framePassNames.length;
      return submit(buffers);
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      renderOpportunities.push(passes.length);
      queueMicrotask(() => callback(0));
      return renderOpportunities.length;
    });
    let fences = 0;
    let release!: () => void;
    const lastFence = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
      fences++;
      expect(cache.prefilterBakeCount).toBe(0);
      if (passes.at(-1)?.includes('ibl-brdf-lut')) await lastFence;
    });
    let settled = false;
    const result = runIblPrecompute(options).then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(passes.at(-1)).toEqual(['ibl-brdf-lut']));
      expect(passes.filter((batch) => batch.includes('ibl-prefilter'))).toEqual(
        Array.from({ length: 60 }, () => ['ibl-prefilter']),
      );
      expect(settled).toBe(false);
      expect(passes).toHaveLength(68);
      expect(renderOpportunities).toEqual([1, 7, 13, 19, 25, 31, 37, 43, 49, 55, 61, 67]);
      expect(fences).toBe(1);
      expect(device.totalDrawCount).toBe(73);
    } finally {
      release();
    }
    expect((await result).unwrap().prefilterTexture).toBeDefined();
    expect(fences, 'ordered face-sized submissions need only one final GPU fence').toBe(1);
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      1, 1, 1,
    ]);
    scope.dispose();
  });

  it.each([
    'fence failure',
    'scope retirement',
  ])('does not publish after the final %s', async (failure) => {
    const { device, scope, cache, options } = await fixture();
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
      if (!device.framePassNames.includes('ibl-prefilter')) return;
      if (failure === 'fence failure') throw new Error('device lost');
      scope.abandon();
    });
    const result = await runIblPrecompute(options);
    expect(result).toMatchObject({ ok: false, error: { code: 'ibl-precompute-not-dispatched' } });
    expect(device.framePassNames.filter((name) => name === 'ibl-prefilter')).toHaveLength(60);
    expect(device.framePassNames).toContain('ibl-brdf-lut');
    expect(device.totalDrawCount).toBe(73);
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      0, 0, 0,
    ]);
    scope.dispose();
  });

  it.each([
    'submission rejection',
    'scope retirement',
  ])('stops queueing bounded faces after %s', async (failure) => {
    const { device, scope, cache, options } = await fixture();
    const submit = device.queue.submit.bind(device.queue);
    let submitted = 0;
    vi.spyOn(device.queue, 'submit').mockImplementation((buffers) => {
      submitted++;
      if (submitted === 8) {
        if (failure === 'submission rejection') {
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'injected IBL submission rejection',
              hint: 'candidate outputs must not publish',
            }),
          );
        }
        scope.abandon();
      }
      return submit(buffers);
    });
    const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone');
    const result = await runIblPrecompute(options);
    expect(result).toMatchObject({ ok: false, error: { code: 'ibl-precompute-not-dispatched' } });
    expect(submitted).toBe(8);
    expect(fence).not.toHaveBeenCalled();
    expect(device.framePassNames.filter((name) => name === 'ibl-prefilter')).toHaveLength(1);
    expect(device.framePassNames).not.toContain('ibl-brdf-lut');
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      0, 0, 0,
    ]);
    scope.dispose();
  });

  it('rejects an inactive generation before allocating or submitting', async () => {
    const { device, scope, options } = await fixture();
    scope.abandon();
    const allocate = vi.spyOn(device, 'createTexture');
    const submit = vi.spyOn(device.queue, 'submit');
    const result = await runIblPrecompute(options);
    expect(result).toMatchObject({ ok: false, error: { code: 'ibl-precompute-not-dispatched' } });
    expect(allocate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    scope.dispose();
  });

  it('rejects retirement while the final completion is held', async () => {
    const { device, scope, cache, options } = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fence = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
      await held;
    });
    let settled = false;
    const pending = runIblPrecompute(options).then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(1));
      expect(device.totalDrawCount).toBe(73);
      expect(settled).toBe(false);
      scope.abandon();
    } finally {
      release();
    }
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'ibl-precompute-not-dispatched' },
    });
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      0, 0, 0,
    ]);
    scope.dispose();
  });
});
