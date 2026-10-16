import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import type { SsrAdmissionIdentity } from '../ssr/identity';

const identity: SsrAdmissionIdentity = {
  sourceHead: 'head',
  sourceTree: 'tree',
  lockSha256: 'lock',
  buildSha256: 'build',
};

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
}

describe('SSR format-probe gating', () => {
  it.each([
    false,
    true,
  ])('prepares only explicitly configured SSR before initialization completes (%s)', async (configured) => {
    const adapter = new RhiNullAdapter();
    const deviceResult = await adapter.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;
    let probeCalls = 0;
    let markProbeStarted = () => {};
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let releaseProbe = () => {};
    const probeBarrier = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probe = device.probeTextureFormatCapability.bind(device);
    (
      device as RhiDevice & {
        probeTextureFormatCapability: RhiDevice['probeTextureFormatCapability'];
      }
    ).probeTextureFormatCapability = async () => {
      probeCalls += 1;
      markProbeStarted();
      await probeBarrier;
      return probe();
    };
    const observedRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(device),
        }),
    };
    let initialized = false;
    const initialization = createRenderer(
      { getContext: () => null },
      { rhi: observedRhi, ...(configured ? { ssrIdentity: identity } : {}) },
      { shaderManifestUrl: manifestUrl() },
    ).then(async (renderer) => {
      expect((await renderer.initialization).ok).toBe(true);
      initialized = true;
      return renderer;
    });
    if (configured) {
      await probeStarted;
      expect(initialized).toBe(false);
      releaseProbe();
    }
    const renderer = await initialization;

    expect(probeCalls).toBe(configured ? 1 : 0);
    // Inspection neither starts a second probe nor allocates frame work.
    renderer.inspect();
    renderer.inspect();
    expect(probeCalls).toBe(configured ? 1 : 0);
    expect(renderer.inspect().ssrDependencies.work.temporalDemand).toBe(0);
    await renderer.dispose();
  });
});
