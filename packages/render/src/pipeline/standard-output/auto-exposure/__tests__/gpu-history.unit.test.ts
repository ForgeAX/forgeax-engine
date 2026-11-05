import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import {
  abortAutoExposureGpuFrame,
  beginAutoExposureGpuFrame,
  completeAutoExposureGpuFrame,
  createAutoExposureGpuResources,
  retireAutoExposureGpuResources,
  writeAutoExposureParameters,
} from '../gpu';

it('promotes only the completed exposure slot and protects all in-flight previous reads', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const resources = createAutoExposureGpuResources(device, 1).unwrap();
  const queues: (() => void)[] = [];
  const original = device.queue.onSubmittedWorkDone;
  device.queue.onSubmittedWorkDone = () =>
    new Promise<undefined>((resolve) => queues.push(() => resolve(undefined)));
  const firstState = resources.state;
  const accepted: number[] = [];
  beginAutoExposureGpuFrame(resources).unwrap();
  const firstCandidate = resources.candidate;
  completeAutoExposureGpuFrame(resources, () => accepted.push(1));
  expect(resources.state).toBe(firstState);
  beginAutoExposureGpuFrame(resources).unwrap();
  const secondCandidate = resources.candidate;
  expect(secondCandidate).not.toBe(firstCandidate);
  expect(secondCandidate).not.toBe(firstState);
  completeAutoExposureGpuFrame(resources, () => accepted.push(2));
  queues[0]?.();
  await Promise.resolve();
  expect(accepted).toEqual([1]);
  expect(resources.state).toBe(firstCandidate);
  beginAutoExposureGpuFrame(resources).unwrap();
  expect(resources.candidate).not.toBe(secondCandidate);
  // The second in-flight frame still reads the original state.
  expect(resources.candidate).not.toBe(firstState);
  abortAutoExposureGpuFrame(resources);
  queues[1]?.();
  await Promise.resolve();
  expect(resources.state).toBe(secondCandidate);
  expect(accepted).toEqual([1, 2]);
  device.queue.onSubmittedWorkDone = original;
  retireAutoExposureGpuResources(resources);
});

it('retains distinct completed previous states while four later frames are in flight', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const resources = createAutoExposureGpuResources(device, 1).unwrap();
  const completions: (() => void)[] = [];
  device.queue.onSubmittedWorkDone = () =>
    new Promise<undefined>((resolve) => completions.push(() => resolve(undefined)));
  beginAutoExposureGpuFrame(resources).unwrap();
  completeAutoExposureGpuFrame(resources, () => {});
  beginAutoExposureGpuFrame(resources).unwrap();
  completeAutoExposureGpuFrame(resources, () => {});
  completions[0]?.();
  await Promise.resolve();
  // The second frame still reads the original state; three more candidates
  // must fit beside its read, the completed current and four pending writes.
  for (let index = 0; index < 3; index++) {
    expect(beginAutoExposureGpuFrame(resources).ok).toBe(true);
    completeAutoExposureGpuFrame(resources, () => {});
  }
  retireAutoExposureGpuResources(resources);
  for (const complete of completions) complete();
});

it('fences stale camera or extent completions and invalidates GPU history without uploading a result', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const resources = createAutoExposureGpuResources(device, 7).unwrap();
  const completions: (() => void)[] = [];
  device.queue.onSubmittedWorkDone = () =>
    new Promise<undefined>((resolve) => completions.push(() => resolve(undefined)));
  const params = {
    compensationEv: 0,
    rangeMinEv: -8,
    rangeMaxEv: 8,
    upRate: 3,
    downRate: 1,
    deltaTime: 1 / 60,
    fallback: 1,
    generation: 7,
  };
  const initial = resources.state;
  beginAutoExposureGpuFrame(resources).unwrap();
  writeAutoExposureParameters(resources, { ...params, historyIdentity: 'view:1:640x360' }).unwrap();
  let promoted = false;
  completeAutoExposureGpuFrame(resources, () => {
    promoted = true;
  });
  beginAutoExposureGpuFrame(resources).unwrap();
  writeAutoExposureParameters(resources, { ...params, historyIdentity: 'view:2:800x600' }).unwrap();
  completions[0]?.();
  await Promise.resolve();
  expect(promoted).toBe(false);
  expect(resources.state).toBe(initial);
  abortAutoExposureGpuFrame(resources);
  retireAutoExposureGpuResources(resources);
  for (const complete of completions) complete();
});
