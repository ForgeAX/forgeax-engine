import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { readbackDepthTexture } from '../readback-depth';
import { wrap } from '../recorder';

it.each([
  'drain',
  'map',
] as const)('releases depth output and staging when %s is cancelled', async (stage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = device
    .createTexture({ size: [4, 4], format: 'depth32float', usage: 0x14 })
    .unwrap();
  const destroyBuffer = vi.spyOn(device, 'destroyBuffer');
  const destroyTexture = vi.spyOn(device, 'destroyTexture');
  let cancelled = false;
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(() => {
    if (stage === 'drain') {
      cancelled = true;
      return new Promise<undefined>(() => {});
    }
    return Promise.resolve(undefined);
  });
  if (stage === 'map') {
    const createBuffer = device.createBuffer.bind(device);
    vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
      const result = createBuffer(desc);
      if (result.ok)
        Object.defineProperty(result.value, 'mapAsync', {
          value: () => {
            cancelled = true;
            return new Promise(() => {});
          },
        });
      return result;
    });
  }
  const result = await readbackDepthTexture(
    device,
    source,
    4,
    4,
    0,
    0,
    createShaderModule,
    false,
    () => cancelled,
  );
  expect(result.ok).toBe(false);
  expect(destroyBuffer).toHaveBeenCalledTimes(1);
  expect(destroyTexture).toHaveBeenCalledTimes(1);
  expect(destroyTexture).not.toHaveBeenCalledWith(source);
});

it.each(['shader', 'drain'] as const)('does not seed depth retired during %s', async (stage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const adapter = (await rhi.requestAdapter()).unwrap();
  vi.spyOn(adapter, 'requestDevice').mockResolvedValue(ok(device));
  let retire = () => {};
  const shader = async (...args: Parameters<typeof createShaderModule>) => {
    const result = await createShaderModule(...args);
    if (stage === 'shader') retire();
    return result;
  };
  const recorder = wrap({ requestAdapter: async () => ok(adapter) }, shader);
  const recordedDevice = (
    await (await recorder.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const source = recordedDevice
    .createTexture({ size: [4, 4], format: 'depth32float', usage: 0x14 })
    .unwrap();
  retire = () => {
    recordedDevice.destroyTexture(source).unwrap();
  };
  const submit = vi.spyOn(device.queue, 'submit');
  let drains = 0;
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
    if (++drains === 2 && stage === 'drain') retire();
  });
  recorder.arm(1).unwrap();
  const result = await recorder.snapshotAllLiveResources();
  expect(result.ok).toBe(true);
  expect(recorder.getEvents().filter((event) => event.kind === 'initialData')).toEqual([]);
  expect(recorder.getBlobPool().size).toBe(0);
  if (stage === 'shader') expect(submit).not.toHaveBeenCalled();
});
