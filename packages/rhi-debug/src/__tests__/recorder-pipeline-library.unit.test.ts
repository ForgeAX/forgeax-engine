import type {
  PipelineLibrary,
  PipelineLibraryInspection,
  PipelineLibraryManifest,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { wrap } from '../recorder';

const manifest: PipelineLibraryManifest = {
  version: 1,
  backend: 'webgpu',
  shaders: [],
  bindGroupLayouts: [],
  pipelineLayouts: [],
  renderPipelines: [],
  computePipelines: [],
};

function library(): PipelineLibrary {
  const inspection: PipelineLibraryInspection = {
    state: 'active',
    shaders: 0,
    renderPipelines: 0,
    computePipelines: 0,
    shaderHits: 0,
    pipelineHits: 0,
    synchronousCreations: 0,
    asynchronousCreations: 0,
    compilationCompleted: 0,
    compilationPending: 0,
    failures: 0,
    unrecordable: 0,
    overflow: 0,
    sourceBytes: 0,
    warmup: { requested: 0, completed: 0, failed: 0, elapsedMs: 0 },
  };
  return {
    inspect: () => inspection,
    export: () => ok(manifest),
    prepare: async () => ok(inspection),
  };
}

async function recordedDevice(owner?: PipelineLibrary): Promise<RhiDevice> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const real = (await adapter.requestDevice()).unwrap();
  if (owner !== undefined) Object.defineProperty(real, 'pipelineLibrary', { value: owner });
  const recorder = wrap(
    { requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }) },
    createShaderModule,
  );
  return (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
}

it('preserves the exact device-owned pipeline library and its portable manifest', async () => {
  const owner = library(),
    device = await recordedDevice(owner);
  expect(device.pipelineLibrary).toBe(owner);
  expect(device.pipelineLibrary?.inspect()).toBe(owner.inspect());
  expect(device.pipelineLibrary?.export().unwrap()).toBe(manifest);
});

it('keeps native pipeline preparation pending until the owner completes', async () => {
  const owner = library();
  let finish: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  owner.prepare = vi.fn(async function (this: PipelineLibrary, input) {
    expect(this).toBe(owner);
    expect(input).toBe(manifest);
    await ready;
    return ok(owner.inspect());
  });
  const device = await recordedDevice(owner);
  if (device.pipelineLibrary === undefined)
    throw new Error('Recorder dropped pipeline preparation');
  const completion = device.pipelineLibrary.prepare(manifest),
    settled = vi.fn();
  void completion.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  if (finish === undefined) throw new Error('Missing preparation completion');
  finish();
  expect((await completion).unwrap()).toBe(owner.inspect());
  expect(owner.prepare).toHaveBeenCalledExactlyOnceWith(manifest);
});

it('preserves a rejected manifest as the original structured owner result', async () => {
  const owner = library();
  const cause = new RhiError({
    code: 'feature-not-enabled',
    expected: 'test manifest rejection',
    hint: 'keep the native failure',
  });
  const failure = err(cause);
  owner.prepare = async () => failure;
  const device = await recordedDevice(owner);
  if (device.pipelineLibrary === undefined)
    throw new Error('Recorder dropped pipeline preparation');
  expect(await device.pipelineLibrary.prepare(manifest)).toBe(failure);
});

it('keeps pipeline libraries scoped to their own physical devices', async () => {
  const first = library(),
    second = library();
  const a = await recordedDevice(first),
    b = await recordedDevice(second);
  expect(a.pipelineLibrary).toBe(first);
  expect(b.pipelineLibrary).toBe(second);
  expect(a.pipelineLibrary).not.toBe(b.pipelineLibrary);
});

it('does not synthesize pipeline preparation for a backend without that capability', async () => {
  expect((await recordedDevice()).pipelineLibrary).toBeUndefined();
});
