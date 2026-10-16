// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w20 —
// lazy equirect-to-cubemap projection state machine + multi-Skylight/Skybox
// once-warn unit tests (plan-strategy §5.3 key test points (2)/(3)/(5) +
// §3.2 sequence-diagram alt branches; requirements AC-05 / AC-06 / AC-09).
//
// Covers the full driveLazyEquirectProjection state machine (the single
// per-frame trigger added in w18):
//   - caps insufficient (rgba16floatRenderable=false) -> project through the
//     renderable rgba8 precompute output (the WebKit path)
//   - first sight (status undefined) + caps OK -> fire-and-forget launch; the
//     store records status:'pending' synchronously, then 'ready' after the
//     IBL queue completion fence
//   - pending -> a re-entry while in flight does NOT relaunch (store dedup,
//     idempotent per source; D-4)
//   - failed -> EquirectProjectionFailedError fired EXACTLY ONCE per handle;
//     the store never retries (R-2 / AC-09)
//   - handle 0 -> solid-color ambient; trigger is never invoked (guarded by
//     recordFrame)
//
// Plus the multi-Skylight / multi-SkyboxBackground once-warn (w19): the warn
// fires once, names the winning entity handle, and does NOT flood per frame.

import type { World as WorldType } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { type RhiCaps, RhiError } from '@forgeax/engine-rhi';
import type { EquirectAsset, Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { RhiErrorListenerRegistry } from '../../../render/src/lifecycle';
import {
  driveLazyEquirectProjection,
  selectLazyEquirectHandle,
  warnMultiSkybox,
  warnMultiSkylight,
} from '../../../render/src/record/helpers';

// ── caps probes ──────────────────────────────────────────────────────────────

const capsRenderable: RhiCaps = {
  backendKind: 'webgpu',
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
} as unknown as RhiCaps;

const capsNotRenderable: RhiCaps = {
  ...capsRenderable,
  rgba16floatRenderable: false,
} as unknown as RhiCaps;

// ── mock GPU device: createTexture / view / queue succeed so the upload runs to
// a 'ready' entry after the submission fence; a counter tracks texture creation
// so the "no relaunch while pending" assertion can prove a second drive does
// not mint a second texture. ──

interface DeviceProbe {
  textures: number;
}

const okShim = <T>(v: T) => ({ ok: true as const, value: v });

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeReadyDevice(probe: DeviceProbe): any {
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createCommandEncoder: () =>
      okShim({
        __mock: 'encoder',
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          draw: () => undefined,
          end: () => undefined,
        }),
        finish: () => okShim({ __mock: 'command-buffer' }),
      }),
    createBuffer: (desc: { size?: number }) => okShim({ __mock: 'buffer', size: desc.size ?? 0 }),
    createTexture: () => {
      probe.textures += 1;
      return okShim({
        __mock: `texture-${probe.textures}`,
        createView: () => ({ __mock: 'view' }),
      });
    },
    createTextureView: () => okShim({ __mock: 'view' }),
    queue: {
      writeTexture: () => okShim(undefined),
      writeBuffer: () => okShim(undefined),
      submit: () => okShim(undefined),
      onSubmittedWorkDone: async () => undefined,
    },
  };
}

// A device whose createTexture fails -> upload fail-fast -> status:'failed'.
const deviceFailure = new RhiError({
  code: 'device-lost',
  expected: 'a live device',
  hint: 'test double: every allocation fails',
});

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeFailingDevice(): any {
  return {
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createTexture: () => ({ ok: false as const, error: deviceFailure }),
    createTextureView: () => ({ ok: false as const, error: deviceFailure }),
    queue: {
      writeTexture: () => okShim(undefined),
      writeBuffer: () => okShim(undefined),
      submit: () => okShim(undefined),
    },
  };
}

function equirectPod(width = 4, height = 2): EquirectAsset {
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba16float',
    data: new Uint8Array(width * height * 8),
    colorSpace: 'linear',
  };
}

// Build a store wired to a device (no shader factory -> the optional async IBL
// precompute render-pass block is skipped). The cube-projection entry remains
// pending until the IBL queue completion fence resolves; the white-vs-real-IBL
// binding decision is made by recordMainPass off the global cache views (out of
// scope for this unit test, covered by the dawn IBL readback test). This unit
// test asserts the lazy trigger's launch / dedup / caps-gate /
// fail-once-and-no-retry bookkeeping.
function configuredStore(device: unknown, caps: RhiCaps): GpuResidencyCache {
  const store = new GpuResidencyCache();
  let next = 9000;
  store.configureGpuDevice(
    // biome-ignore lint/suspicious/noExplicitAny: mock device satisfies MipmapBlitDevice structurally
    device as any,
    undefined,
    (() => okShim(toShared<'EquirectAsset'>(next++))) as never,
    caps,
  );
  store.configureIblDevice(
    device as import('@forgeax/engine-rhi').RhiDevice,
    async (_device, desc) => okShim({ __mock: 'shader', label: desc.label ?? '' }) as never,
  );
  store.bindDeviceScope(DeviceScope.create(0, 'skylight-lazy-test'));
  return store;
}

