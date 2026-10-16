// shadow-fields-observable.dawn.test.ts
// feat-20260621-merge-directionallightshadow-into-directionallight M6
//
// Observability gate: proves depthBias, normalBias, and the directional filter
// carrier -- three merged DirectionalLight shadow fields -- produce real pixel A/B diffs.
//
// Root cause of prior "0 diff everywhere" failure: (a) materials without
// ShadowCaster pass (nothing written into shadow depth atlas), (b) floor
// position outside camera frustum. Both fixed in the harness below.
//
// Each pixel A/B pair gets its own `it()` with a fresh runtime host --
// shadow-atlas state and device-lost crashes from prior A/B rounds cannot
// contaminate the current comparison.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import {
  Camera,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterAll, describe, expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { validateDirectionalLightData } from '../../../render/src/components/light-helpers';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

const LIGHTWEIGHT_DAWN = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
// Static field comparisons share the settled-frame and viewport budgets.
// Full diagnostics retain sixty frames; every A/B leg still gets a fresh host.
const SHADOW_FIELDS_RENDER_FRAMES = LIGHTWEIGHT_DAWN ? testQuality.staticFrames : 60;
const WIDTH = LIGHTWEIGHT_DAWN ? testQuality.squareSize : 256;
const HEIGHT = WIDTH;
const BPR = Math.ceil((WIDTH * 4) / 256) * 256;

// Four fresh readbacks, or the map-size comparison's full 60 frames, retain a
// bounded software-GPU budget. The lightweight map comparison keeps 60 seconds.
const SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS = 300_000;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = URL.createObjectURL(
  new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }),
);
afterAll(() => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

describe('M3 Dawn candidate admission', () => {
  it('requires accepted production candidate to preserve the requested PCSS profile', async () => {
    const module = (await import('../../../render/src/render-pipeline')) as Record<string, unknown>;
    const resolver = module.resolveDirectionalShadowBackendAdmission;
    expect(typeof resolver).toBe('function');
    const result = (
      resolver as (input: {
        backendKind: 'webgpu';
        requested: 'pcssMedium' | 'pcssHigh';
        candidate: 'accepted' | 'failed';
      }) => { effective: string; status: string; pixelEvidence: string }
    )({ backendKind: 'webgpu', requested: 'pcssHigh', candidate: 'accepted' });
    expect(result).toMatchObject({
      effective: 'pcssHigh',
      status: 'accepted',
      pixelEvidence: 'available',
    });
  });

  it('requires the same bounded Directional inspection projection used by Dawn', async () => {
    const module = (await import(
      '../../../render/src/assembly/directional-shadow-inspection'
    )) as Record<string, unknown>;
    const project = module.projectDirectionalShadowInspection;
    expect(typeof project).toBe('function');
    const result = (project as (input: Record<string, unknown>) => Record<string, unknown>)({
      admission: {
        requested: 'pcssMedium',
        effective: 'pcssMedium',
        status: 'accepted',
        pixelEvidence: 'available',
      },
      cascadeCount: 4,
      mapSize: 1024,
      shadowMapBytes: 16_777_216,
      writerPasses: 4,
      blockerTaps: 8,
      filterTapUpperBound: 16,
      seamTapUpperBound: 48,
      deviceGeneration: 1,
      graphGeneration: 3,
    });
    expect(result).toMatchObject({
      requested: 'pcssMedium',
      effective: 'pcssMedium',
      blockerTaps: 8,
      filterTapUpperBound: 16,
      seamTapUpperBound: 48,
    });
    expect(Object.keys(result)).not.toContain('perPixel');
  });
});

// Helper types
interface WriteCapture {
  f32: Float32Array;
}

function composedStandardPbr(): string {
  const m = ENGINE_MANIFEST.materialShaders.find(
    (s: { identifier: string }) => s.identifier === 'forgeax::default-standard-pbr',
  );
  if (!m) throw new Error('default-standard-pbr not in engine manifest');
  return m.composedWgsl;
}

function buildTranslationGrid(): Float32Array {
  const out = new Float32Array(5 * 16);
  const s = 2.5;
  const h = ((5 - 1) * s) / 2;
  for (let i = 0; i < 5; i++) {
    const b = i * 16;
    out[b + 0] = 1;
    out[b + 5] = 1;
    out[b + 10] = 1;
    out[b + 15] = 1;
    out[b + 12] = i * s - h;
  }
  return out;
}

// Material with ShadowCaster pass -- required for depth writes into shadow atlas
function casterMat(w: World) {
  return w.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
      {
        name: 'ShadowCaster',
        program: { module: 'forgeax::default-shadow-caster' },
        renderState: {
          tags: { LightMode: 'ShadowCaster' } as Record<string, string>,
          passKind: 'shadow-caster' as const,
        },
      },
    ],
    values: {
      baseColor: [0.8, 0.6, 0.4, 1],
      metallic: 0.3,
      roughness: 0.5,
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      occlusionStrength: 1,
    },
  } as MaterialAsset);
}
function floorMat(w: World) {
  return w.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor: [0.9, 0.9, 0.9, 1],
      metallic: 0,
      roughness: 0.9,
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      occlusionStrength: 1,
    },
  } as MaterialAsset);
}

