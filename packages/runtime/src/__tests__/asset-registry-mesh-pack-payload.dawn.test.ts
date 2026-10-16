// asset-registry-mesh-pack-payload.dawn.test.ts - bug-20260523-mesh-upload-floats-per-vertex-fail-fast-and-cascadi
// M3 / t9 (dawn integration): pack deserialization non-12F mesh gate trigger.
//
// Exercises the catalog entrance point (catalog + parseAssetPayload)
// with a deliberately non-12F vertices payload. Verifies that the registerGate
// mesh-vertex-stride-mismatch gate fires in the dawn runtime context (dawn.node
// GPU device available), not just the node unit-test context.
//
// feat-20260614 M8 (D-17): the registry catalogues GUID -> payload via
// `catalog`, which returns Result and validates stride BEFORE storing; it
// never throws and never mints a handle.
//
// Cases covered:
// (a) catalog() non-12F mesh -> Result.err mesh-vertex-stride-mismatch
//     (dawn context; gate already exercised by t4 unit; dawn here adds
//     GPU device wiring awareness)
// (b) catalog() non-12F mesh -> Result.err with
//     code='mesh-vertex-stride-mismatch' (the loadByGuid entrance point;
//     parseAssetPayload produces the MeshAsset, catalog validates stride
//     before storing)
// (c) after catalog() returns err, lookup returns undefined
//     (AC-03 no-intermediate-state for GUID path)
// (d) AC-08 narrowing: read err.detail.floatsPerVertex off the Result.err
//
// Anchors: plan-strategy D-2 (catalog covered by gate);
//          plan-strategy D-4 (parseAssetPayload not front-loading check,
//            catalog gate is the enforcement point);
//          plan-strategy R-3 (pack-payload non-12F regression safety);
//          requirements AC-06 (cascading exhaustive);
//          charter P3 (structured failure: .code / .expected / .hint / .detail).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok } from '@forgeax/engine-rhi';
import type { EquirectAsset, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

// feat-20260601-device/gpu-residency-extraction M1: configureGpuDevice moved to
// GpuResidencyCache (D-3 registerCube relay). These tests exercise registry-side
// catalog + the stride gate; they wire the device onto the store
// to keep the dawn device-acquisition path covered.
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

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

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

const GUID_PACK_TEST = '00000000-0000-7000-8000-000000000033';

function makeNon12FAsset(): TypesMeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(9), // 3 verts * 3F position-only (not 12F)
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 0,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

describe('t9 - pack deserialization non-12F mesh gate trigger (dawn)', () => {
  it.skipIf(!dawnReady)(
    '(a) catalog() non-12F mesh returns mesh-vertex-stride-mismatch (dawn context with GPU device)',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const reg = new AssetRegistry(makeMockShaderRegistry());
      const gpuStore = new GpuResidencyCache();
      gpuStore.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (world: World, pod: EquirectAsset) => ok(world.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      const result = reg.catalog<TypesMeshAsset>(GUID_PACK_TEST, makeNon12FAsset());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        expect(result.error.expected).toContain('12 floats per vertex');
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(d.vertexCount).toBe(0);
        expect(d.floatsPerVertex).toBe(0.75); // 9 / 12
      }
    },
  );

  it('(b) catalog() non-12F mesh returns Result.err mesh-vertex-stride-mismatch', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    const result = reg.catalog<TypesMeshAsset>(guid, makeNon12FAsset());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
      const d = result.error.detail as { floatsPerVertex: number };
      expect(d.floatsPerVertex).toBe(0.75);
    }
  });

  it('(c) after catalog() returns err, lookup returns undefined (no intermediate state)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    const result = reg.catalog<TypesMeshAsset>(guid, makeNon12FAsset());
    expect(result.ok).toBe(false);

    // The stride gate fired before storing, so the GUID is not catalogued.
    expect(reg.lookup(guid)).toBeUndefined();
  });

  it('(d) AC-08 narrowing: read err.detail.floatsPerVertex off the Result.err', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_PACK_TEST);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;

    // vertices.length=11 (not divisible by 12) -> detail.floatsPerVertex = 11/12
    const nonDivisibleAsset: TypesMeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(11),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 0,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],

      materialSlots: [{ slotName: 'Default' }],
    };

    const result = reg.catalog<TypesMeshAsset>(guid, nonDivisibleAsset);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
      const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
      expect(typeof d.vertexCount).toBe('number');
      expect(typeof d.floatsPerVertex).toBe('number');
      expect(d.floatsPerVertex).not.toBe(12);
    }
  });

  it.skipIf(!dawnReady)(
    '(e) compliant 12F mesh catalog + loadByGuid in dawn context returns the payload',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const reg = new AssetRegistry(makeMockShaderRegistry());
      const gpuStore = new GpuResidencyCache();
      gpuStore.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (world: World, pod: EquirectAsset) => ok(world.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      const parseResult = AssetGuid.parse(GUID_PACK_TEST);
      if (!parseResult.ok) throw new Error('expected ok');
      const guid = parseResult.value;

      const validAsset: TypesMeshAsset = {
        kind: 'mesh',
        vertices: new Float32Array(36), // 3 verts * 12F
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],

        materialSlots: [{ slotName: 'Default' }],
      };
      reg.catalog<TypesMeshAsset>(guid, validAsset);

      const res = await reg.loadByGuid<TypesMeshAsset>(guid);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.kind).toBe('mesh');
    },
  );
});