// Minimal RenderSystemInternals surface driveLazyEquirectProjection touches:
// gpuStore, errorRegistry, device.caps. Everything else is unused by the arm.
function makeInternals(
  store: GpuResidencyCache,
  errorRegistry: RhiErrorListenerRegistry,
  caps: RhiCaps,
) {
  return {
    gpuStore: store,
    errorRegistry,
    device: { caps },
    // biome-ignore lint/suspicious/noExplicitAny: narrow stub for the lazy-projection arm
  } as any;
}

function makeFrameState() {
  return { firedEquirectProjectionFailedHandles: new Set<number>() };
}

async function flushProjection(
  store: GpuResidencyCache,
  handle: Handle<'EquirectAsset', 'shared'>,
): Promise<void> {
  // Precompute yields through the event loop between bounded submission
  // batches, then publishes after the final queue-completion fence.
  await vi.waitFor(() => expect(store.getCubemapStatus(handle)).toBe('ready'), {
    timeout: 5_000,
  });
}

// Catalogue an equirect POD into the world's user-tier shared-ref store so
// resolveAssetHandle<EquirectAsset>(world, handle) returns it (record path).
function catalogEquirect(world: WorldType, pod: EquirectAsset): Handle<'EquirectAsset', 'shared'> {
  return world.allocSharedRef('EquirectAsset', pod);
}

