// equirect renderable-source integration test (feat-20260707 M5 fix, dawn env).
//
// The full HDR equirect chain, end to end: an equirect is ALWAYS an IBL / skybox
// source (Skylight.equirect / SkyboxBackground.equirect drive equirect-to-cube /
// irradiance / prefilter RENDER passes). A block-compressed HDR format
// (bc6h-rgb-ufloat) is sample-only, never a color-renderable render target
// ("BC6HRGBUfloat is not color renderable"), so an equirect is never
// block-compressed: it is delivered uncompressed rgba16float. This test asserts
// the equirect loader yields an rgba16float POD and `deriveRenderDataCubemap`
// accepts it (renderable cube source), regardless of the device bc cap.
//
// This replaces the earlier "equirect -> BC6H by cap" premise, which was itself
// the bug: BC6H equirect broke cube projection with a WebGPU device error.
//
// dawn env: the caps triple is printed so the lavapipe/llvmpipe BC-support
// question stays empirically visible in CI logs; the equirect path is
// cap-independent (always rgba16float).
//
// File is named `.integration.test.ts`; it is added to the dawn project
// `include` array in the root vitest.config.ts so it runs under the dawn-node GPU
// env, and skips itself when navigator.gpu is absent (the per-package unit
// project) rather than failing.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { EquirectAsset } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveRenderDataCubemap } from '../../../render/src/render-data';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const gpu = globalThis.navigator?.gpu;
const hasGpu = gpu !== undefined;

const GUID_EQUI = 'c0000000-0000-4000-a000-000065717569';
const PACK_INDEX_URL = '/test-equirect-renderable-pack-index.json';

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

/** A deterministic WxH rgba16float (IEEE-754 binary16) HDR image. */
function makeHdrHalf(w: number, h: number): Uint8Array {
  // 0x3c00 = 1.0 in binary16; vary channels so the bytes are non-trivial.
  const px = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = 0x3c00;
    px[i * 4 + 1] = 0x3800; // 0.5
    px[i * 4 + 2] = 0x3400; // 0.25
    px[i * 4 + 3] = 0x3c00;
  }
  return new Uint8Array(px.buffer);
}

let bcCap = false;

describe.skipIf(!hasGpu)('equirect renderable-source integration (feat-20260707 fix)', () => {
  const width = 64;
  const height = 32;
  let binBytes: Uint8Array;
  const packageUrl = '/ddc/equirect.pack.json';
  const artifactUrl = '/ddc/equirect.bin';

  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: skipIf(!hasGpu) guards this
    const adapter = await gpu!.requestAdapter();
    if (adapter === null) throw new Error('no GPU adapter under dawn');
    bcCap = adapter.features.has('texture-compression-bc');
    // biome-ignore lint/suspicious/noConsole: keep the caps triple empirically visible in CI logs
    console.info(
      `[equirect caps] bc=${bcCap} etc2=${adapter.features.has(
        'texture-compression-etc2',
      )} astc=${adapter.features.has('texture-compression-astc')}`,
    );
    binBytes = makeHdrHalf(width, height);
  });

  function wireFetch(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return {
          ok: true,
          json: async () => [{ guid: GUID_EQUI, packageUrl, kind: 'equirect' }],
        } as Response;
      }
      if (url === packageUrl) {
        return {
          ok: true,
          json: async () => ({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID_EQUI,
                kind: 'equirect',
                payload: {
                  kind: 'equirect',
                  width,
                  height,
                  format: 'rgba16float',
                  colorSpace: 'linear',
                },
                refs: [],
                artifacts: {
                  body: {
                    path: 'equirect.bin',
                    mediaType: 'application/x-forgeax-rgba16f',
                  },
                },
              },
            ],
          }),
        } as Response;
      }
      if (url === artifactUrl) {
        return { ok: true, arrayBuffer: async () => binBytes.buffer } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof globalThis.fetch;
  }

  async function loadEquirect(): Promise<EquirectAsset> {
    wireFetch();
    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);
    reg.setTranscodeCaps({ bc: bcCap, etc2: false, astc: false });
    const res = await reg.loadByGuid<EquirectAsset>(parseGuid(GUID_EQUI));
    if (!res.ok) throw new Error(`equirect load failed: ${(res.error as { code: string }).code}`);
    return res.value;
  }

  it('equirect is uncompressed rgba16float regardless of bc cap (IBL render source)', async () => {
    const asset = await loadEquirect();
    expect(asset.kind).toBe('equirect');
    // Never a block-compressed format: an equirect drives cube RENDER passes and
    // BC6H is not color-renderable.
    expect(asset.format).toBe('rgba16float');
  });

  it('deriveRenderDataCubemap accepts the rgba16float equirect (renderable cube source)', async () => {
    const asset = await loadEquirect();
    // deriveRenderDataCubemap consumes a TextureAsset-shaped source; the equirect
    // POD mirrors that 2D surface.
    const source = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: asset.width, height: asset.height } },
      format: asset.format,
      data:
        asset.data instanceof Uint8ClampedArray
          ? new Uint8Array(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength)
          : asset.data,
      colorSpace: asset.colorSpace,
      mips: { kind: 'none' as const },
    };
    const res = deriveRenderDataCubemap(source);
    expect(res.ok).toBe(true);
  });
});
