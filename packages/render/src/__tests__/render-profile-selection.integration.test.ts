import { World } from '@forgeax/engine-ecs';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, Camera } from '../components/camera';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

describe('automatic Standard path at the Renderer boundary', () => {
  it.each([
    true,
    false,
  ])('resolves initial and changed author intent with storage=%s', async (storageBuffer) => {
    const adapter = new RhiNullAdapter();
    const device = (await adapter.requestDevice()).unwrap();
    const caps = { ...device.caps, storageBuffer };
    Object.defineProperty(device, 'caps', { value: caps });
    const backend = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(device),
        }),
    };
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: backend, standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'auto' } },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const path = storageBuffer ? 'deferred' : 'forward';
      expect(renderer.inspect().profile.renderPath).toBe(path);
      const world = new World();
      registerPropagateTransforms(world);
      const camera = world
        .spawn({ component: Transform, data: {} }, { component: Camera, data: { fov: 1 } })
        .unwrap();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;
      const lease = attached.value;
      for (const antialias of [ANTIALIAS_NONE, ANTIALIAS_TAA, ANTIALIAS_NONE]) {
        world.set(camera, Camera, { antialias }).unwrap();
        world.update().unwrap();
        const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw drawn.error;
        const frame = drawn.value;
        expect(frame).toBeDefined();
        if (frame !== undefined) expect((await frame.completed).ok).toBe(true);
        expect(renderer.inspect().profile.renderPath).toBe(path);
      }
      expect(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' }).ok).toBe(
        true,
      );
      expect(renderer.inspect().profile.renderPath).toBe('forward');
      expect(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'auto' }).ok).toBe(
        true,
      );
      expect(renderer.inspect().profile.renderPath).toBe(path);
    } finally {
      await renderer.dispose();
    }
  });
  it('resolves retained auto intent for a replacement device before publication', async () => {
    const adapter = new RhiNullAdapter();
    const first = (await adapter.requestDevice()).unwrap();
    const replacement = (await adapter.requestDevice()).unwrap();
    // Keep storage support for ordinary core recovery; remove Deferred MRT admission.
    Object.defineProperty(replacement, 'caps', {
      value: { ...replacement.caps, maxColorAttachments: 4 },
    });
    let lose: (value: { reason: 'unknown'; message: string }) => void = () => {};
    Object.defineProperty(first, 'lost', {
      value: new Promise((resolve) => {
        lose = resolve;
      }),
    });
    let requests = 0;
    const backend = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(requests++ === 0 ? first : replacement),
        }),
    };
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: backend, standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'auto' } },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(renderer.inspect().profile.renderPath).toBe('deferred');
      lose({ reason: 'unknown', message: 'automatic path recovery regression' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.inspect().state).toBe('device-lost');
      const recovered = await renderer.recover();
      expect(recovered.ok, recovered.ok ? '' : JSON.stringify(recovered.error)).toBe(true);
      expect(renderer.inspect().profile.renderPath).toBe('forward');
    } finally {
      await renderer.dispose();
    }
  });
});