describe('driveLazyEquirectProjection — lazy projection state machine (M3 / w20)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caps insufficient (rgba16floatRenderable=false) -> projects through rgba8 output', async () => {
    const probe: DeviceProbe = { textures: 0 };
    const store = configuredStore(makeReadyDevice(probe), capsNotRenderable);
    const world = new World();
    const handle = catalogEquirect(world, equirectPod());
    const reg = new RhiErrorListenerRegistry();
    const seen: string[] = [];
    reg.add((e) => seen.push(e.code));
    const frameState = makeFrameState();

    driveLazyEquirectProjection(
      makeInternals(store, reg, capsNotRenderable),
      world,
      frameState,
      handle as unknown as number,
    );

    expect(store.getCubemapStatus(handle)).toBe('pending');
    await flushProjection(store, handle);
    expect(probe.textures).toBeGreaterThan(0);
    expect(store.getCubemapStatus(handle)).toBe('ready');
    expect(seen).toEqual([]);
  });

  it('first sight + caps OK -> fire-and-forget launch projects the equirect (pending then ready) (AC-05)', async () => {
    const probe: DeviceProbe = { textures: 0 };
    const store = configuredStore(makeReadyDevice(probe), capsRenderable);
    const world = new World();
    const handle = catalogEquirect(world, equirectPod());
    const reg = new RhiErrorListenerRegistry();
    const frameState = makeFrameState();

    // No entry before the first drive.
    expect(store.getCubemapStatus(handle)).toBeUndefined();

    driveLazyEquirectProjection(
      makeInternals(store, reg, capsRenderable),
      world,
      frameState,
      handle as unknown as number,
    );

    // The cube projection entry is pending until the IBL command submission
    // completion fence resolves; only then is it published as ready.
    expect(store.getCubemapStatus(handle)).toBe('pending');
    await flushProjection(store, handle);
    expect(store.getCubemapStatus(handle)).toBe('ready');
    expect(probe.textures).toBeGreaterThan(0);
  });

  it('re-entry does NOT relaunch the projection (idempotent per source, D-4)', async () => {
    const probe: DeviceProbe = { textures: 0 };
    const store = configuredStore(makeReadyDevice(probe), capsRenderable);
    const world = new World();
    const handle = catalogEquirect(world, equirectPod());
    const reg = new RhiErrorListenerRegistry();
    const frameState = makeFrameState();
    const internals = makeInternals(store, reg, capsRenderable);

    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    const texturesWhilePending = probe.textures;
    expect(store.getCubemapStatus(handle)).toBe('pending');
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    expect(store.getCubemapStatus(handle)).toBe('pending');
    expect(probe.textures).toBe(texturesWhilePending);
    await flushProjection(store, handle);
    expect(store.getCubemapStatus(handle)).toBe('ready');
    const texturesAfterFirst = probe.textures;
    expect(texturesAfterFirst).toBeGreaterThan(0);

    // Subsequent frames: the existing entry (status !== undefined) short-circuits
    // the lazy trigger, so no second projection / texture is minted.
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    expect(probe.textures).toBe(texturesAfterFirst);
  });

  it('failed -> EquirectProjectionFailedError fired EXACTLY ONCE per handle; no retry (R-2 / AC-09)', () => {
    const store = configuredStore(makeFailingDevice(), capsRenderable);
    const world = new World();
    const handle = catalogEquirect(world, equirectPod());
    const reg = new RhiErrorListenerRegistry();
    const fired: Array<{ code: string; handle: number | undefined; hint?: string }> = [];
    reg.add((e) => {
      if (e.code === 'equirect-projection-failed') {
        fired.push({ code: e.code, handle: e.detail.handle, hint: e.hint });
      } else {
        fired.push({ code: e.code, handle: undefined });
      }
    });
    const frameState = makeFrameState();
    const internals = makeInternals(store, reg, capsRenderable);

    // Frame 1: first sight (status undefined) -> fire-and-forget launch. The
    // failing device drives status:'failed' SYNCHRONOUSLY (the cube createTexture
    // fails before any await), but the lazy arm checked 'undefined' this frame,
    // so it only launched -- no error fired yet.
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    expect(store.getCubemapStatus(handle)).toBe('failed');
    expect(fired).toEqual([]);

    // Frame 2: status:'failed' observed -> fire the structured error ONCE.
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      code: 'equirect-projection-failed',
      handle: handle as unknown as number,
    });
    expect(fired[0]?.hint).toContain('device-lost');

    // Frame 3+: the latch keeps the channel quiet -- no re-fire, no retry
    // (the store's status:'failed' short-circuit + the frameState latch).
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    expect(fired.length).toBe(1);
    expect(store.getCubemapStatus(handle)).toBe('failed');
  });

  it('an 8-bit equirect reports its invalid-source-format cause through the projection error', () => {
    const probe: DeviceProbe = { textures: 0 };
    const store = configuredStore(makeReadyDevice(probe), capsRenderable);
    const world = new World();
    const handle = catalogEquirect(world, {
      ...equirectPod(),
      format: 'rgba8unorm',
      data: new Uint8Array(4 * 2 * 4),
    });
    const reg = new RhiErrorListenerRegistry();
    const causes: string[] = [];
    reg.add((e) => {
      if (e.code === 'equirect-projection-failed') causes.push(e.detail.cause.code);
    });
    const frameState = makeFrameState();
    const internals = makeInternals(store, reg, capsRenderable);

    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);
    driveLazyEquirectProjection(internals, world, frameState, handle as unknown as number);

    expect(store.getCubemapStatus(handle)).toBe('failed');
    expect(causes).toEqual(['invalid-source-format']);
    expect(probe.textures).toBe(0);
  });

  it('handle resolves to a non-equirect / missing POD -> no launch, no crash', () => {
    const probe: DeviceProbe = { textures: 0 };
    const store = configuredStore(makeReadyDevice(probe), capsRenderable);
    const world = new World();
    const reg = new RhiErrorListenerRegistry();
    const seen: string[] = [];
    reg.add((e) => seen.push(e.code));
    const frameState = makeFrameState();

    // A handle that was never catalogued (stale) -> resolveAssetHandle misses.
    const staleHandle = 999999;
    driveLazyEquirectProjection(
      makeInternals(store, reg, capsRenderable),
      world,
      frameState,
      staleHandle,
    );

    expect(probe.textures).toBe(0);
    expect(store.getCubemapStatus(toShared<'EquirectAsset'>(staleHandle))).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe('warnMultiSkylight / warnMultiSkybox — once-warn naming the winner (M3 / w20, w19)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warnMultiSkylight: warns once, names winning entity handle, includes ignored count', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedMultiSkylight: false };

    warnMultiSkylight(frameState, 3, 42);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]?.[0]);
    expect(msg).toContain('Skylight');
    // Names the winning entity handle (F-8: conflicting entity info).
    expect(msg).toContain('42');
    // Reports the count + how many are ignored.
    expect(msg).toContain('3');
    expect(msg).toContain('2'); // 3 - 1 ignored

    // Second call (still >1): the latch keeps it silent -- no per-frame flood.
    warnMultiSkylight(frameState, 3, 42);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('warnMultiSkylight: count<=1 never warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedMultiSkylight: false };
    warnMultiSkylight(frameState, 1, 7);
    warnMultiSkylight(frameState, 0, 0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('warnMultiSkybox: warns once, names winning entity handle', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedMultiSkybox: false };

    warnMultiSkybox(frameState, 2, 99);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]?.[0]);
    expect(msg).toContain('SkyboxBackground');
    expect(msg).toContain('99');

    warnMultiSkybox(frameState, 2, 99);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('selectLazyEquirectHandle — shared Skylight/Skybox source selection', () => {
  it('falls back to SkyboxBackground when Skylight is color-only (handle 0)', () => {
    expect(selectLazyEquirectHandle({ equirectHandle: 0 }, { equirectHandle: 77 })).toBe(77);
  });

  it('prefers a non-zero Skylight equirect over the SkyboxBackground source', () => {
    expect(selectLazyEquirectHandle({ equirectHandle: 55 }, { equirectHandle: 77 })).toBe(55);
  });

  it('returns the solid-color sentinel when neither source has an equirect', () => {
    expect(selectLazyEquirectHandle({ equirectHandle: 0 }, undefined)).toBe(0);
    expect(selectLazyEquirectHandle(undefined, undefined)).toBe(0);
  });
});
