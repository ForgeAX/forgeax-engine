// t51 (M3.5) -- dawn 4-pass IBL precompute readback (red-phase).
//
// Real GPU (dawn-node / webgpu native binding) test: feeds a 4x2 rgba16float
// all-ones equirect into uploadCubemapFromEquirect, then reads back one
// pixel from each of the 4 produced textures. All 4 pixels must be
// non-zero -- a zero readback means the GPU pass never ran (round-1
// counter-as-dispatch-proxy regression).
//
// Red phase: before t52/t53 wire real createIblPipelines + runIblPrecompute,
// the cubemap / irradiance / prefilter / brdfLut textures are created but
// never drawn into, so every readback pixel is vec4(0).
//
// Green phase: t52/t53 land 4 real render passes + queue.submit; readback
// pixels carry non-zero values (white equirect -> bright cube -> non-zero
// irradiance / prefilter / brdfLut).

import { World } from '@forgeax/engine-ecs';
import { composeShader } from '@forgeax/engine-naga';
import { ok, type RhiDevice, type Texture } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import type { EquirectAsset, TextureFormat } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../../../../render/src/device/device-scope';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';
import {
  getOrCreateIblCache,
  setIblComposedShaders,
} from '../../../../render/src/ibl/IblPipelineCache';

const mockCaps = {
  backendKind: 'webgpu' as const,
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
};

// feat-20260601-device/gpu-residency-extraction M1 (D-3 falsifiable anchor): a
// single store._uploadCubemapFromEquirect(world, srcHandle, srcPod) returns the
// cube handle, and store.getCubemapGpuTexture(cubeHandle) reads it back -- the
// single-call contract is preserved. The cube POD register-relay is injected
// at configureGpuDevice and mints via world.allocSharedRef (the store holds no
// registry reference, D-3).

// Load + compose the 6 ibl-* WGSL modules into the 4 composed entry shaders
// that createIblPipelines consumes. Mirrors what vite-plugin-shader does at
// build-time for the browser/runtime path; the dawn test stands in for
// vite-plugin-shader so the readback receives non-placeholder pipelines.
async function composeIblShadersForDawn(): Promise<void> {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  const fs = (await import(/* @vite-ignore */ fsId)) as {
    readFileSync: (p: string, enc: string) => string;
  };
  const pathMod = (await import(/* @vite-ignore */ pathId)) as {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  };
  const url = (await import(/* @vite-ignore */ urlId)) as {
    fileURLToPath: (u: string) => string;
  };
  const here = url.fileURLToPath(import.meta.url);
  // Resolve packages/shader/src/ relative to this test file
  // (packages/runtime/src/__tests__/dawn/).
  const shaderSrc = pathMod.resolve(pathMod.dirname(here), '..', '..', '..', '..', 'shader', 'src');
  const read = (name: string) => fs.readFileSync(pathMod.resolve(shaderSrc, name), 'utf8');
  const sharedSrc = read('ibl-shared.wgsl');
  const equirectSrc = read('ibl-equirect-to-cube.wgsl');
  const irradianceSrc = read('ibl-irradiance.wgsl');
  const prefilterSrc = read('ibl-prefilter.wgsl');
  const brdfLutSrc = read('ibl-brdf-lut.wgsl');
  // The per-pass modules import ibl-shared, which derives F90 through brdf.
  const imports = { 'forgeax_pbr::ibl_shared': sharedSrc, 'forgeax_pbr::brdf': read('brdf.wgsl') };
  const [equirectToCube, irradiance, prefilter, brdfLut] = await Promise.all([
    composeShader(equirectSrc, imports, {}),
    composeShader(irradianceSrc, imports, {}),
    composeShader(prefilterSrc, imports, {}),
    composeShader(brdfLutSrc, imports, {}),
  ]);
  setIblComposedShaders({ equirectToCube, irradiance, prefilter, brdfLut });
}

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

