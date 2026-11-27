import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CURVED_SHADOW_SIZE,
  createCurvedShadowReceiverFixture,
} from './curved-shadow-receiver.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';

const target = offscreenCanvas(CURVED_SHADOW_SIZE);
let fixture: Awaited<ReturnType<typeof createCurvedShadowReceiverFixture>>;

beforeAll(async () => {
  const manifest = shaderPublicationUrl(
    await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
  );
  fixture = await createCurvedShadowReceiverFixture(target.canvas, manifest, {
    sourceHead: 'fixture:projected-deferred-shadow',
    sourceTree: 'fixture:projected-deferred-shadow',
    lockSha256: 'fixture:projected-deferred-shadow',
    buildSha256: 'fixture:projected-deferred-shadow',
  });
}, 120_000);

afterAll(async () => {
  await fixture?.dispose();
  target.destroy();
});

it.each([
  'wave',
  'fold',
] as const)('keeps an exposed %s free from false occlusion with the projected Deferred receiver', async (kind) => {
  await fixture.verify({ kind, mapSize: 512, filter: 6, renderPath: 'deferred', projected: true });
}, 60_000);

it('keeps normal-mapped lighting and shadow coverage while applying the legacy Default Lit quantizers', async () => {
  const scene = {
    kind: 'fold',
    mapSize: 512,
    filter: 6,
    renderPath: 'deferred',
    projected: true,
    blocker: true,
    normalMappedGrazing: true,
  } as const;
  const full = await fixture.verify(scene);
  const compact = await fixture.verify({ ...scene, compact: true });
  expect(full.layout).toBeUndefined();
  expect(compact.layout).toBe('standard-gbuffer/4');
  expect(compact.channels).toBe(false);
  expect(Buffer.compare(full.offBytes, compact.offBytes)).not.toBe(0);
  for (const [baseline, candidate] of [
    [full.off, compact.off],
    [full.on, compact.on],
  ] as const) {
    let maxDelta = 0;
    for (const [i, value] of baseline.entries())
      maxDelta = Math.max(maxDelta, Math.abs(value - (candidate[i] ?? NaN)));
    expect(maxDelta).toBeLessThan(0.02);
  }
  const shadowed = full.off.filter(
    (unshadowed, i) => unshadowed > 0.01 && (full.on[i] ?? 0) < 0.5 * unshadowed,
  );
  expect(shadowed.length).toBeGreaterThan(64);
  expect(full.activeAllocation).toBeDefined();
  expect(compact.activeAllocation?.unknownByteSizeCount).toBe(
    full.activeAllocation?.unknownByteSizeCount,
  );
  expect((full.activeAllocation?.liveBytes ?? 0) - (compact.activeAllocation?.liveBytes ?? 0)).toBe(
    12 * CURVED_SHADOW_SIZE * CURVED_SHADOW_SIZE,
  );
}, 60_000);

it('retains the contact shadow of a rasterized caster on the exposed fold', async () => {
  const scene = {
    kind: 'fold',
    mapSize: 512,
    filter: 6,
    renderPath: 'deferred',
    blocker: true,
  } as const;
  const baseline = await fixture.verify(scene);
  const projected = await fixture.verify({ ...scene, projected: true });
  let baselineCore = 0;
  let projectedCore = 0;
  let changed = 0;
  for (let i = 0; i < baseline.off.length; i++) {
    const unshadowed = baseline.off[i] ?? 0;
    const reference = baseline.on[i] ?? 0;
    const candidate = projected.on[i] ?? 0;
    if (Math.abs(reference - candidate) > 0.005) changed++;
    if (unshadowed <= 0.01 || reference > 0.2 * unshadowed) continue;
    baselineCore++;
    if (candidate <= 0.3 * unshadowed) projectedCore++;
  }
  const summary = JSON.stringify({ baselineCore, projectedCore, changed });
  expect(baselineCore, summary).toBeGreaterThan(64);
  expect(projectedCore / baselineCore, summary).toBeGreaterThan(0.7);
  // A separate renderer PSO that falls back to the old receiver everywhere
  // would produce the same pixels. Require a visible transition difference.
  expect(changed, summary).toBeGreaterThan(8);
}, 60_000);

it.each([
  'three',
  'four',
] as const)('preserves the complete view lighting with %s explicit channels', async (mixedChannels) => {
  const scene = {
    kind: 'fold',
    mapSize: 512,
    filter: 6,
    renderPath: 'deferred',
    mixedChannels,
  } as const;
  const original = await fixture.verify(scene);
  const projected = await fixture.verify({ ...scene, projected: true });
  const compact = await fixture.verify({ ...scene, projected: true, compact: true });
  let maxDelta = 0;
  for (const [index, value] of original.off.entries()) {
    maxDelta = Math.max(maxDelta, Math.abs(value - (projected.off[index] ?? 0)));
  }
  expect(original.layout).toBeUndefined();
  expect(projected.layout).toBeUndefined();
  expect(compact.layout).toBe('standard-gbuffer/4');
  expect(compact.channels).toBe(true);
  expect(original.metrics.samples).toBeGreaterThan(10000);
  expect(maxDelta).toBe(0);
  let compactDelta = 0;
  for (const [index, value] of original.off.entries())
    compactDelta = Math.max(compactDelta, Math.abs(value - (compact.off[index] ?? NaN)));
  expect(compactDelta).toBeLessThan(0.02);
  if (mixedChannels === 'three') {
    expect(compact.layoutTransitions.map(({ layout, channels }) => ({ layout, channels }))).toEqual(
      [
        { layout: 'standard-gbuffer/4', channels: false },
        { layout: 'standard-gbuffer/4', channels: true },
      ],
    );
    expect(compact.layoutTransitions[0]?.image.some((value, i) => value !== compact.off[i])).toBe(
      true,
    );
    expect(compact.layoutTransitions[1]?.image.every((value, i) => value === compact.off[i])).toBe(
      true,
    );
  }
}, 60_000);

it('rejects a colored dielectric in the configured legacy layout', async () => {
  const scene = {
    kind: 'fold',
    mapSize: 512,
    filter: 6,
    renderPath: 'deferred',
    coloredSpecular: true,
  } as const;
  expect((await fixture.verify(scene)).layout).toBeUndefined();
  await expect(fixture.verify({ ...scene, compact: true, projected: true })).rejects.toMatchObject({
    detail: {
      cause: {
        code: 'rhi-descriptor-invalid',
        expected: 'a view supported by the Default GBuffer format',
      },
    },
  });
}, 60_000);

it('executes SSR against the fixed Default GBuffer', async () => {
  const compact = await fixture.verify({
    kind: 'fold',
    mapSize: 512,
    filter: 6,
    renderPath: 'deferred',
    compact: true,
    projected: true,
    ssr: true,
    mixedChannels: 'three',
  });
  expect(compact.layout).toBe('standard-gbuffer/4');
  expect(compact.channels).toBe(true);
  expect(
    compact.ssr?.status,
    JSON.stringify(compact.ssr?.failure ?? compact.ssrDependencies?.failure),
  ).toBe('admitted');
  expect(compact.ssr?.passRoster).toEqual(expect.arrayContaining(['ssr-trace', 'ssr-compose']));
}, 60_000);
