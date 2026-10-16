import type { RhiCommandEncoder, Texture } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import type { RenderError } from '../errors/render';
import type { RenderResult } from '../render-contract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import type { FramebufferSnapshotSource } from '../targets/framebuffer-snapshot';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 64,
  height: 32,
  format: 'rgba16float',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

const ok: RenderResult<void, RenderError> = { ok: true, value: undefined };

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let generation = 1;
  const host = createRenderTargetHost({ getDevice: () => device, getGeneration: () => generation });
  const created = host.createRenderTarget(descriptor);
  if (!created.ok) throw created.error;
  const copies: Parameters<RhiCommandEncoder['copyTextureToTexture']>[] = [];
  const encoder = {
    copyTextureToTexture: vi.fn(
      (...args: Parameters<RhiCommandEncoder['copyTextureToTexture']>) => {
        copies.push(args);
      },
    ),
  } as unknown as RhiCommandEncoder;
  const sceneColor = Object.freeze({}) as Texture;
  const source = (
    overrides: Partial<FramebufferSnapshotSource> = {},
  ): FramebufferSnapshotSource => ({
    texture: sceneColor,
    format: 'rgba16float',
    width: 128,
    height: 96,
    camera: undefined,
    role: 'display',
    ...overrides,
  });
  let frameId = 0;
  const frame = (
    sources: readonly FramebufferSnapshotSource[],
    completed: Promise<RenderResult<void, RenderError>> = Promise.resolve(ok),
  ) => {
    host.beginFrame();
    for (const value of sources) host.encodeFramebufferSnapshots(encoder, value);
    const receipt = { frameId: ++frameId, deviceGeneration: generation };
    host.onFrameSubmitted(completed, receipt);
    return receipt;
  };
  return {
    host,
    target: created.value,
    copies,
    encoder,
    sceneColor,
    source,
    frame,
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}

function failureReason(result: RenderResult<unknown, RenderError>): string | undefined {
  if (result.ok) return undefined;
  const { error } = result;
  if (error.code === 'framebuffer-snapshot-failed') return error.detail.reason;
  return error.code;
}