// Floor at Y=5 Z=5 — in camera frustum (camera Y=8 Z=16, FOV 45, depth 11,
// visible Y [3.44, 12.56]). Occluder cubes at Y=7 cast shadow DOWN.
function spawnScene(
  world: World,
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
) {
  const cm = casterMat(world);
  const fm = floorMat(world);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 5, 5],
        quat: [0, 0, 0, 1],
        scale: [8, 0.1, 8],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [fm] } },
  );
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 8, 16],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        fov: (45 * Math.PI) / 180,
        aspect: 1,
        near: 0.1,
        far: 100,
        clearColor: [0.05, 0.05, 0.08, 1],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0.3, -0.9, -0.31],
      color: [1, 1, 1],
      intensity: 1,
      castShadow,
      mapSize: mapSize ?? testQuality.shadowMapSize,
      // One cascade covers this field-comparison scene. Multi-cascade rebuilds
      // are exercised by shadow-csm-runtime-vary.dawn.test.ts; repeating four
      // 2048-square depth maps here hid the field assertions behind timeouts.
      cascadeCount: 1,
      depthBias,
      normalBias,
      shadowDistance: 50,
      shadowFilter: pcf === 1 ? 1 : pcf === 3 ? 2 : 3,
      shadowAngularRadius: 0.00465,
      maxPenumbraTexels: 32,
    },
  });
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 7, 5],
        quat: [0, 0, 0, 1],
        scale: [0.5, 0.5, 0.5],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cm] } },
    { component: Instances, data: { transforms: buildTranslationGrid() } },
  );
}

function diff(a: Uint8Array, b: Uint8Array): { diff: number; maxChanDelta: number } {
  let d = 0,
    mc = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const v = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (v > 0) {
      d++;
      if (v > mc) mc = v;
    }
  }
  return { diff: d, maxChanDelta: mc };
}

async function readback(dev: GPUDevice, rt: GPUTexture): Promise<Uint8Array> {
  const buf = dev.createBuffer({ size: BPR * HEIGHT, usage: 0x0001 | 0x0008 });
  {
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: rt },
      { buffer: buf, bytesPerRow: BPR, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    dev.queue.submit([enc.finish()]);
  }
  await buf.mapAsync(0x0001);
  const px = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap();
  buf.destroy();
  return px;
}

