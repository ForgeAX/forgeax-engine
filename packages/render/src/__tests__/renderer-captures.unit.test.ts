import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { createRendererCaptureOwner } from '../capture/renderer-captures';
import { RendererContractFailureError } from '../errors/render';
import type { CubeCameraSnapshot } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';

function snapshot(entityKey: number): CubeCameraSnapshot {
  return {
    entityKey,
    target: {} as RenderTarget,
    position: [0, 0, 0],
    near: 0.1,
    far: 10,
    updateIntent: 'on-demand',
    requestVersion: 1,
    faceBudget: 1,
  };
}

describe('Renderer cube capture ownership', () => {
  it('retains six-face progress through view changes and schedules each target once', () => {
    const owner = createRendererCaptureOwner((target) => target);
    const a = snapshot(1);
    const b = snapshot(2);
    const faces: string[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      // The authoring roster is renderer data, independent of display view cadence.
      const work = owner.prepare(frame % 2 === 0 ? [a, b] : [b, a]);
      expect(work).toHaveLength(1);
      expect(work[0]?.target).toBe(a.target);
      faces.push(work[0]?.face ?? '');
      owner.complete(true);
    }
    expect(new Set(faces).size).toBe(6);
    expect(owner.isPending(a.target)).toBe(false);
    expect(owner.prepare([b, a])[0]?.target).toBe(b.target);
    owner.complete(true);
  });

  it('does not re-record an in-flight face and continues after its queue fence', async () => {
    const owner = createRendererCaptureOwner((target) => target);
    const a = snapshot(1);
    const first = owner.prepare([a])[0]?.face;
    let resolve!: () => void;
    const fence = new Promise<void>((done) => {
      resolve = done;
    });
    owner.complete(true, fence);
    expect(owner.prepare([a])).toEqual([]);
    resolve();
    await fence;
    expect(owner.prepare([a])[0]?.face).not.toBe(first);
    owner.complete(true);
  });

  it('cancels a removed target and retries failed transactions from an intact candidate', () => {
    const owner = createRendererCaptureOwner((target) => target);
    const a = snapshot(1);
    const b = snapshot(2);
    const first = owner.prepare([a])[0]?.face;
    owner.complete(false);
    expect(owner.prepare([a])[0]?.face).toBe(first);
    owner.complete(true);
    expect(owner.prepare([b])[0]?.target).toBe(b.target);
    expect(owner.isPending(a.target)).toBe(false);
    owner.complete(true);
  });
  it('ignores an old completion fence after physical storage is replaced', async () => {
    let storage = {};
    const owner = createRendererCaptureOwner(() => storage);
    const camera = snapshot(1);
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    let complete!: () => void;
    const oldFence = new Promise<void>((resolve) => {
      complete = resolve;
    });
    owner.complete(true, oldFence);
    storage = {};
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    complete();
    await oldFence;
    // The old fence must not acknowledge the new storage's first face.
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    owner.complete(true);
    expect(owner.prepare([camera])[0]?.face).toBe('-X');
    owner.complete(true);
  });

  it('restarts an in-flight cube on the replacement device and ignores its old host fence', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    let device = (await adapter.requestDevice()).unwrap();
    let generation = 0;
    const owner = createRendererCaptureOwner((target) => host.getPhysicalTarget(target));
    const host = createRenderTargetHost({
      getDevice: () => device,
      getGeneration: () => generation,
      canPromoteTarget: (target) => !owner.isPending(target),
    });
    const created = host.createRenderTarget({
      shape: 'cube',
      width: 16,
      height: 16,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    if (!created.ok) throw created.error;
    const target = created.value;
    const camera = { ...snapshot(1), target };
    host.beginFrame();
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    const previous = host.getPhysicalTarget(target);
    let finishOld!: () => void;
    const oldFence = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    owner.complete(true, oldFence);
    host.onFrameSubmitted(
      oldFence.then(
        () =>
          ({
            ok: false,
            error: new RendererContractFailureError('draw', 'old device lost'),
          }) as const,
      ),
    );
    generation = 1;
    host.recover();
    device = (await adapter.requestDevice()).unwrap();
    host.beginFrame();
    const replacement = host.getPhysicalTarget(target);
    expect(replacement).not.toBe(previous);
    expect(replacement?.generation).toBe(1);
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    finishOld();
    await oldFence;
    await Promise.resolve();
    expect(host.getPhysicalTarget(target)).toBe(replacement);
    owner.complete(true);
    host.onFrameSubmitted();
    await Promise.resolve();
    for (let face = 1; face < 6; face += 1) {
      host.beginFrame();
      expect(owner.prepare([camera])).toHaveLength(1);
      owner.complete(true);
      host.onFrameSubmitted();
      await Promise.resolve();
    }
    expect(owner.prepare([camera])).toEqual([]);
    expect(host.getPhysicalTarget(target)?.generation).toBe(1);
    host.dispose();
  });

  it.each([
    'once',
    'on-demand',
  ] as const)('rebuilds completed %s captures after recovery and resize', async (updateIntent) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    let device = (await adapter.requestDevice()).unwrap();
    let generation = 0;
    const owner = createRendererCaptureOwner((target) => host.getPhysicalTarget(target));
    const host = createRenderTargetHost({
      getDevice: () => device,
      getGeneration: () => generation,
      canPromoteTarget: (target) => !owner.isPending(target),
    });
    const descriptor = {
      shape: 'cube',
      width: 16,
      height: 16,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    } as const;
    const created = host.createRenderTarget(descriptor);
    if (!created.ok) throw created.error;
    const target = created.value;
    const camera = { ...snapshot(1), target, updateIntent };
    const capture = async () => {
      const faces = [];
      for (let frame = 0; frame < 6; frame += 1) {
        host.beginFrame();
        const work = owner.prepare([camera]);
        expect(work).toHaveLength(1);
        faces.push(work[0]?.face);
        owner.complete(true);
        host.onFrameSubmitted();
        await Promise.resolve();
      }
      expect(new Set(faces).size).toBe(6);
      expect(owner.prepare([camera])).toEqual([]);
    };
    await capture();
    const previous = host.getPhysicalTarget(target);
    generation += 1;
    device = (await adapter.requestDevice()).unwrap();
    host.recover();
    await capture();
    expect(host.getPhysicalTarget(target)).not.toBe(previous);
    expect(host.getPhysicalTarget(target)?.generation).toBe(generation);
    const resized = host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 });
    if (!resized.ok) throw resized.error;
    await capture();
    expect(host.getPhysicalTarget(target)?.descriptor.width).toBe(32);
    host.dispose();
  });
});