function makeWhiteEquirect(): EquirectAsset {
  // 4x2 rgba16float, all 1.0 (HDR white). 16-bit float 1.0 = 0x3C00 = 15360.
  const w = 4;
  const h = 2;
  const data = new Uint8Array(w * h * 8);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < w * h * 4; i++) {
    dv.setUint16(i * 2, 0x3c00, true);
  }
  return {
    kind: 'equirect',
    width: w,
    height: h,
    format: 'rgba16float' as TextureFormat,
    data,
    colorSpace: 'linear',
  };
}

/** Raw resource conversion is confined to this Dawn readback boundary. */
function rawTexture(texture: Texture): GPUTexture {
  return texture as unknown as GPUTexture;
}

async function readbackRgba16f(
  device: GPUDevice,
  texture: GPUTexture,
  arrayLayer: number,
  mipLevel: number,
): Promise<{ values: number[]; rawBytes: number[] }> {
  // Read one pixel from (0,0) of (face=arrayLayer, mip=mipLevel).
  const bytesPerRow = 256;
  const buffer = device.createBuffer({
    size: bytesPerRow,
    usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
  });
  const encoder = device.createCommandEncoder({ label: 'ibl-readback' });
  encoder.copyTextureToBuffer(
    { texture, mipLevel, origin: { x: 0, y: 0, z: arrayLayer } },
    { buffer, bytesPerRow },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x0001 /* MAP_READ */);
  const range = buffer.getMappedRange();
  const raw = new Uint8Array(range.slice(0));
  const dv = new DataView(raw.buffer);
  buffer.unmap();
  const f16ToF32 = (u16: number) => {
    const sign = (u16 & 0x8000) >> 15;
    const exp = (u16 & 0x7c00) >> 10;
    const frac = u16 & 0x03ff;
    if (exp === 0) return (sign ? -1 : 1) * 2 ** -14 * (frac / 1024);
    if (exp === 0x1f) return frac ? Number.NaN : (sign ? -1 : 1) * Number.POSITIVE_INFINITY;
    return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
  };
  return {
    values: [
      f16ToF32(dv.getUint16(0, true)),
      f16ToF32(dv.getUint16(2, true)),
      f16ToF32(dv.getUint16(4, true)),
      f16ToF32(dv.getUint16(6, true)),
    ],
    rawBytes: [...raw.slice(0, 8)],
  };
}

interface TextureReadbackSpec {
  readonly label: string;
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly faces: number;
  readonly mipLevels: number;
  readonly identity: string;
}

/**
 * Submit all subresource copies before mapping any staging buffer. This keeps
 * the readback observational: no producer pass is interrupted by a map/wait.
 */
async function assertFiniteTextureRgba16f(
  device: GPUDevice,
  spec: TextureReadbackSpec,
): Promise<void> {
  const bytesPerPixel = 8;
  const parts: Array<{
    readonly buffer: GPUBuffer;
    readonly width: number;
    readonly height: number;
    readonly face: number;
    readonly mip: number;
    readonly rowPitch: number;
  }> = [];
  const encoder = device.createCommandEncoder({ label: `${spec.label}-full-readback` });
  for (let mip = 0; mip < spec.mipLevels; mip += 1) {
    const width = Math.max(1, spec.width >> mip);
    const height = Math.max(1, spec.height >> mip);
    const rowPitch = Math.ceil((width * bytesPerPixel) / 256) * 256;
    for (let face = 0; face < spec.faces; face += 1) {
      const buffer = device.createBuffer({
        label: `${spec.label}-readback-face${face}-mip${mip}`,
        size: rowPitch * height,
        usage: 0x0001 | 0x0008,
      });
      encoder.copyTextureToBuffer(
        { texture: spec.texture, mipLevel: mip, origin: { x: 0, y: 0, z: face } },
        { buffer, bytesPerRow: rowPitch },
        { width, height, depthOrArrayLayers: 1 },
      );
      parts.push({ buffer, width, height, face, mip, rowPitch });
    }
  }
  device.queue.submit([encoder.finish()]);
  await Promise.all(parts.map((part) => part.buffer.mapAsync(0x0001)));
  try {
    for (const part of parts) {
      const raw = new Uint8Array(part.buffer.getMappedRange()).slice();
      const view = new DataView(raw.buffer);
      for (let y = 0; y < part.height; y += 1) {
        for (let x = 0; x < part.width; x += 1) {
          const offset = y * part.rowPitch + x * bytesPerPixel;
          for (let channel = 0; channel < 4; channel += 1) {
            const value = f16ToF32(view.getUint16(offset + channel * 2, true));
            if (!Number.isFinite(value)) {
              const rawBytes = [...raw.slice(offset, offset + bytesPerPixel)];
              throw new Error(
                `${spec.label} non-finite sample at texture=${spec.identity}, face=${part.face}, mip=${part.mip}, x=${x}, y=${y}; rawBytes=${rawBytes.join(',')}`,
              );
            }
          }
        }
      }
    }
  } finally {
    for (const part of parts) {
      part.buffer.unmap();
      part.buffer.destroy();
    }
  }
}

