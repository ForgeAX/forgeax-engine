import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuPrepareSession,
} from '../features/prepared-gpu-work';

const programDescriptor = {
  wgsl: '@group(0) @binding(0) var<storage, read_write> values: array<u32>; @compute @workgroup_size(1) fn main() { values[0] = 1u; }',
  entryPoints: ['main'],
  bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
};

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: programDescriptor.wgsl })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('transaction', 0);
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  return { device, owner, session, destroyed };
}

function compute(session: RenderFeatureGpuPrepareSession, buffer: RenderFeatureGpuBufferRef) {
  const program = session.prepareProgram('program', programDescriptor).unwrap();
  const bindings = session
    .prepareBindings('bindings', { program, entries: [{ binding: 0, buffer }] })
    .unwrap();
  return { program, bindings, dispatches: [{ entryPoint: 'main', workgroups: [1] as const }] };
}

const release = (session: RenderFeatureGpuPrepareSession) => {
  for (const lease of session.commitFrame()) lease.release().unwrap();
};

describe('feature GPU frame transactions', () => {
  it('keeps a repeatedly resolved old binding until its own completion fence after replacement', async () => {
    const { session, owner, destroyed } = await fixture();
    const old = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    const oldWork = compute(session, old);
    const oldBuffer = session.resolveBuffer(old)?.buffer;
    release(session);
    session.beginFrame();
    session.retainBindings([oldWork.bindings, oldWork.bindings]).unwrap();
    const next = session.prepareBuffer('storage', { size: 64, usage: ['storage'] }).unwrap();
    const nextWork = compute(session, next);
    const nextBuffer = session.resolveBuffer(next)?.buffer;
    for (const work of [oldWork, nextWork, oldWork])
      expect(
        session
          .resolveComputePass('transaction', {
            ...work,
            dispatches: [...work.dispatches, ...work.dispatches],
          })
          .unwrap().dispatches,
      ).toHaveLength(2);
    release(session);
    expect(destroyed).not.toHaveBeenCalled();
    session.beginFrame();
    session.retainBindings([nextWork.bindings]).unwrap();
    const oldFence = session.commitFrame();
    expect(destroyed).not.toHaveBeenCalled();
    for (const lease of oldFence) lease.release().unwrap();
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(oldBuffer);
    expect(session.resolveBuffer(old)).toBeUndefined();
    expect(session.resolveBuffer(next)?.buffer).toBe(nextBuffer);
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(2);
  });

  it('restores accepted active-name order and first values after repeated overwrites and new names', async () => {
    const { session, owner, destroyed } = await fixture();
    const accepted = ['a', 'b', 'c'].map((name) =>
      session.prepareBuffer(name, { size: 16, usage: ['storage'] }).unwrap(),
    );
    const acceptedBuffers = accepted.map((reference) => session.resolveBuffer(reference)?.buffer);
    release(session);
    session.beginFrame();
    const first = session.prepareBuffer('b', { size: 64, usage: ['storage'] }).unwrap();
    const temporary = session.prepareBuffer('new', { size: 16, usage: ['storage'] }).unwrap();
    const second = session.prepareBuffer('b', { size: 128, usage: ['storage'] }).unwrap();
    session.prepareBuffer('a', { size: 16, usage: ['storage'] }).unwrap();
    session.abortFrame().unwrap();
    const names: string[] = [];
    session.retainResources((name) => {
      names.push(name);
      return true;
    });
    expect(names).toEqual(['a', 'b', 'c']);
    expect(accepted.map((reference) => session.resolveBuffer(reference)?.buffer)).toEqual(
      acceptedBuffers,
    );
    for (const reference of [first, second, temporary])
      expect(session.resolveBuffer(reference)).toBeUndefined();
    expect(destroyed).toHaveBeenCalledTimes(3);
    session.beginFrame();
    for (const [index, name] of ['a', 'b', 'c'].entries())
      expect(session.prepareBuffer(name, { size: 16, usage: ['storage'] }).unwrap()).toBe(
        accepted[index],
      );
    release(session);
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(6);
  });

  it('aborts every staged replacement of one name while retaining the accepted buffer and bindings', async () => {
    const { session, owner, destroyed } = await fixture();
    const accepted = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    const acceptedBuffer = session.resolveBuffer(accepted)?.buffer;
    const acceptedWork = compute(session, accepted);
    const acceptedPass = session.resolveComputePass('transaction', acceptedWork).unwrap();
    release(session);

    session.beginFrame();
    const first = session.prepareBuffer('storage', { size: 64, usage: ['storage'] }).unwrap();
    const firstBuffer = session.resolveBuffer(first)?.buffer;
    const firstWork = compute(session, first);
    const second = session.prepareBuffer('storage', { size: 128, usage: ['storage'] }).unwrap();
    const secondBuffer = session.resolveBuffer(second)?.buffer;
    const secondWork = compute(session, second);
    session.abortFrame().unwrap();

    expect(destroyed).toHaveBeenCalledTimes(2);
    expect(destroyed).toHaveBeenCalledWith(firstBuffer);
    expect(destroyed).toHaveBeenCalledWith(secondBuffer);
    expect(destroyed).not.toHaveBeenCalledWith(acceptedBuffer);
    expect(session.resolveBuffer(first)).toBeUndefined();
    expect(session.resolveBuffer(second)).toBeUndefined();
    expect(session.resolveComputePass('transaction', firstWork).ok).toBe(false);
    expect(session.resolveComputePass('transaction', secondWork).ok).toBe(false);
    expect(session.resolveBuffer(accepted)?.buffer).toBe(acceptedBuffer);
    expect(
      session.resolveComputePass('transaction', acceptedWork).unwrap().dispatches[0]?.bindGroup,
    ).toBe(acceptedPass.dispatches[0]?.bindGroup);

    session.beginFrame();
    expect(session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap()).toBe(
      accepted,
    );
    expect(compute(session, accepted).bindings).toBe(acceptedWork.bindings);
    release(session);
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(3);
  });

  it('replaces owned sizes without destroying the prior submission before its completion lease', async () => {
    const { session, owner, destroyed } = await fixture();
    const old = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    const oldBuffer = session.resolveBuffer(old)?.buffer;
    release(session);
    session.beginFrame();
    const next = session.prepareBuffer('storage', { size: 64, usage: ['storage'] }).unwrap();
    expect(next).not.toBe(old);
    expect(session.resolveBuffer(next)?.size).toBe(64);
    expect([...session.changedResourceNames]).toEqual(['storage']);
    const completion = session.commitFrame();
    expect(completion).toHaveLength(1);
    expect(destroyed).not.toHaveBeenCalled();
    completion[0]?.release().unwrap();
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(oldBuffer);
    expect(session.resolveBuffer(old)).toBeUndefined();
    completion[0]?.release().unwrap();
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(2);
  });

  it('rebuilds same-name bindings when a borrowed native buffer changes', async () => {
    const { session, owner, device, destroyed } = await fixture();
    const a = device.createBuffer({ size: 16, usage: 136 }).unwrap();
    const b = device.createBuffer({ size: 16, usage: 136 }).unwrap();
    const first = session
      .prepareBufferResource('storage', a, { size: 16, usage: ['storage'] })
      .unwrap();
    const oldWork = compute(session, first);
    const oldBindGroup = session.resolveComputePass('transaction', oldWork).unwrap()
      .dispatches[0]?.bindGroup;
    release(session);
    session.beginFrame();
    const second = session
      .prepareBufferResource('storage', b, { size: 16, usage: ['storage'] })
      .unwrap();
    const newWork = compute(session, second);
    const resolved = session.resolveComputePass('transaction', newWork).unwrap();
    expect(newWork.program).toBe(oldWork.program);
    expect(newWork.bindings).not.toBe(oldWork.bindings);
    expect(resolved.dispatches[0]?.bindGroup).not.toBe(oldBindGroup);
    expect(resolved.buffers[0]?.buffer).toBe(b);
    expect(session.changedResourceNames).toEqual(new Set(['storage', 'bindings']));
    release(session);
    owner.dispose().unwrap();
    expect(destroyed).not.toHaveBeenCalled();
    device.destroyBuffer(a).unwrap();
    device.destroyBuffer(b).unwrap();
  });

  it('tracks native texture and sampler replacements and restores them after abort', async () => {
    const { session, owner, device } = await fixture();
    const texture = device
      .createTexture({
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: 4,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const viewA = device.createTextureView(texture, {}).unwrap();
    const viewB = device.createTextureView(texture, {}).unwrap();
    const samplerA = device.createSampler({}).unwrap();
    const samplerB = device.createSampler({ minFilter: 'linear' }).unwrap();
    const declaration = {
      ...programDescriptor,
      bindings: [
        {
          entries: [
            { binding: 0, visibility: 4, texture: { sampleType: 'float' as const } },
            { binding: 1, visibility: 4, sampler: { type: 'filtering' as const } },
          ],
        },
      ],
    };
    const prepare = (view: typeof viewA, sampler: typeof samplerA) => {
      const program = session.prepareProgram('program', declaration).unwrap();
      const viewRef = session.prepareTextureView('texture', view).unwrap();
      const samplerRef = session.prepareSampler('sampler', sampler).unwrap();
      const bindings = session
        .prepareBindings('bindings', {
          program,
          entries: [
            { binding: 0, resource: { kind: 'texture-view', reference: viewRef } },
            { binding: 1, resource: { kind: 'sampler', reference: samplerRef } },
          ],
        })
        .unwrap();
      return { program, bindings, dispatches: [{ entryPoint: 'main', workgroups: [1] as const }] };
    };
    const original = prepare(viewA, samplerA);
    const originalGroup = session.resolveComputePass('transaction', original).unwrap()
      .dispatches[0]?.bindGroup;
    release(session);
    session.beginFrame();
    const replacement = prepare(viewB, samplerB);
    expect(replacement.bindings).not.toBe(original.bindings);
    expect(
      session.resolveComputePass('transaction', replacement).unwrap().dispatches[0]?.bindGroup,
    ).not.toBe(originalGroup);
    expect(session.changedResourceNames).toEqual(new Set(['texture', 'sampler', 'bindings']));
    session.abortFrame().unwrap();
    session.beginFrame();
    expect(prepare(viewA, samplerA).bindings).toBe(original.bindings);
    expect(session.changedResourceNames.size).toBe(0);
    release(session);
    session.beginFrame();
    const changedProgram = session
      .prepareProgram('program', { ...declaration, entryPoints: ['other'] })
      .unwrap();
    expect(changedProgram).not.toBe(original.program);
    expect(session.changedResourceNames).toEqual(new Set(['program']));
    session.abortFrame().unwrap();
    session.beginFrame();
    expect(prepare(viewA, samplerA).program).toBe(original.program);
    release(session);
    owner.dispose().unwrap();
    device.destroyTexture(texture).unwrap();
  });

  it('aborts resized buffers and dependent bindings while preserving the accepted compute graph', async () => {
    const { session, owner, destroyed } = await fixture();
    const old = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    const oldWork = compute(session, old);
    const oldNative = session.resolveComputePass('transaction', oldWork).unwrap();
    release(session);
    session.beginFrame();
    const next = session.prepareBuffer('storage', { size: 64, usage: ['storage'] }).unwrap();
    compute(session, next);
    const discarded = session.resolveBuffer(next)?.buffer;
    session.abortFrame().unwrap();
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(discarded);
    expect(session.resolveBuffer(next)).toBeUndefined();
    session.beginFrame();
    expect(session.changedResourceNames.size).toBe(0);
    const retry = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    expect(retry).toBe(old);
    expect(compute(session, retry).bindings).toBe(oldWork.bindings);
    expect(
      session.resolveComputePass('transaction', oldWork).unwrap().dispatches[0]?.bindGroup,
    ).toBe(oldNative.dispatches[0]?.bindGroup);
    expect(session.changedResourceNames.size).toBe(0);
    release(session);
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(2);
  });

  it('cancels an earlier retirement when a retained view reuses the resource before its fence', async () => {
    const { session, owner, destroyed } = await fixture();
    const old = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    const work = compute(session, old);
    release(session);
    session.beginFrame();
    const earlierFence = session.commitFrame();
    session.beginFrame();
    session.retainBindings([work.bindings]).unwrap();
    const native = session.resolveBuffer(old)?.buffer;
    release(session);
    for (const lease of earlierFence) lease.release().unwrap();
    expect(destroyed).not.toHaveBeenCalled();
    session.beginFrame();
    const latestFence = session.commitFrame();
    expect(latestFence).toHaveLength(1);
    for (const lease of latestFence) lease.release().unwrap();
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(native);
    expect(session.resolveBuffer(old)).toBeUndefined();
    expect(session.retainBindings([work.bindings]).ok).toBe(false);
    owner.dispose().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('discards new allocations after a preparation error and retries from the accepted state', async () => {
    const { session, owner, destroyed } = await fixture();
    const old = session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap();
    release(session);
    session.beginFrame();
    expect(
      session.prepareBuffer('storage', { size: 4, usage: ['storage'], data: new Uint32Array(8) })
        .ok,
    ).toBe(false);
    session.abortFrame().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(1);
    session.beginFrame();
    expect(session.prepareBuffer('storage', { size: 16, usage: ['storage'] }).unwrap()).toBe(old);
    release(session);
    owner.dispose().unwrap();
  });
});
