import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it, vi } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import {
  bakeIrradianceVolume,
  createIrradianceVolumeCooker,
  type IrradianceBakeInput,
  irradianceBakeFingerprint,
} from '../../raytracing/irradiance-bake';
import {
  IRRADIANCE_OCT_DIRECTIONS,
  IRRADIANCE_VOLUME_KIND,
} from '../../raytracing/irradiance-volume';
import { prepareRayPathFixture } from './path-tracer.commands';
import { plane } from './path-tracer.fixture';

const GUID = '6a1d7c3e-2b4f-4d8a-9e0c-5f3a1b7d9c24';

/** Index of the octahedral texel whose direction is closest to `z`. */
const texelToward = (z: 1 | -1) => {
  let best = 0;
  for (let t = 0; t < 64; t++)
    if (
      (IRRADIANCE_OCT_DIRECTIONS[t * 3 + 2] ?? 0) * z >
      (IRRADIANCE_OCT_DIRECTIONS[best * 3 + 2] ?? 0) * z
    )
      best = t;
  return best;
};

/**
 * A matte plane at z = 0 under a unit sky, probes at z = +1 and z = -1. The
 * upper probe sees sky above and the plane's albedo below (D = L for a constant
 * hemisphere); the lower probe sees half its rays strike the plane's back and
 * must be marked invalid. Two bakes of the same input are byte-identical, and
 * the NativeCooker publishes under the caller's GUID on every rebake while a
 * failed rebake keeps the last-known-good volume.
 */
it('bakes the reference integrator into deterministic, cooked irradiance probes', {
  timeout: 300_000,
}, async () => {
  const fixture = await prepareRayPathFixture();
  const matte = fixture.materials.find((m) => m.name === 'matte');
  assert(matte);
  const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  // The Dawn setup owns native device teardown; RHI devices expose no destroy method.
  const input: IrradianceBakeInput = {
    kernel: fixture.kernel,
    scene: buildRaySurfaceScene([plane()]).unwrap(),
    materials: [{ id: 0, ...matte }],
    lights: [],
    lattice: { origin: [0, 0, -1], spacing: 2, dimensions: [1, 1, 2] },
    settings: {
      raysPerProbe: 256,
      samples: process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 8 : 32,
      maxBounces: 2,
      seed: 11,
      environment: [1, 1, 1],
      maxDistance: 100,
    },
  };
  const submissions = vi.spyOn(device.queue, 'submit');
  const first = (await bakeIrradianceVolume(device, gpu.createShaderModule, input)).unwrap();
  // Every requested sample completes in its own submission before readback.
  // This keeps full deep MASK bakes out of a device-losing multi-sample command.
  expect(submissions.mock.calls.length).toBeGreaterThanOrEqual(input.settings.samples);
  submissions.mockRestore();
  const second = (await bakeIrradianceVolume(device, gpu.createShaderModule, input)).unwrap();
  expect(second.bytes).toEqual(first.bytes);
  expect(second.digest).toBe(first.digest);
  expect(first.fingerprint).toBe(irradianceBakeFingerprint(input));
  expect(first.rays).toBe(512);
  expect(first.batches).toBe(1);

  const { irradiance, moments, meta } = first.volume;
  const down = texelToward(-1);
  const up = texelToward(1);
  const upper = 64 * 4;
  const albedo = [0.8, 0.4, 0.2];
  for (let c = 0; c < 3; c++) {
    expect(irradiance[upper + down * 4 + c]).toBeCloseTo((albedo[c] ?? 0) * 0.987 + 0.013, 1);
    expect(Math.abs((irradiance[upper + down * 4 + c] ?? 0) - (albedo[c] ?? 0))).toBeLessThan(0.05);
    expect(irradiance[upper + up * 4 + c]).toBeGreaterThan(0.95);
  }
  // Hits along -z land one unit away; sky rays clamp at twice the spacing.
  expect(moments[64 * 2 + down * 2]).toBeGreaterThan(0.95);
  expect(moments[64 * 2 + down * 2]).toBeLessThan(1.2);
  expect(moments[64 * 2 + up * 2]).toBeCloseTo(4, 3);
  expect([...meta.subarray(4, 8)]).toEqual([1, 1, 0, 256]);
  // The lower probe sees the plane's back: invalid, so the sampler skips it.
  expect(meta[1]).toBe(0);
  expect(meta[2]).toBeGreaterThan(64);

  const registry = new NativeCookerRegistry();
  registry.register(createIrradianceVolumeCooker());
  const cookInput = { ...input, guid: GUID, device, compile: gpu.createShaderModule };
  const product = (await registry.run(IRRADIANCE_VOLUME_KIND, cookInput)).unwrap();
  expect(product.guid).toBe(GUID);
  expect(product.receipt.inputFingerprint).toBe(first.fingerprint);
  expect(product.payload).toEqual({
    artifact: 'volume',
    digest: first.digest,
    dimensions: [1, 1, 2],
  });
  expect(product.artifacts.volume?.byteLength).toBe(first.bytes.byteLength);

  const committed = (
    await registry.runTransaction({ key: IRRADIANCE_VOLUME_KIND, input: cookInput })
  ).unwrap();
  expect(committed.status).toBe('committed');
  const rebaked = (
    await registry.runTransaction({
      key: IRRADIANCE_VOLUME_KIND,
      input: { ...cookInput, settings: { ...input.settings, seed: 12 } },
      previous: committed,
    })
  ).unwrap();
  expect(rebaked.status).toBe('committed');
  expect(rebaked.generation).toBe(2);
  expect(rebaked.draft.guid).toBe(GUID);
  expect(rebaked.draft.inputFingerprint).not.toBe(committed.draft.inputFingerprint);
  const failed = (
    await registry.runTransaction({
      key: IRRADIANCE_VOLUME_KIND,
      input: { ...cookInput, settings: { ...input.settings, raysPerProbe: 1 } },
      previous: rebaked,
    })
  ).unwrap();
  expect(failed.status).toBe('recovered');
  expect(failed.lastKnownGood).toBe(rebaked.draft);
  const invalid = await bakeIrradianceVolume(device, gpu.createShaderModule, {
    ...input,
    settings: { ...input.settings, raysPerProbe: 1 },
  });
  expect(!invalid.ok && invalid.error.code).toBe('irradiance-volume-invalid-rays');
});