async function renderConfig(
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
): Promise<Uint8Array> {
  let sd: GPUDevice | undefined;
  let rt: GPUTexture | undefined;
  const _s = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const ra = await _s(opts);
    if (!ra) return ra;
    const ord = ra.requestDevice.bind(ra);
    ra.requestDevice = async (desc) => {
      const dev = await ord(desc);
      if (!sd) sd = dev;
      return dev;
    };
    return ra;
  };
  const ens = (d: GPUDevice, f: GPUTextureFormat): GPUTexture => {
    if (rt) return rt;
    rt = d.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: f,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return rt;
  };
  const mc = {
    width: WIDTH,
    height: HEIGHT,
    getContext(k: string): unknown {
      if (k !== 'webgpu') return null;
      return {
        configure(d: { device: GPUDevice; format?: GPUTextureFormat }) {
          ens(d.device, d.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (!rt) throw new Error('no rt');
          return rt;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Renderer | undefined;
  try {
    try {
      const host = await constructRuntimeRendererHost(
        mc,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
      if (!host.ok) throw host.error;
      renderer = host.value.renderer;
    } finally {
      globalThis.navigator.gpu.requestAdapter = _s;
    }
    if (renderer === undefined) throw new Error('renderer not initialized');
    if (renderer.inspect().state !== 'alive') throw new Error('renderer not alive');
    if (sd === undefined) throw new Error('device not initialized');
    const dev = sd;

    const w = new World();
    spawnScene(w, castShadow, depthBias, normalBias, pcf, mapSize);
    let de = 0;
    for (let i = 0; i < SHADOW_FIELDS_RENDER_FRAMES; i++) {
      const r = drawPublished(renderer, w);
      if (!r.ok) de++;
      // Keep the native Dawn carrier paced like a real frame loop. Without a
      // bounded drain, a long shadow-map leg can retain an unbounded lavapipe
      // command/resource backlog before the final fence below.
      if (i % 16 === 15) await dev.queue.onSubmittedWorkDone();
    }
    if (de > 0) throw new Error(`draw errors: ${de}`);
    // rt is created lazily by the canvas configure()/getCurrentTexture path during
    // the first draw, so it is only guaranteed present after the draw loop.
    if (rt === undefined) throw new Error('render target not initialized');
    await dev.queue.onSubmittedWorkDone();
    const pixels = await readback(dev, rt);
    return pixels;
  } finally {
    renderer?.dispose();
    rt?.destroy();
    sd?.destroy();
  }
}

async function renderConfigWithSpy(
  castShadow: boolean,
  depthBias: number,
  normalBias: number,
  pcf: number,
  mapSize?: number,
): Promise<{ pixels: Uint8Array; captured: WriteCapture[] }> {
  let sd: GPUDevice | undefined;
  let rt: GPUTexture | undefined;
  const captured: WriteCapture[] = [];

  const _s = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const ra = await _s(opts);
    if (!ra) return ra;
    const ord = ra.requestDevice.bind(ra);
    ra.requestDevice = async (desc) => {
      const dev = await ord(desc);
      if (!sd) {
        sd = dev;
        const orig = dev.queue.writeBuffer.bind(dev.queue);
        const spy = (
          buf: GPUBuffer,
          off: number,
          data: BufferSource | SharedArrayBuffer,
          ...rest: readonly unknown[]
        ): void => {
          const view = data as ArrayBufferView & { length?: number; BYTES_PER_ELEMENT?: number };
          const nb = view.byteLength ?? (view.length ?? 0) * (view.BYTES_PER_ELEMENT ?? 4);
          // feat-20260625 w25: the View UBO grew 592 -> 784 B (148 -> 196 f32)
          // when the spot lightViewProj array folded into its tail. The
          // directional fields this test reads live in floats [0..148); capture
          // that leading window from the now-784 B view write.
          if (buf.label === 'pbr-view-ubo' && nb >= 784 && off === 0) {
            const copy = new Float32Array(148);
            if (data instanceof Float32Array) copy.set(data.subarray(0, 148));
            else if (ArrayBuffer.isView(data)) {
              const sf32 = new Float32Array(data.buffer, data.byteOffset, 148);
              copy.set(sf32);
            }
            captured.push({ f32: copy });
          }
          (orig as (...a: readonly unknown[]) => void)(buf, off, data, ...rest);
        };
        (dev.queue as unknown as { writeBuffer: typeof spy }).writeBuffer = spy;
      }
      return dev;
    };
    return ra;
  };
  const ens = (d: GPUDevice, f: GPUTextureFormat): GPUTexture => {
    if (rt) return rt;
    rt = d.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: f,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return rt;
  };
  const mc = {
    width: WIDTH,
    height: HEIGHT,
    getContext(k: string): unknown {
      if (k !== 'webgpu') return null;
      return {
        configure(d: { device: GPUDevice; format?: GPUTextureFormat }) {
          ens(d.device, d.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (!rt) throw new Error('no rt');
          return rt;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Renderer | undefined;
  try {
    try {
      const host = await constructRuntimeRendererHost(
        mc,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
      if (!host.ok) throw host.error;
      renderer = host.value.renderer;
    } finally {
      globalThis.navigator.gpu.requestAdapter = _s;
    }
    if (renderer === undefined) throw new Error('renderer not initialized');
    if (renderer.inspect().state !== 'alive') throw new Error('renderer not alive');
    if (sd === undefined) throw new Error('device not initialized');
    const dev = sd;

    const w = new World();
    spawnScene(w, castShadow, depthBias, normalBias, pcf, mapSize);
    let de = 0;
    for (let i = 0; i < 10; i++) {
      const r = drawPublished(renderer, w);
      if (!r.ok) de++;
    }
    if (de > 0) throw new Error(`draw errors: ${de}`);
    await dev.queue.onSubmittedWorkDone();
    return { pixels: new Uint8Array(0), captured };
  } finally {
    renderer?.dispose();
    rt?.destroy();
    sd?.destroy();
  }
}

describe('M6 shadow fields observability', () => {
  // --- Gate A: structural WGSL check ---
  it('composed default-standard-pbr WGSL reads view.depthBias, view.normalBias, and directionalShadowFilter', () => {
    const wgsl = composedStandardPbr();
    expect(wgsl).toContain('depthBias');
    expect(wgsl).toContain('normalBias');
    expect(wgsl).toContain('directionalShadowFilter');
  });

  // --- Gate B: UBO spy — slots [126]=depthBias, [127]=normalBias, [128]=filter profile ---
  it('View UBO slots [126]=depthBias, [127]=normalBias, [128]=filter profile', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const { captured } = await renderConfigWithSpy(true, 0.123, 0.456, 3);
    const vw = captured.filter((c) => c.f32.length >= 148);
    expect(vw.length).toBeGreaterThan(0);
    const last = vw[vw.length - 1];
    if (last === undefined) throw new Error('no view UBO write captured');
    const f32 = last.f32;
    expect(Math.abs((f32[126] ?? Number.NaN) - 0.123)).toBeLessThan(0.001);
    expect(Math.abs((f32[127] ?? Number.NaN) - 0.456)).toBeLessThan(0.001);
    expect(f32[128]).toBe(2);
  }, 60000);

  // --- Gate D: pcf5 maps to the accepted profile carrier ---
  it('pcf5 maps to profile 3 in View UBO[128]', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const { captured } = await renderConfigWithSpy(true, 0.005, 0.05, 5);
    const vw9 = captured.filter((c) => c.f32.length >= 148);
    expect(vw9.length).toBeGreaterThan(0);
    const last9 = vw9[vw9.length - 1];
    if (last9 === undefined) throw new Error('no view UBO write captured');
    expect(last9.f32[128]).toBe(3);
  }, 60000);

  // --- Gate D: Directional filter validation ---
  it('validate() accepts pcf5 and rejects an unknown directional filter', () => {
    const valid = validateDirectionalLightData({
      direction: [0, -1, 0],
      castShadow: true,
      cascadeCount: 4,
      splitLambda: 0.75,
      cascadeBlend: 0.2,
      mapSize: 2048,
      shadowDistance: 50,
      shadowFilter: 3,
    });
    expect(valid.ok).toBe(true);

    const even = validateDirectionalLightData({
      direction: [0, -1, 0],
      castShadow: true,
      cascadeCount: 4,
      splitLambda: 0.75,
      cascadeBlend: 0.2,
      mapSize: 2048,
      shadowDistance: 50,
      shadowFilter: 99,
    });
    expect(even.ok).toBe(false);
    if (!even.ok) expect(even.error.code).toBe('shadow-invalid-config');

    const zero = validateDirectionalLightData({
      direction: [0, -1, 0],
      castShadow: true,
      cascadeCount: 4,
      splitLambda: 0.75,
      cascadeBlend: 0.2,
      mapSize: 2048,
      shadowDistance: 50,
      shadowFilter: 0,
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe('shadow-invalid-config');
  });

  // --- Gate C: pixel A/B — castShadow ON vs OFF (control) ---
  it('pixel A/B: castShadow ON vs OFF (control — must differ)', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const pxOn = await renderConfig(true, 0.005, 0.05, 3);
    const pxOff = await renderConfig(false, 0.005, 0.05, 3);
    const d = diff(pxOn, pxOff);
    expect(d.diff).toBeGreaterThan(0);
  }, 60000);

  it('castShadow=false emits a zero directional cascade count in the View UBO', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
    const { captured } = await renderConfigWithSpy(false, 0.005, 0.05, 3);
    const viewWrites = captured.filter((capture) => capture.f32.length >= 148);
    expect(viewWrites.length).toBeGreaterThan(0);
    const last = viewWrites[viewWrites.length - 1];
    if (last === undefined) throw new Error('no view UBO write captured');
    expect(last.f32[124]).toBe(0);
  }, 60000);

  // --- Gate F: distinct map sizes (independent shadow proof) ---
  it(
    'pixel A/B: mapSize half vs twice the shared budget',
    async () => {
      if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
      const pxA = await renderConfig(true, 0.005, 0.05, 3, testQuality.shadowMapSize / 2);
      const pxB = await renderConfig(true, 0.005, 0.05, 3, testQuality.shadowMapSize * 2);
      const d = diff(pxA, pxB);
      expect(d.diff).toBeGreaterThan(0);
    },
    LIGHTWEIGHT_DAWN ? 60_000 : SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS,
  );

  // --- Gate G (AC-08): per-field falsification — discriminating-power proof ---
  //
  // AC-08 requires a git-visible gate proving each field's AC-03 signal is
  // CAUSED BY that field's UBO wiring, not by render nondeterminism. The
  // falsification is the contrast pair, asserted in ONE test so the discriminating
  // power is self-evident and cannot silently rot:
  //
  //   varied(field)  -> diff > 0   (the AC-03 observable signal)
  //   held(field)    -> diff == 0  (remove the only variable => signal vanishes)
  //
  // The `held` leg is the falsification: with the field pinned equal across both
  // renders, the bias/PCF UBO slot receives identical bytes, so IF the rendered
  // diff still appeared it would prove the signal came from something other than
  // the field (nondeterminism / a confounding input) and the AC-03 A/B above would
  // be meaningless. held==0 + varied>0 together establish that the observed signal
  // is attributable to exactly that field's wiring. Equivalent to "delete the UBO
  // write -> signal disappears" without mutating production engine code: pinning
  // the source value equal makes the write a no-op differentiator.
  //
  // Falsification SSOT note: to manually re-confirm the destructive variant
  // (physically removing the UBO write), comment out the matching
  // `viewPayload[126|127|128] = ...` line in render-system-record.ts and re-run
  // the corresponding `varied` leg — its diff collapses to 0, matching `held`.
  it(
    'falsification: depthBias varied differs, held does not (signal attributable to the field)',
    async () => {
      if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
      const varied = diff(
        await renderConfig(true, 0.0, 0.05, 3),
        await renderConfig(true, 0.5, 0.05, 3),
      );
      const held = diff(
        await renderConfig(true, 0.0, 0.05, 3),
        await renderConfig(true, 0.0, 0.05, 3),
      );
      expect(varied.diff).toBeGreaterThan(0);
      expect(held.diff).toBe(0);
    },
    SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS,
  );

  it(
    'falsification: normalBias varied differs, held does not',
    async () => {
      if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
      const varied = diff(
        await renderConfig(true, 0.005, 0.0, 3),
        await renderConfig(true, 0.005, 0.5, 3),
      );
      const held = diff(
        await renderConfig(true, 0.005, 0.0, 3),
        await renderConfig(true, 0.005, 0.0, 3),
      );
      expect(varied.diff).toBeGreaterThan(0);
      expect(held.diff).toBe(0);
    },
    SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS,
  );

  it(
    'falsification: directional filter varied differs, held does not',
    async () => {
      if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') return;
      const varied = diff(
        await renderConfig(true, 0.005, 0.05, 1),
        await renderConfig(true, 0.005, 0.05, 5),
      );
      const held = diff(
        await renderConfig(true, 0.005, 0.05, 1),
        await renderConfig(true, 0.005, 0.05, 1),
      );
      expect(varied.diff).toBeGreaterThan(0);
      expect(held.diff).toBe(0);
    },
    SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS,
  );
});