describe('Framebuffer region snapshot', () => {
  it('copies the requested region into the staged target and promotes it after completion', async () => {
    const f = await fixture();
    const ticket = f.host.requestFramebufferSnapshot(f.target, {
      region: { x: 10, y: 20, width: 32, height: 16 },
      destination: { x: 4, y: 8 },
    });
    if (!ticket.ok) throw ticket.error;
    const receipt = f.frame([f.source()]);
    expect(f.copies).toHaveLength(1);
    const [src, dst, size] = f.copies[0] ?? [];
    expect(src).toMatchObject({
      texture: f.sceneColor,
      mipLevel: 0,
      origin: { x: 10, y: 20, z: 0 },
    });
    expect(dst).toMatchObject({ mipLevel: 0, origin: { x: 4, y: 8, z: 0 } });
    expect(size).toEqual({ width: 32, height: 16, depthOrArrayLayers: 1 });
    const observed = await f.host.observeFramebufferSnapshots(receipt, [ticket.value]);
    if (!observed.ok) throw observed.error;
    expect(observed.value).toEqual([
      {
        ticket: ticket.value,
        frameId: receipt.frameId,
        deviceGeneration: 1,
        camera: undefined,
        region: { x: 10, y: 20, width: 32, height: 16 },
        destination: { x: 4, y: 8 },
        sourceExtent: { width: 128, height: 96 },
      },
    ]);
    f.host.beginFrame();
    expect(f.host.getPhysicalTarget(f.target)?.texture).toBe(dst?.texture);
    const again = await f.host.observeFramebufferSnapshots(receipt, [ticket.value]);
    expect(failureReason(again)).toBe('render-target-state-invalid');
  });

  it('validates request shape, target format and destination bounds before arming', async () => {
    const f = await fixture();
    const region = { x: 0, y: 0, width: 8, height: 8 };
    expect(
      failureReason(
        f.host.requestFramebufferSnapshot(f.target, { region: { ...region, width: 0 } }),
      ),
    ).toBe('request-invalid');
    expect(
      failureReason(f.host.requestFramebufferSnapshot(f.target, { region: { ...region, x: 1.5 } })),
    ).toBe('request-invalid');
    expect(
      failureReason(
        f.host.requestFramebufferSnapshot(f.target, { region, destination: { x: 60, y: 0 } }),
      ),
    ).toBe('destination-out-of-bounds');
    const ldr = f.host.createRenderTarget({ ...descriptor, format: 'rgba8unorm' });
    if (!ldr.ok) throw ldr.error;
    expect(failureReason(f.host.requestFramebufferSnapshot(ldr.value, { region }))).toBe(
      'target-incompatible',
    );
    const cube = f.host.createRenderTarget({ ...descriptor, shape: 'cube', width: 32 });
    if (!cube.ok) throw cube.error;
    expect(failureReason(f.host.requestFramebufferSnapshot(cube.value, { region }))).toBe(
      'target-incompatible',
    );
    expect(f.host.requestFramebufferSnapshot(f.target, { region }).ok).toBe(true);
    expect(failureReason(f.host.requestFramebufferSnapshot(f.target, { region }))).toBe(
      'writer-conflict',
    );
  });

  it('rejects a region outside the scene-color extent and records no copy', async () => {
    const f = await fixture();
    const ticket = f.host.requestFramebufferSnapshot(f.target, {
      region: { x: 120, y: 0, width: 16, height: 16 },
    });
    if (!ticket.ok) throw ticket.error;
    const receipt = f.frame([f.source()]);
    expect(f.copies).toHaveLength(0);
    expect(failureReason(await f.host.observeFramebufferSnapshots(receipt, [ticket.value]))).toBe(
      'source-out-of-bounds',
    );
  });

  it('fails with source-unavailable when the frame had no matching or HDR scene color', async () => {
    const f = await fixture();
    const region = { x: 0, y: 0, width: 8, height: 8 };
    const view = f.host.requestFramebufferSnapshot(f.target, { region, camera: 7 });
    if (!view.ok) throw view.error;
    const missing = f.frame([f.source(), f.source({ camera: 3, role: 'view' })]);
    expect(f.copies).toHaveLength(0);
    expect(failureReason(await f.host.observeFramebufferSnapshots(missing, [view.value]))).toBe(
      'source-unavailable',
    );
    const ldr = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!ldr.ok) throw ldr.error;
    const ldrReceipt = f.frame([f.source({ format: 'rgba8unorm' })]);
    expect(failureReason(await f.host.observeFramebufferSnapshots(ldrReceipt, [ldr.value]))).toBe(
      'source-unavailable',
    );
  });

  it('selects exactly one CameraView source by camera entity key', async () => {
    const f = await fixture();
    const ticket = f.host.requestFramebufferSnapshot(f.target, {
      region: { x: 0, y: 0, width: 8, height: 8 },
      camera: 7,
    });
    if (!ticket.ok) throw ticket.error;
    const other = Object.freeze({}) as Texture;
    const view = Object.freeze({}) as Texture;
    const receipt = f.frame([
      f.source({ texture: other }),
      f.source({ texture: other, camera: 3, role: 'view' }),
      f.source({ texture: view, camera: 7, role: 'view', width: 40, height: 30 }),
    ]);
    expect(f.copies.map(([src]) => src.texture)).toEqual([view]);
    const observed = await f.host.observeFramebufferSnapshots(receipt, [ticket.value]);
    if (!observed.ok) throw observed.error;
    expect(observed.value[0]).toMatchObject({ camera: 7, sourceExtent: { width: 40, height: 30 } });
  });

  it('refuses a snapshot into a target a camera or capture writes in the same frame', async () => {
    const f = await fixture();
    const ticket = f.host.requestFramebufferSnapshot(f.target, {
      region: { x: 0, y: 0, width: 8, height: 8 },
    });
    if (!ticket.ok) throw ticket.error;
    f.host.beginFrame();
    expect(f.host.getPhysicalTarget(f.target)).toBeDefined();
    f.host.encodeFramebufferSnapshots(f.encoder, f.source());
    const receipt = { frameId: 99, deviceGeneration: 1 };
    f.host.onFrameSubmitted(Promise.resolve(ok), receipt);
    expect(f.copies).toHaveLength(0);
    expect(failureReason(await f.host.observeFramebufferSnapshots(receipt, [ticket.value]))).toBe(
      'writer-conflict',
    );
  });

  it('re-arms an encoded copy whose frame produced no receipt', async () => {
    const f = await fixture();
    const ticket = f.host.requestFramebufferSnapshot(f.target, {
      region: { x: 0, y: 0, width: 8, height: 8 },
    });
    if (!ticket.ok) throw ticket.error;
    f.host.beginFrame();
    f.host.encodeFramebufferSnapshots(f.encoder, f.source());
    f.host.onFrameSubmitted(Promise.resolve(ok));
    const receipt = f.frame([f.source()]);
    expect(f.copies).toHaveLength(2);
    expect((await f.host.observeFramebufferSnapshots(receipt, [ticket.value])).ok).toBe(true);
  });

  it('invalidates an observed snapshot whose physical a resize replaced', async () => {
    const f = await fixture();
    const region = { x: 0, y: 0, width: 8, height: 8 };
    const warm = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!warm.ok) throw warm.error;
    const warmReceipt = f.frame([f.source()]);
    expect((await f.host.observeFramebufferSnapshots(warmReceipt, [warm.value])).ok).toBe(true);

    let finish!: (value: RenderResult<void, RenderError>) => void;
    const completed = new Promise<RenderResult<void, RenderError>>((resolve) => {
      finish = resolve;
    });
    const first = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!first.ok) throw first.error;
    const firstReceipt = f.frame([f.source()], completed);
    expect(f.host.resizeRenderTarget(f.target, { ...descriptor, width: 16 }).ok).toBe(true);
    expect(
      failureReason(
        f.host.requestFramebufferSnapshot(f.target, { region, destination: { x: 12, y: 0 } }),
      ),
    ).toBe('destination-out-of-bounds');
    const second = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!second.ok) throw second.error;
    const secondReceipt = f.frame([f.source()], completed);
    expect(f.copies[2]?.[1].texture).not.toBe(f.copies[1]?.[1].texture);
    finish(ok);
    expect(
      failureReason(await f.host.observeFramebufferSnapshots(firstReceipt, [first.value])),
    ).toBe('destination-invalidated');
    expect((await f.host.observeFramebufferSnapshots(secondReceipt, [second.value])).ok).toBe(true);
  });

  it('fences device recovery and destroyed targets', async () => {
    const f = await fixture();
    const region = { x: 0, y: 0, width: 8, height: 8 };
    const stale = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!stale.ok) throw stale.error;
    f.setGeneration(2);
    const receipt = f.frame([f.source()]);
    expect(f.copies).toHaveLength(0);
    expect(failureReason(await f.host.observeFramebufferSnapshots(receipt, [stale.value]))).toBe(
      'render-target-state-invalid',
    );
    const pending = f.host.requestFramebufferSnapshot(f.target, { region });
    if (!pending.ok) throw pending.error;
    expect(f.host.destroyRenderTarget(f.target).ok).toBe(true);
    const after = f.frame([f.source()]);
    expect(f.copies).toHaveLength(0);
    expect(failureReason(await f.host.observeFramebufferSnapshots(after, [pending.value]))).toBe(
      'render-target-state-invalid',
    );
    expect(failureReason(f.host.requestFramebufferSnapshot(f.target, { region }))).toBe(
      'render-target-state-invalid',
    );
  });
});
