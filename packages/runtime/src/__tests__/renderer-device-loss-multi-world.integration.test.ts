import { World } from '@forgeax/engine-ecs';
import type { Renderer, RenderWorldLease } from '@forgeax/engine-render';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';

function canvas(): HTMLCanvasElement {
  return { width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

function request(
  leases: readonly RenderWorldLease[],
  camera: RenderWorldLease,
  environment: RenderWorldLease,
) {
  return { leases, camera: { lease: camera }, environment: { lease: environment } };
}

describe('M4 / m4_t3 — multi-World recovery keeps logical identities', () => {
  it('retains World and lease identities when world order changes across recovery', async () => {
    const adapter = new RhiNullAdapter();
    const firstDevice = (await adapter.requestDevice()).unwrap();
    const replacementDevice = (await adapter.requestDevice()).unwrap();
    let rejectLoss!: (reason: unknown) => void;
    const lost = new Promise<never>((_, reject) => {
      rejectLoss = reject;
    });
    const lostProxy = new Proxy(firstDevice, {
      get(target, property) {
        if (property === 'lost') return lost;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let requestCount = 0;
    const recoverableRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => {
            requestCount += 1;
            return ok(requestCount === 1 ? lostProxy : replacementDevice);
          },
        } as never),
    } as never;
    const host = await constructRendererHost(
      canvas(),
      { rhi: recoverableRhi },
      { shaderManifestUrl: manifest },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const renderer: Renderer = host.value.renderer;
    const firstWorld = new World();
    const secondWorld = new World();
    const firstLease = renderer.attach(firstWorld);
    const secondLease = renderer.attach(secondWorld);
    expect(firstLease.ok).toBe(true);
    expect(secondLease.ok).toBe(true);
    if (!firstLease.ok || !secondLease.ok) return;

    expect(firstWorld.identity).not.toBe(secondWorld.identity);
    const before = {
      firstWorld: firstWorld.identity,
      secondWorld: secondWorld.identity,
      firstLease: firstLease.value,
      secondLease: secondLease.value,
    };
    expect(
      renderer.draw(
        request([firstLease.value, secondLease.value], firstLease.value, secondLease.value),
      ).ok,
    ).toBe(true);
    expect(
      renderer.draw(
        request([secondLease.value, firstLease.value], secondLease.value, firstLease.value),
      ).ok,
    ).toBe(true);
    const beforeScene = renderer.inspect().renderScene;
    rejectLoss({ reason: 'unknown', message: 'forced multi-world device loss' });
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    expect(recovered.ok).toBe(true);
    expect(firstWorld.identity).toBe(before.firstWorld);
    expect(secondWorld.identity).toBe(before.secondWorld);
    expect(firstLease.value).toBe(before.firstLease);
    expect(secondLease.value).toBe(before.secondLease);
    expect(
      renderer.draw(
        request([secondLease.value, firstLease.value], secondLease.value, firstLease.value),
      ).ok,
    ).toBe(true);
    expect(renderer.inspect().renderScene.projectionRecords).toBe(beforeScene.projectionRecords);
    renderer.dispose();
  });
});
