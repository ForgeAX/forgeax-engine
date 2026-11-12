import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { encodeKtx2Native } from '@forgeax/engine-codec/encode';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { STANDARD_OBJECT_SPACE_NORMAL_BIT } from '@forgeax/engine-shader';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import { observeMaterialResidency } from '../render-system-residency';

const BC5_BLOCK = new Uint8Array([200, 100, 0x02, 0, 0, 0, 0, 0, 10, 20, 0x3e, 0, 0, 0, 0, 0]);
const shape = { viewDimension: '2d', extent: { width: 4, height: 4 } } as const;

async function bc5Source(): Promise<TextureAsset> {
  const encoded = await encodeKtx2Native({
    format: 'bc5-rg-unorm',
    width: 4,
    height: 4,
    levels: [BC5_BLOCK],
  });
  if (!encoded.ok) throw new Error(encoded.error.code);
  const data = encoded.value;
  return {
    kind: 'texture',
    format: 'bc5-rg-unorm',
    colorSpace: 'linear',
    shape,
    mips: { kind: 'none' },
    data,
    encoding: 'ktx2',
  };
}

async function setup(bc: boolean) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, { ...device.caps, textureCompressionBc: bc });
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const resident = async (texture: TextureAsset) => {
    const handle = assets.create(texture).unwrap();
    const pod = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
    store.ensureResident(handle, pod(), scope);
    await store.waitTextureData(handle, scope);
    return { handle, result: store.ensureResident(handle, pod(), scope) };
  };
  const dispose = () => {
    store.destroyAll();
    assets.dispose();
  };
  return { store, scope, resident, dispose };
}

it.each([
  [true, 'bc5-rg-unorm', 16],
  [false, 'rg8unorm', 32],
] as const)('derives a BC5 KTX2 source per device (BC=%s) -> %s', async (bc, format, bytes) => {
  const { resident, dispose } = await setup(bc);
  try {
    const { result } = await resident(await bc5Source());
    expect(result.unwrap().receipt).toMatchObject({ format, bytes, mipLevelCount: 1 });
  } finally {
    dispose();
  }
});

it('returns device-unsupported for native BC texels on a device without BC', async () => {
  const native: TextureAsset = {
    kind: 'texture',
    format: 'bc5-rg-unorm',
    colorSpace: 'linear',
    shape,
    mips: { kind: 'none' },
    data: BC5_BLOCK.slice(),
  };
  const absent = await setup(false);
  try {
    expect((await absent.resident(native)).result).toMatchObject({
      ok: false,
      error: {
        code: 'device-unsupported',
        detail: {
          field: 'format',
          value: 'bc5-rg-unorm',
          reason: 'texture-compression-bc-unavailable',
        },
      },
    });
  } finally {
    absent.dispose();
  }
  const present = await setup(true);
  try {
    expect((await present.resident(native)).result.unwrap().receipt.format).toBe('bc5-rg-unorm');
  } finally {
    present.dispose();
  }
});

it.each([
  ['native rg8unorm', false],
  ['BC5 KTX2 derived as BC5', true],
  ['BC5 KTX2 derived as RG8', false],
] as const)('rejects object-space normals on an RG-only %s texture', async (name, bc) => {
  const { store, scope, resident, dispose } = await setup(bc);
  try {
    const texture: TextureAsset = name.startsWith('native')
      ? {
          kind: 'texture',
          format: 'rg8unorm',
          colorSpace: 'linear',
          shape,
          mips: { kind: 'none' },
          data: new Uint8Array(32).fill(128),
        }
      : await bc5Source();
    const { handle, result } = await resident(texture);
    expect(result.ok).toBe(true);
    const internals = { gpuStore: store } as unknown as RenderSystemInternals;
    const material = (mask: number): MaterialSnapshot => ({
      ...defaultMaterialSnapshot(),
      normalTexture: handle as AssetHandle<'texture'>,
      standardTextureMask: mask,
    });
    expect(observeMaterialResidency(scope, material(0), internals).readiness).toBe('ready');
    expect(
      observeMaterialResidency(scope, material(STANDARD_OBJECT_SPACE_NORMAL_BIT), internals),
    ).toMatchObject({
      readiness: 'failed',
      preparationFailure: {
        code: 'asset-invalid-value',
        detail: { field: 'normalMapSpace', reason: 'normal-texture-lacks-blue' },
      },
    });
  } finally {
    dispose();
  }
});
