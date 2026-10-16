import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { releaseAtmosphere, retainAtmosphere } from '../environment/storage';
import { earthAtmosphere } from './atmosphere-fixture';

function environment(sun = 1, mie = earthAtmosphere.mieScattering) {
  return selectEnvironment({
    environments: [
      {
        kind: 'atmosphere',
        entityKey: 1,
        sourceKey: 'sky',
        atmosphere: { ...earthAtmosphere, mieScattering: mie },
      },
    ],
    fogs: [],
    suns: [{ entityKey: 2, direction: [sun, 1, 0], color: [1, 1, 1], intensity: 100000 }],
    lane: 'direct',
  }).unwrap();
}

it('pins a complete capture generation while sharing medium tables across changing suns', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const runtime = { device, deviceScope: DeviceScope.create(1, 'atmosphere-test') };
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const first = retainAtmosphere(runtime, environment());
  const same = retainAtmosphere(runtime, environment());
  expect(same.storage).toBe(first.storage);
  const next = retainAtmosphere(runtime, environment(2));
  expect(next.storage.sky).not.toBe(first.storage.sky);
  expect(next.storage.transmittance).toBe(first.storage.transmittance);
  expect(next.storage.environment.sun).not.toEqual(first.storage.environment.sun);
  const changed = retainAtmosphere(runtime, environment(3, 12e-6));
  expect(changed.storage.transmittance).not.toBe(first.storage.transmittance);
  releaseAtmosphere(runtime);
  await Promise.resolve();
  expect(destroyed).not.toHaveBeenCalled();
  same.release();
  first.release();
  next.release();
  changed.release();
  await device.queue.onSubmittedWorkDone();
  await Promise.resolve();
  expect(destroyed).toHaveBeenCalled();
  const handles = destroyed.mock.calls.map(([texture]) => texture);
  expect(new Set(handles).size).toBe(handles.length);
  runtime.deviceScope.retire();
});

it('keeps the previous pinned generation intact after a replacement allocation fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const runtime = { device, deviceScope: DeviceScope.create(1, 'atmosphere-failure-test') };
  const first = retainAtmosphere(runtime, environment());
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'test allocation failure',
    hint: 'test',
  });
  vi.spyOn(device, 'createTexture').mockReturnValueOnce(err(failure));
  expect(() => retainAtmosphere(runtime, environment(2))).toThrow(failure);
  const retained = retainAtmosphere(runtime, environment());
  expect(retained.storage).toBe(first.storage);
  retained.release();
  first.release();
  releaseAtmosphere(runtime);
  await device.queue.onSubmittedWorkDone();
  runtime.deviceScope.retire();
});

it('retains an in-flight capture without selecting its old environment for display', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const runtime = { device, deviceScope: DeviceScope.create(1, 'capture-display') };
  const capture = retainAtmosphere(runtime, environment());
  const display = retainAtmosphere(runtime, environment(2, 12e-6));
  const allocated = vi.spyOn(device, 'createTexture');
  const face = capture.storage.retain();
  const current = retainAtmosphere(runtime, environment(2, 12e-6));
  expect(face.storage).toBe(capture.storage);
  expect(current.storage).toBe(display.storage);
  expect(allocated).not.toHaveBeenCalled();
  for (const lease of [capture, display, face, current]) lease.release();
  releaseAtmosphere(runtime);
  await device.queue.onSubmittedWorkDone();
  runtime.deviceScope.retire();
});