function f16ToF32(u16: number): number {
  const sign = (u16 & 0x8000) >> 15;
  const exp = (u16 & 0x7c00) >> 10;
  const frac = u16 & 0x03ff;
  if (exp === 0) return (sign ? -1 : 1) * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? Number.NaN : (sign ? -1 : 1) * Number.POSITIVE_INFINITY;
  return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
}

async function loadPhysicalGuidEquirect(): Promise<EquirectAsset> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const bodyPath = path.resolve(
    here,
    '../../../../../apps/hello/physical-material/dist/assets',
    `${guid}-body.bin`,
  );
  const raw = (fs.readFileSync as unknown as (path: string) => Uint8Array)(bodyPath);
  const data = new Uint8Array(raw.byteLength);
  data.set(raw);
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const expected = '391ac77feea42745a6ae6b12d4da46bed90e8af4721525f4def0882c10cd8084';
  if (digest !== expected) throw new Error(`physical HDR body hash mismatch: ${digest}`);
  console.error(
    `[ibl-diagnostic] ${JSON.stringify({ sourceGuid: guid, bodyPath, bodySha256: digest, width: 1600, height: 800, format: 'rgba16float', deviceGeneration: 0 })}`,
  );
  return {
    kind: 'equirect',
    width: 1600,
    height: 800,
    format: 'rgba16float',
    data,
    colorSpace: 'linear',
  };
}

