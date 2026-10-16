import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { PlanarCaptureState } from '../capture/planar-state';
import { Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { PlanarReflection } from '../components/planar-reflection';
import type { CameraSnapshot } from '../render-contract';
import { projectAuxiliaryCamerasForView, selectCameraRoles } from '../render-system-extract';
import { createRenderTargetOwner } from '../targets/owner';

const descriptor = {
  shape: '2d',
  width: 32,
  height: 32,
  format: 'rgba8unorm',
  sampleCount: 1,
  mipLevels: 1,
  sampled: true,
  readback: true,
} as const;

describe('planar output ownership', () => {
  it('writes the exact public target physical used by material sampling and readback', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const created = host.createRenderTarget(descriptor);
    if (!created.ok) throw created.error;
    const target = created.value;
    host.beginFrame();
    const physical = host.getPhysicalTarget(target);
    if (physical === undefined) throw new Error('Missing target allocation');
    const state = new PlanarCaptureState();
    const capture = state.prepare(
      {
        target,
        planarReflection: { updateIntervalFrames: 1, requestVersion: 0 },
      } as CameraSnapshot,
      physical,
      0,
    );
    expect(capture?.physical).toBe(physical);
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    const source = host.createRenderTargetTextureSource(target, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
    });
    if (!source.ok) throw source.error;
    expect(host.resolveRenderTargetTextureSource(source.value)?.textureView).toBe(
      capture?.physical.mipViews[0],
    );
    const ticket = host.requestTargetReadback(target, { mipLevel: 0 });
    if (!ticket.ok) throw ticket.error;
    const encoder = device.createCommandEncoder().unwrap();
    const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
    host.encodePendingReadbacks(encoder);
    expect(copy.mock.calls[0]?.[0].texture).toBe(
      capture?.physical.resolveTexture ?? capture?.physical.texture,
    );
    state.dispose();
    expect(host.getPhysicalTarget(target)).toBe(physical);
    host.dispose();
  });

  it('retains the completed public image while a resized low-frequency view has not submitted', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const created = host.createRenderTarget(descriptor);
    if (!created.ok) throw created.error;
    const target = created.value;
    host.beginFrame();
    const original = host.getPhysicalTarget(target);
    if (original === undefined) throw new Error('Missing original target');
    const state = new PlanarCaptureState();
    const camera = {
      target,
      planarReflection: { updateIntervalFrames: 1000, requestVersion: 0 },
    } as CameraSnapshot;
    const first = state.prepare(camera, original, 0);
    state.submit(true, Promise.resolve());
    host.markTargetSubmitted(target, original);
    host.onFrameSubmitted();
    await Promise.resolve();
    const source = host.createRenderTargetTextureSource(target, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
    });
    if (!source.ok) throw source.error;
    const destroy = vi.spyOn(device, 'destroyTexture');
    const resized = host.resizeRenderTarget(target, { ...descriptor, width: 64 });
    if (!resized.ok) throw resized.error;
    host.beginFrame();
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(source.value)?.textureView).toBe(
      original.mipViews[0],
    );
    expect(state.current()).toBe(first);
    expect(destroy).not.toHaveBeenCalledWith(original.texture);
    const ticket = host.requestTargetReadback(target, { mipLevel: 0 });
    if (!ticket.ok) throw ticket.error;
    const encoder = device.createCommandEncoder().unwrap();
    host.encodePendingReadbacks(encoder);
    host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const), {
      frameId: 1,
      deviceGeneration: 0,
    });
    await Promise.resolve();
    const readback = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [
      ticket.value,
    ]);
    expect(readback.ok).toBe(true);
    if (readback.ok) expect(readback.value[0]?.byteLength).toBe(256 * descriptor.height);
    const replacement = host.getPhysicalTarget(target);
    if (replacement === undefined) throw new Error('Missing candidate target');
    expect(replacement).not.toBe(original);
    state.prepare(camera, replacement, 1);
    state.submit(false, undefined);
    expect(state.current()).toBe(first);
    expect(host.resolveRenderTargetTextureSource(source.value)?.textureView).toBe(
      original.mipViews[0],
    );
    const next = state.prepare(camera, replacement, 2);
    expect(next?.physical).toBe(replacement);
    state.submit(true, Promise.resolve());
    host.markTargetSubmitted(target, replacement);
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(source.value)?.textureView).toBe(
      replacement.mipViews[0],
    );
    expect(state.current()).toBe(next);
    expect(destroy).toHaveBeenCalledWith(original.texture);
    state.dispose();
    host.dispose();
  });

  it('retains every view reflection for publication and projects only its owning camera', () => {
    const world = new World();
    const owner = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 });
    const views = [0, 5].map((x) => {
      const created = owner.create(descriptor);
      if (!created.ok) throw created.error;
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [x, 3, 5] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
          { component: CameraView, data: {} },
          {
            component: PlanarReflection,
            data: { target: world.allocSharedRef('RenderTarget', created.value) },
          },
        )
        .unwrap();
      return { entity, target: created.value };
    });
    propagateTransforms(world).unwrap();
    const roles = selectCameraRoles(world);
    expect(roles.display).toHaveLength(2);
    expect(roles.auxiliary).toHaveLength(2);
    for (const view of views) {
      const display = roles.display.find((camera) => camera.entityKey === Number(view.entity));
      const projected = projectAuxiliaryCamerasForView(display, roles.auxiliary);
      expect(projected).toHaveLength(1);
      expect(projected[0]?.target).toBe(view.target);
      expect(projected[0]?.entityKey).toBe(Number(view.entity));
      expect(projected[0]?.position[1]).toBe(-3);
    }
  });

  it('rejects a reflection target shared with another camera output before view selection', () => {
    const world = new World();
    const owner = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 });
    const created = owner.create(descriptor);
    if (!created.ok) throw created.error;
    const target = world.allocSharedRef('RenderTarget', created.value);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 3, 5] } },
        { component: Camera, data: { target } },
        { component: CameraView, data: {} },
        { component: PlanarReflection, data: { target } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    expect(() => selectCameraRoles(world)).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'target-writer' },
      }),
    );
  });
});
