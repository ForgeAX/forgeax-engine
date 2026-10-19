import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createPostProcessParamsOwner } from '../assembly/post-process-params';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { RhiErrorListenerRegistry } from '../lifecycle';

it('retains graph-admitted params when native pipeline preparation aborts the frame', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    vi.fn(),
  );
  const entry: PostProcessShaderEntry = {
    source: 'synthetic',
    params: { byteSize: 32, defaultValue: new Uint8Array(32) },
  };
  const entries = new Map([['overlay', entry]]);
  const admitted = owner.prepare(entries).unwrap();
  owner.accept(admitted);
  owner.featureEntries = entries;
  const buffer = owner.getBuffer('overlay');
  expect(buffer).toBeDefined();
  // Graph admission precedes the native shadow PSO preparation barrier.
  owner.discard(admitted);
  expect(destroy.mock.calls.some(([value]) => value === buffer)).toBe(false);
  const reused = owner.prepare(entries).unwrap();
  expect(reused.buffers.get('overlay')).toBe(buffer);
  owner.discard(reused);
  expect(destroy).not.toHaveBeenCalled();
  owner.dispose();
  expect(destroy).toHaveBeenCalledExactlyOnceWith(buffer);
});

it('discards params which never entered the accepted graph', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    vi.fn(),
  );
  const candidate = owner
    .prepare(
      new Map([
        [
          'overlay',
          {
            source: 'synthetic',
            params: { byteSize: 32, defaultValue: new Uint8Array(32) },
          },
        ],
      ]),
    )
    .unwrap();
  owner.discard(candidate);
  expect(destroy).toHaveBeenCalledExactlyOnceWith(candidate.buffers.get('overlay'));
  expect(owner.getBuffer('overlay')).toBeUndefined();
});

it('transfers disposal ownership on admission and retires a superseded buffer once', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    vi.fn(),
  );
  const entry: PostProcessShaderEntry = {
    source: 'first',
    params: { byteSize: 32, defaultValue: new Uint8Array(32) },
  };
  const firstEntries = new Map([['overlay', entry]]);
  const first = owner.prepare(firstEntries).unwrap();
  const buffer = first.buffers.get('overlay');
  owner.accept(first);
  owner.featureEntries = firstEntries;
  const replacementEntries = new Map([['overlay', { ...entry, source: 'replacement' }]]);
  owner.accept(owner.prepare(replacementEntries).unwrap());
  owner.featureEntries = replacementEntries;
  await device.queue.onSubmittedWorkDone();
  owner.discard(first);
  expect(destroy.mock.calls.filter(([value]) => value === buffer)).toHaveLength(1);
  owner.dispose();
});

it('keeps accepted candidates detached across builtin registration and late discard', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    vi.fn(),
  );
  const entry: PostProcessShaderEntry = {
    source: 'overlay',
    params: { byteSize: 32, defaultValue: new Uint8Array(32) },
  };
  const entries = new Map([['overlay', entry]]);
  const first = owner.prepare(entries).unwrap();
  owner.accept(first);
  owner.featureEntries = entries;
  const overlay = first.buffers.get('overlay');
  const unregister = owner.registerBuiltinPostProcess('builtin', { ...entry, source: 'builtin' });
  const builtin = owner.getBuffer('builtin');
  expect(first.buffers.has('builtin')).toBe(false);
  const second = owner.prepare(entries).unwrap();
  owner.accept(second);
  owner.discard(first);
  expect(destroy).not.toHaveBeenCalled();
  unregister();
  expect(second.buffers.get('builtin')).toBe(builtin);
  expect(owner.getBuffer('builtin')).toBeUndefined();
  expect(owner.getBuffer('overlay')).toBe(overlay);
  owner.discard(second);
  owner.dispose();
  expect(destroy.mock.calls.filter(([buffer]) => buffer === overlay)).toHaveLength(1);
  expect(destroy.mock.calls.filter(([buffer]) => buffer === builtin)).toHaveLength(1);
});
