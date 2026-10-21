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

import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { equirectContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { EquirectAsset } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveRenderDataCubemap } from '../../../render/src/render-data';

const gpu = globalThis.navigator?.gpu;
const hasGpu = gpu !== undefined;

const GUID_EQUI = 'c0000000-0000-4000-a000-000065717569';

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
  const packageUrl = 'https://equirect.invalid/equirect.pack.json';
  const artifactUrl = 'https://equirect.invalid/equirect.bin';

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

  async function loadEquirect(): Promise<EquirectAsset> {
    const reg = new AssetRegistry();
    reg.installDecoder(equirectContribution.kind, equirectContribution.decoder);
    const sourcePath = 'equirect.pack.ts';
    const digest = `sha256:${Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(binBytes))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    const publication = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath,
      sourceRevision: 'fixture',
      packageUrl,
      pack: {
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
                contentEncoding: 'identity',
                byteLength: binBytes.byteLength,
                integrity: { algorithm: 'sha256', digest },
              },
            },
          },
        ],
      },
    });
    reg.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid: GUID_EQUI,
            kind: 'equirect',
            sourcePath,
            packageUrl,
            publication: publication.publication,
          },
        ],
        fetch: async (input) => {
          const url = String(input);
          if (url === packageUrl) return new Response(JSON.stringify(publication.pack));
          if (url === artifactUrl) return new Response(new Uint8Array(binBytes));
          return new Response('', { status: 404 });
        },
      }),
    );
    reg.setTranscodeCaps({ bc: bcCap, etc2: false, astc: false });
    try {
      const handle = (await reg.load(GUID_EQUI, 'equirect')).unwrap();
      const asset = reg.read(handle).unwrap();
      reg.release(handle).unwrap();
      return asset;
    } finally {
      reg.dispose();
    }
  }

  it('equirect is uncompressed rgba16float regardless of bc cap (IBL render source)', async () => {
    const asset = await loadEquirect();
    expect(asset.kind).toBe('equirect');
    // Never a block-compressed format: an equirect drives cube RENDER passes and
    // BC6H is not color-renderable.
    expect(asset.format).toBe('rgba16float');
    expect(asset.data).toEqual(binBytes);
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
