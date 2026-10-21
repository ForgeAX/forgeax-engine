// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
} from '../../../render/src/render-data';

vi.mock('@forgeax/engine-rhi-wgpu', () => {
  return {
    rhi: {
      requestAdapter: async () => ({
        ok: false,
        error: {
          code: 'adapter-unavailable',
          expected: 'adapter available',
          hint: 'default mock fail',
        },
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
      acquireCanvasContext: () => ({
        ok: false,
        error: {
          code: 'webgpu-runtime-error',
          expected: 'context available',
          hint: 'default mock fail',
        },
      }),
    },
    ensureReady: async () => undefined,
  };
});
// Split source block: render data derivation contract.
{
  // --- from render-data.test.ts (__tests__/) ---
  const GPU_BUFFER_USAGE_VERTEX = 0x20;
  const GPU_BUFFER_USAGE_INDEX = 0x10;
  const GPU_BUFFER_USAGE_COPY_DST = 0x08;
  const TEXTURE_BINDING = 0x4;
  const COPY_SRC = 0x1;
  const COPY_DST = 0x2;
  const RENDER_ATTACHMENT = 0x10;

  function meshPod(overrides: Partial<MeshAsset> = {}): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(4 * 12),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      attributes: buildMeshAttributeMapForUvSets(1),
      aabb: new Float32Array(6),
      ...overrides,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 6,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    };
  }

  function texturePod(
    mipmap: boolean,
    format: GPUTextureFormat = 'rgba8unorm-srgb',
    width = 4,
    height = 4,
  ): TextureAsset {
    return {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height } },
      format,
      data: new Uint8Array(width * height * 4).fill(170),
      colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
      mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
    };
  }

  function equirectSource(
    format: GPUTextureFormat,
    colorSpace: 'srgb' | 'linear',
    width = 8,
    height = 4,
  ): TextureAsset {
    return {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height } },
      format,
      data: new Uint8Array(width * height * 8),
      colorSpace,
      mips: { kind: 'none' },
    };
  }

  describe('deriveRenderDataMesh', () => {
    it('derives vertex / index buffer descriptors from a mesh POD', () => {
      const res = deriveRenderDataMesh(meshPod());
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const rd = res.value;
      expect(rd.vertexByteLength).toBe(4 * 12 * 4); // 48 floats * 4 bytes
      // 6 uint16 indices = 12 bytes, padded up to 4-byte multiple = 12
      expect(rd.indexByteLength).toBe(12);
      expect(rd.indexCount).toBe(6);
      expect(rd.indexFormat).toBe('uint16');
      expect(rd.layoutProjection.arrayStride).toBe(48);
      expect(rd.layoutProjection.attributes.map((attribute) => attribute.key)).toEqual([
        'position',
        'normal',
        'uv',
        'tangent',
      ]);
      expect(rd.vertexUsage).toBe(GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST);
      expect(rd.indexUsage).toBe(GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST);
    });

    it('pads index byte length up to a 4-byte multiple and tags uint32', () => {
      // 3 uint32 indices = 12 bytes (already aligned), format uint32
      const res = deriveRenderDataMesh(meshPod({ indices: new Uint32Array([0, 1, 2]) }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.indexFormat).toBe('uint32');
      expect(res.value.indexCount).toBe(3);
      expect(res.value.indexByteLength).toBe(12);
    });

    it('rounds an odd uint16 index count up to the next 4-byte multiple', () => {
      // 5 uint16 = 10 bytes -> padded to 12
      const res = deriveRenderDataMesh(meshPod({ indices: new Uint16Array([0, 1, 2, 3, 4]) }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.indexByteLength).toBe(12);
      expect(res.value.indexCount).toBe(5);
    });
  });

  describe('deriveRenderDataTexture', () => {
    it('derives a single-level descriptor when mipmap is false', () => {
      const res = deriveRenderDataTexture(texturePod(false));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const rd = res.value;
      expect(rd.width).toBe(4);
      expect(rd.height).toBe(4);
      expect(rd.format).toBe('rgba8unorm-srgb');
      expect(rd.mipLevelCount).toBe(1);
      expect(rd.usage).toBe(TEXTURE_BINDING | COPY_SRC | COPY_DST | RENDER_ATTACHMENT);
      expect(rd.bytesPerRow).toBe(4 * 4);
    });

    it('computes mipLevelCount from dimensions when mipmap is true', () => {
      // 8x8 -> log2(8)+1 = 4 levels
      const res = deriveRenderDataTexture(texturePod(true, 'rgba8unorm-srgb', 8, 8));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.mipLevelCount).toBe(4);
    });

    it('asserts format <-> colorSpace consistency (srgb format requires srgb colorSpace)', () => {
      const bad: TextureAsset = { ...texturePod(false, 'rgba8unorm-srgb'), colorSpace: 'linear' };
      const res = deriveRenderDataTexture(bad);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('invalid-source-format');
    });

    it('accepts a linear format with linear colorSpace', () => {
      const res = deriveRenderDataTexture(texturePod(false, 'rgba8unorm'));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.format).toBe('rgba8unorm');
    });

    it('derives the row pitch from an rgba16float source payload', () => {
      const source = texturePod(false, 'rgba16float');
      const res = deriveRenderDataTexture({
        ...source,
        data: new Uint8Array(source.shape.extent.width * source.shape.extent.height * 8),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.bytesPerRow).toBe(source.shape.extent.width * 8);
    });

    it('derives row pitch from format when an rgba8 decoder retains trailing bytes', () => {
      const source = texturePod(false, 'rgba8unorm');
      const res = deriveRenderDataTexture({
        ...source,
        data: new Uint8Array(
          source.shape.extent.width * source.shape.extent.height * 4 + source.shape.extent.width,
        ),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.bytesPerRow).toBe(source.shape.extent.width * 4);
    });

    it('derives the row pitch from an rgba32float source payload', () => {
      const source = texturePod(false, 'rgba32float');
      const res = deriveRenderDataTexture({
        ...source,
        data: new Uint8Array(source.shape.extent.width * source.shape.extent.height * 16),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.bytesPerRow).toBe(source.shape.extent.width * 16);
    });

    it('rejects an uncompressed payload shorter than its base mip', () => {
      const source = texturePod(false, 'rgba16float');
      const res = deriveRenderDataTexture({ ...source, data: new Uint8Array(1) });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('invalid-source-format');
    });
  });

  describe('deriveRenderDataCubemap', () => {
    it('derives cubeFaceSize + output format from a valid rgba16float equirect source', () => {
      const res = deriveRenderDataCubemap(equirectSource('rgba16float', 'linear', 8, 4));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const rd = res.value;
      expect(rd.cubeFaceSize).toBe(4); // == source height
      expect(rd.outputFormat).toBe('rgba16float');
      expect(rd.needsHalfConversion).toBe(false);
      expect(rd.cubeUsage).toBe(TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT | 0x1);
    });

    it('flags rgba32float -> rgba16float conversion and narrows the output format', () => {
      const res = deriveRenderDataCubemap(equirectSource('rgba32float', 'linear', 8, 4));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outputFormat).toBe('rgba16float');
      expect(res.value.needsHalfConversion).toBe(true);
    });

    it('rejects a non-float / non-linear source with invalid-source-format', () => {
      const res = deriveRenderDataCubemap(equirectSource('rgba8unorm', 'linear', 8, 4));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('invalid-source-format');
    });

    it('rejects an rgba16float source whose colorSpace is not linear', () => {
      const res = deriveRenderDataCubemap(equirectSource('rgba16float', 'srgb', 8, 4));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('invalid-source-format');
    });

    it('the cube POD it implies is square (width === height === cubeFaceSize)', () => {
      const res = deriveRenderDataCubemap(equirectSource('rgba16float', 'linear', 16, 8));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const cube: CubeTextureAsset = {
        kind: 'cube-texture',
        width: res.value.cubeFaceSize,
        height: res.value.cubeFaceSize,
        format: res.value.outputFormat,
        faces: [],
      };
      expect(cube.width).toBe(cube.height);
      expect(cube.width).toBe(8);
    });
  });
}