describe('t51 (M3.5) -- dawn IBL 4-pass non-zero readback', () => {
  it.skipIf(!dawnReady)(
    'AC-04/05/06: equirect / irradiance / prefilter / brdfLut readback pixels are non-zero',
    async () => {
      // Compose ibl-* WGSL into 4 entry shaders before the upload. In
      // production this happens at vite-plugin-shader build-time and the
      // runtime calls setIblComposedShaders with the composed bundle;
      // dawn-node tests stand in for vite-plugin-shader by composing on
      // demand via @forgeax/engine-naga.
      await composeIblShadersForDawn();
      const adapterResult = await rhi.requestAdapter();
      if (!adapterResult.ok) throw adapterResult.error;
      const deviceResult = await adapterResult.value.requestDevice();
      if (!deviceResult.ok) throw deviceResult.error;
      const rhiDevice: RhiDevice = deviceResult.value;
      const rawDevice = _internal_getRawDevice(rhiDevice);
      if (rawDevice === undefined) {
        throw new Error('Dawn IBL readback requires the RHI WebGPU raw-device test boundary');
      }

      const store = new GpuResidencyCache();
      const scope = DeviceScope.create(0, 'ibl-dawn-test');
      store.bindDeviceScope(scope);
      const world = new World();
      const equirect =
        process.env.FORGEAX_IBL_REAL_SOURCE === '1'
          ? await loadPhysicalGuidEquirect()
          : makeWhiteEquirect();
      const equirectHandle = world.allocSharedRef('EquirectAsset', equirect);

      // The production path receives the opaque RhiDevice and the same
      // Result-returning shader factory used by the WebGPU backend. Raw GPU
      // access remains confined to readback below.
      store.configureGpuDevice(
        rhiDevice,
        undefined,
        (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      store.configureIblDevice(rhiDevice, createShaderModule);

      // Single call returns the cube handle (D-3 single-call contract). The
      // projection method is @internal (private) after feat-20260630 M2 / w11;
      // the dawn test reaches it through the store internals.
      const result = await store._uploadCubemapFromEquirect(world, equirectHandle, equirect);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const cubeHandle = result.value;
      const cubeTexture = store.getCubemapGpuTexture(cubeHandle);
      expect(cubeTexture).toBeDefined();
      if (cubeTexture === undefined) return;

      // feat-20260612 M3 / w11 (1c76c1b9): GpuResidencyCache handle maps now
      // hold the GpuTexture wrapper (`{handle, isDestroyed, destroy()}`).
      // dawn-node `copyTextureToBuffer` consumes the raw GPUTexture handle,
      // so the wrapper unwrap goes via `.handle` here. The IBL cache slots
      // below still hold raw textures (the ibl/IblPipelineCache wrapping is
      // OOS for this feat -- D-8 / OOS-10).
      const cubeRaw = rawTexture(cubeTexture.handle);

      // (a) equirect-to-cube face 0 center pixel != 0
      const cubePx = await readbackRgba16f(rawDevice, cubeRaw, 0, 0);
      expect(cubePx.values.some((c) => c !== 0)).toBe(true);
      await assertFiniteTextureRgba16f(rawDevice, {
        label: 'base-cube',
        texture: cubeRaw,
        width: Math.min(equirect.width, equirect.height),
        height: Math.min(equirect.width, equirect.height),
        faces: 6,
        mipLevels: 1,
        identity: 'cubemap-source',
      });

      // (b) irradiance, (c) prefilter, (d) brdfLut: the textures live on
      // IblPipelineCache after t52/t53. Read opaque cache slots through the
      // test-only raw texture boundary.
      const cache = getOrCreateIblCache(scope);
      const {
        irradianceTexture: irrTex,
        prefilterTexture: prefTex,
        brdfLutTexture: brdfTex,
      } = cache;
      expect(irrTex).toBeDefined();
      expect(prefTex).toBeDefined();
      expect(brdfTex).toBeDefined();
      expect(cache.prefilterFaceViewsByMip).toBeDefined();
      if (
        irrTex === undefined ||
        prefTex === undefined ||
        brdfTex === undefined ||
        cache.prefilterFaceViewsByMip === undefined
      )
        return;

      const irrRaw = rawTexture(irrTex);
      const irrPx = await readbackRgba16f(rawDevice, irrRaw, 0, 0);
      expect(irrPx.values.some((c) => c !== 0)).toBe(true);
      await assertFiniteTextureRgba16f(rawDevice, {
        label: 'irradiance',
        texture: irrRaw,
        width: 32,
        height: 32,
        faces: 6,
        mipLevels: 1,
        identity: 'ibl-irradiance-cube',
      });

      const prefRaw = rawTexture(prefTex);
      const prefPx = await readbackRgba16f(rawDevice, prefRaw, 0, 0);
      expect(prefPx.values.some((c) => c !== 0)).toBe(true);
      await assertFiniteTextureRgba16f(rawDevice, {
        label: 'prefilter',
        texture: prefRaw,
        width: 128,
        height: 128,
        faces: 6,
        mipLevels: cache.prefilterFaceViewsByMip.length,
        identity: 'ibl-prefilter-cube',
      });

      const brdfRaw = rawTexture(brdfTex);
      const brdfPx = await readbackRgba16f(rawDevice, brdfRaw, 0, 0);
      expect(brdfPx.values.some((c) => c !== 0)).toBe(true);
      await assertFiniteTextureRgba16f(rawDevice, {
        label: 'brdf-lut',
        texture: brdfRaw,
        width: 256,
        height: 256,
        faces: 1,
        mipLevels: 1,
        identity: 'ibl-brdf-lut',
      });
    },
    60_000,
  );
});
