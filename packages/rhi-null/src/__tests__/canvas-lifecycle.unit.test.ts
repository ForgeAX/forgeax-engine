import type { CommandBuffer, RhiCanvasContext, Texture } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOKKEEPING_KEY, readRecord } from '../bookkeeping';
import type { RhiNullDevice } from '../device';
import { rhi } from '../index';
import { RhiNullQueue } from '../queue';

async function device(): Promise<RhiNullDevice> {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap() as RhiNullDevice;
}

function context(owner: RhiNullDevice, surface = { width: 64, height: 32 }): RhiCanvasContext {
  const ctx = rhi.acquireCanvasContext(surface as HTMLCanvasElement).unwrap();
  ctx.configure({ device: owner, format: 'bgra8unorm', usage: 0x13 }).unwrap();
  return ctx;
}

function pass(owner: RhiNullDevice, texture: Texture): CommandBuffer {
  const encoder = owner.createCommandEncoder().unwrap();
  const view = owner.createTextureView(texture, {}).unwrap();
  encoder
    .beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] })
    .end();
  return encoder.finish().unwrap();
}

function completion() {
  let resolve!: (value: undefined) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve: () => resolve(undefined), reject };
}

describe('canvas submission lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps synchronous acquisitions and encoded views live across microtasks and tasks', async () => {
    const owner = await device();
    const ctx = context(owner);
    const first = ctx.getCurrentTexture().unwrap();
    const view = owner.createTextureView(first, {}).unwrap();
    pass(owner, first);
    expect(ctx.getCurrentTexture().unwrap()).toBe(first);
    expect(owner.bookkeeper.isDestroyed(view)).toBe(false);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.getCurrentTexture().unwrap()).toBe(first);
    expect(owner.bookkeeper.isDestroyed(first)).toBe(false);
  });

  it('expires only actual related accepted work and retires after completion', async () => {
    const owner = await device();
    const a = context(owner);
    const b = context(owner);
    const first = a.getCurrentTexture().unwrap();
    const view = owner.createTextureView(first, {}).unwrap();
    owner.queue.submit([]).unwrap();
    owner.queue.writeTexture({ texture: first }, new Uint8Array(4), {}, [1, 1, 1]).unwrap();
    owner.queue.submit([owner.createCommandEncoder().unwrap().finish().unwrap()]).unwrap();
    expect(a.getCurrentTexture().unwrap()).toBe(first);
    owner.queue.submit([pass(owner, b.getCurrentTexture().unwrap())]).unwrap();
    expect(a.getCurrentTexture().unwrap()).toBe(first);
    owner.queue.submit([pass(owner, first)]).unwrap();
    const next = a.getCurrentTexture().unwrap();
    expect(next).not.toBe(first);
    expect(owner.bookkeeper.isDestroyed(first)).toBe(false);
    expect(owner.bookkeeper.isDestroyed(view)).toBe(false);
    await owner.queue.onSubmittedWorkDone();
    expect(owner.bookkeeper.isDestroyed(first)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(view)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(next)).toBe(false);
  });

  it('rejects unknown, foreign, wrong-kind and destroyed buffers atomically', async () => {
    const owner = await device();
    const foreign = await device();
    const ctx = context(owner);
    const first = ctx.getCurrentTexture().unwrap();
    const valid = pass(owner, first);
    const unknown = {} as CommandBuffer;
    const other = foreign.createCommandEncoder().unwrap().finish().unwrap();
    const wrongKind = owner
      .createBuffer({ size: 4, usage: 8 })
      .unwrap() as unknown as CommandBuffer;
    const destroyed = owner.createCommandEncoder().unwrap().finish().unwrap();
    owner.bookkeeper.destroy(destroyed).unwrap();
    const forged = { [BOOKKEEPING_KEY]: readRecord(valid) } as unknown as CommandBuffer;
    for (const invalid of [unknown, other, wrongKind, destroyed, forged]) {
      expect(owner.queue.submit([valid, invalid]).ok).toBe(false);
      expect(ctx.getCurrentTexture().unwrap()).toBe(first);
    }
    expect(owner.queue.submit([valid, valid]).ok).toBe(false);
    expect(ctx.getCurrentTexture().unwrap()).toBe(first);
    owner.queue.submit([valid]).unwrap();
    expect(owner.queue.submit([valid]).ok).toBe(false);
    await owner.queue.onSubmittedWorkDone();
    expect(owner.bookkeeper.isDestroyed(first)).toBe(true);
  });

  it('retains encoded color, resolve and depth parents after descriptor mutation', async () => {
    const owner = await device();
    const contexts = [context(owner), context(owner)];
    const textures = contexts.map((ctx) => ctx.getCurrentTexture().unwrap());
    const views = textures.map((texture) => owner.createTextureView(texture, {}).unwrap());
    const [color, resolve] = views;
    if (color === undefined || resolve === undefined) throw new Error('missing attachments');
    const depthTexture = owner
      .createTexture({ size: [64, 32], format: 'depth32float', usage: 16 })
      .unwrap();
    const depth = owner.createTextureView(depthTexture, {}).unwrap();
    const msaaTexture = owner
      .createTexture({ size: [64, 32], format: 'bgra8unorm', usage: 16, sampleCount: 4 })
      .unwrap();
    const msaa = owner.createTextureView(msaaTexture, {}).unwrap();
    const encoder = owner.createCommandEncoder().unwrap();
    const attachment = {
      view: color,
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
    };
    const descriptor = {
      colorAttachments: [attachment],
      depthStencilAttachment: {
        view: depth,
        depthLoadOp: 'clear' as const,
        depthStoreOp: 'store' as const,
        depthClearValue: 1,
      },
    };
    encoder.beginRenderPass(descriptor).end();
    encoder
      .beginRenderPass({
        colorAttachments: [
          { view: msaa, resolveTarget: resolve, loadOp: 'clear', storeOp: 'discard' },
        ],
      })
      .end();
    // Reusing an attachment across ended passes must not duplicate its dependency.
    encoder.beginRenderPass(descriptor).end();
    attachment.view = owner
      .createTextureView(
        owner.createTexture({ size: [1, 1], format: 'bgra8unorm', usage: 16 }).unwrap(),
        {},
      )
      .unwrap();
    descriptor.colorAttachments.length = 0;
    const commands = encoder.finish().unwrap();
    expect(readRecord(commands)?.references).toHaveLength(4);
    expect(Object.isFrozen(readRecord(commands)?.references)).toBe(true);
    owner.queue.submit([commands]).unwrap();
    for (const [index, ctx] of contexts.entries()) {
      expect(ctx.getCurrentTexture().unwrap()).not.toBe(textures[index]);
      expect(owner.bookkeeper.isDestroyed(textures[index])).toBe(false);
    }
    await owner.queue.onSubmittedWorkDone();
    for (const texture of textures) expect(owner.bookkeeper.isDestroyed(texture)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(depthTexture)).toBe(false);
    expect(owner.bookkeeper.isDestroyed(msaaTexture)).toBe(false);
  });

  it.each([
    'buffer-to-texture',
    'texture-to-buffer',
    'texture-to-texture',
  ] as const)('tracks real %s resources through normal finish and submit', async (kind) => {
    const owner = await device();
    const ctx = context(owner);
    const texture = ctx.getCurrentTexture().unwrap();
    const encoder = owner.createCommandEncoder().unwrap();
    const buffer = owner.createBuffer({ size: 256, usage: 0x0c }).unwrap();
    const other = owner.createTexture({ size: [1, 1], format: 'bgra8unorm', usage: 3 }).unwrap();
    const target = { texture: texture as unknown as GPUTexture };
    const info = { buffer: buffer as unknown as GPUBuffer, bytesPerRow: 256 };
    if (kind === 'buffer-to-texture') encoder.copyBufferToTexture(info, target, [1, 1, 1]);
    else if (kind === 'texture-to-buffer')
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1, 1]);
    else
      encoder.copyTextureToTexture(target, { texture: other as unknown as GPUTexture }, [1, 1, 1]);
    owner.queue.submit([encoder.finish().unwrap()]).unwrap();
    expect(ctx.getCurrentTexture().unwrap()).not.toBe(texture);
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(false);
    await owner.queue.onSubmittedWorkDone();
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(other)).toBe(false);
  });

  it('does not accept unfinished passes, poisoned encoders or stale dependencies', async () => {
    const owner = await device();
    const foreign = await device();
    const ctx = context(owner);
    const texture = ctx.getCurrentTexture().unwrap();
    const view = owner.createTextureView(texture, {}).unwrap();
    const encoder = owner.createCommandEncoder().unwrap();
    const pending = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
    });
    expect(encoder.finish().ok).toBe(false);
    expect(ctx.getCurrentTexture().unwrap()).toBe(texture);
    pending.end();
    const commands = encoder.finish().unwrap();
    expect(() =>
      encoder.copyTextureToTexture(
        { texture: texture as unknown as GPUTexture },
        { texture: texture as unknown as GPUTexture },
        [1, 1, 1],
      ),
    ).toThrow();
    const invalid = owner.createCommandEncoder().unwrap();
    const foreignView = foreign
      .createTextureView(
        foreign.createTexture({ size: [1, 1], format: 'bgra8unorm', usage: 16 }).unwrap(),
        {},
      )
      .unwrap();
    expect(() =>
      invalid.beginRenderPass({
        colorAttachments: [{ view: foreignView, loadOp: 'load', storeOp: 'store' }],
      }),
    ).toThrow();
    expect(invalid.finish().ok).toBe(false);
    expect(ctx.getCurrentTexture().unwrap()).toBe(texture);
    owner.destroyTexture(texture).unwrap();
    expect(owner.queue.submit([commands]).ok).toBe(false);
  });

  it.each([
    'configure',
    'resize',
    'unconfigure',
  ] as const)('late old completion after %s only retires its captured owner resource', async (transition) => {
    const owner = await device();
    const nextOwner = await device();
    const surface = { width: 64, height: 32 };
    const ctx = context(owner, surface);
    const old = ctx.getCurrentTexture().unwrap();
    const view = owner.createTextureView(old, {}).unwrap();
    const done = completion();
    vi.spyOn(owner.queue, 'onSubmittedWorkDone').mockReturnValue(done.promise);
    owner.queue.submit([pass(owner, old)]).unwrap();
    if (transition === 'configure')
      ctx.configure({ device: nextOwner, format: 'rgba8unorm' }).unwrap();
    else if (transition === 'resize') surface.width = 128;
    else {
      ctx.unconfigure();
      ctx.unconfigure();
      ctx.configure({ device: nextOwner, format: 'rgba8unorm' }).unwrap();
    }
    const next = ctx.getCurrentTexture().unwrap();
    const actualOwner = transition === 'resize' ? owner : nextOwner;
    expect(owner.bookkeeper.isDestroyed(old)).toBe(false);
    done.resolve();
    await done.promise;
    expect(owner.bookkeeper.isDestroyed(old)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(view)).toBe(true);
    expect(actualOwner.bookkeeper.isDestroyed(next)).toBe(false);
    expect(ctx.getCurrentTexture().unwrap()).toBe(next);
  });

  it('waits for the latest accepted use of an old texture', async () => {
    const owner = await device();
    const ctx = context(owner);
    const texture = ctx.getCurrentTexture().unwrap();
    const a = pass(owner, texture);
    const b = pass(owner, texture);
    const first = completion();
    const last = completion();
    vi.spyOn(owner.queue, 'onSubmittedWorkDone')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    owner.queue.submit([a]).unwrap();
    const next = ctx.getCurrentTexture().unwrap();
    owner.queue.submit([b]).unwrap();
    first.resolve();
    await first.promise;
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(false);
    last.resolve();
    await last.promise;
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(true);
    expect(ctx.getCurrentTexture().unwrap()).toBe(next);
  });

  it('keeps cleanup causes and exact failed resources available for retry', async () => {
    const owner = await device();
    const ctx = context(owner);
    const texture = ctx.getCurrentTexture().unwrap();
    const cause = new Error('retirement failed');
    const destroy = vi.spyOn(owner, 'destroyTexture').mockImplementationOnce(() => {
      throw cause;
    });
    try {
      ctx.unconfigure();
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
    }
    expect(ctx.getConfiguration()).toBeDefined();
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(false);
    ctx.unconfigure();
    ctx.unconfigure();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(true);
  });

  it('surfaces completion retirement errors while retaining the successor until explicit cleanup', async () => {
    const owner = await device();
    const ctx = context(owner);
    const old = ctx.getCurrentTexture().unwrap();
    owner.queue.submit([pass(owner, old)]).unwrap();
    const next = ctx.getCurrentTexture().unwrap();
    const cause = new RhiError({
      code: 'rhi-not-available',
      expected: 'successful retirement',
      hint: 'injected owner failure',
    });
    const destroy = vi.spyOn(owner, 'destroyTexture').mockReturnValue(err(cause));
    await owner.queue.onSubmittedWorkDone();
    const blocked = ctx.getCurrentTexture();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe(cause);
    expect(owner.bookkeeper.isDestroyed(old)).toBe(false);
    expect(owner.bookkeeper.isDestroyed(next)).toBe(false);
    destroy.mockRestore();
    expect(ctx.getCurrentTexture().ok).toBe(false);
    ctx.unconfigure();
    expect(owner.bookkeeper.isDestroyed(old)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(next)).toBe(true);
  });

  it('does not silently recover a transient completion cleanup exception', async () => {
    const owner = await device();
    const ctx = context(owner);
    const old = ctx.getCurrentTexture().unwrap();
    owner.queue.submit([pass(owner, old)]).unwrap();
    const next = ctx.getCurrentTexture().unwrap();
    const cause = new Error('transient cleanup exception');
    const destroy = vi.spyOn(owner, 'destroyTexture').mockImplementationOnce(() => {
      throw cause;
    });
    await owner.queue.onSubmittedWorkDone();
    const blocked = ctx.getCurrentTexture();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.cause).toBe(cause);
    expect(owner.bookkeeper.isDestroyed(old)).toBe(false);
    expect(owner.bookkeeper.isDestroyed(next)).toBe(false);
    ctx.unconfigure();
    ctx.unconfigure();
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(owner.bookkeeper.isDestroyed(old)).toBe(true);
  });

  it('retains resources after failed completion without claiming retirement', async () => {
    const owner = await device();
    const ctx = context(owner);
    const texture = ctx.getCurrentTexture().unwrap();
    const done = completion();
    vi.spyOn(owner.queue, 'onSubmittedWorkDone').mockReturnValue(done.promise);
    owner.queue.submit([pass(owner, texture)]).unwrap();
    const cause = new Error('completion failed');
    done.reject(cause);
    await done.promise.catch(() => undefined);
    const blocked = ctx.getCurrentTexture();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.cause).toBe(cause);
    expect(owner.bookkeeper.isDestroyed(texture)).toBe(false);
    expect(ctx.configure({ device: owner, format: 'bgra8unorm' }).ok).toBe(false);
    expect(() => ctx.unconfigure()).toThrow();
  });

  it('rejects rebinding and submission on an unowned queue', async () => {
    const owner = await device();
    const foreign = await device();
    const queue = new RhiNullQueue();
    expect(queue.submit([]).ok).toBe(false);
    queue.bind(owner.bookkeeper);
    expect(() => queue.bind(owner.bookkeeper)).toThrow();
    expect(() => queue.bind(foreign.bookkeeper)).toThrow();
  });
});
