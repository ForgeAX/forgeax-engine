import type { Mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  selectHdrpPbrPrewarmVariants,
  selectPipelineLayoutForVariant,
  selectSkinPrewarmVariants,
} from '../assembly/factory';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';

describe('custom skinned mesh motion consumer contract', () => {
  it('keeps two animated palette payloads observable at the skin consumer', () => {
    const writes: Array<{ buffer: Buffer; offset: number; data: Float32Array }> = [];
    const device = {
      limits: { maxStorageBufferBindingSize: 65536 },
      createBuffer: () => ok({} as Buffer),
      queue: {
        writeBuffer(buffer: Buffer, offset: number, data: Float32Array) {
          writes.push({ buffer, offset, data: new Float32Array(data) });
          return ok(undefined);
        },
      },
    } as unknown as RhiDevice;
    const allocator = createSkinPaletteAllocator(device, 65536, true);
    const ibm = new Float32Array(16);
    ibm[0] = 1;
    ibm[5] = 1;
    ibm[10] = 1;
    ibm[15] = 1;
    const poseA = new Float32Array(ibm) as unknown as Mat4;
    const poseB = new Float32Array(ibm) as unknown as Mat4;
    poseB[12] = 0.5;
    const first = allocator.allocateSlice(1);
    allocator.writeJointPalette(first, [ibm], [poseA]);
    allocator.resetForFrame();
    const second = allocator.allocateSlice(1);
    allocator.writeJointPalette(second, [ibm], [poseB]);

    expect(writes).toHaveLength(2);
    expect(writes[0]?.buffer).toBe(writes[1]?.buffer);
    expect(writes[0]?.offset).toBe(writes[1]?.offset);
    expect(writes[0]?.data).not.toEqual(writes[1]?.data);
    expect(writes[1]?.data[12]).toBe(0.5);
  });

  it('keeps persistent uniform palettes isolated across frame-pool resets', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteAllocator(device, 65536, false);
    try {
      const first = allocator.allocatePersistentSlice({
        identity: 'world:1',
        generation: 1,
        jointCount: 1,
      });
      allocator.resetForFrame();
      const second = allocator.allocatePersistentSlice({
        identity: 'world:2',
        generation: 1,
        jointCount: 1,
      });
      expect(second.buffer).not.toBe(first.buffer);
      expect(
        allocator.allocatePersistentSlice({ identity: 'world:1', generation: 1, jointCount: 1 })
          .buffer,
      ).toBe(first.buffer);
    } finally {
      allocator.dispose();
    }
  });

  it('keeps recycled storage slices inside their dynamic binding windows', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const sizes = new Map<Buffer, number>();
    const createBuffer = device.createBuffer.bind(device);
    vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
      const result = createBuffer(descriptor);
      if (result.ok && descriptor.size !== undefined) sizes.set(result.value, descriptor.size);
      return result;
    });
    const allocator = createSkinPaletteAllocator(device, 65536, true);
    try {
      const full = allocator.allocatePersistentSlice({
        identity: 'world:full',
        generation: 1,
        jointCount: 255,
      });
      allocator.releasePersistentSlice('world:full');
      await device.queue.onSubmittedWorkDone();
      const first = allocator.allocatePersistentSlice({
        identity: 'world:first',
        generation: 1,
        jointCount: 1,
      });
      const second = allocator.allocatePersistentSlice({
        identity: 'world:second',
        generation: 1,
        jointCount: 1,
      });
      expect(first.byteOffset).toBe(full.byteOffset);
      expect(second.byteOffset).not.toBe(first.byteOffset);
      for (const slice of [first, second]) {
        const bufferSize = sizes.get(slice.buffer);
        if (bufferSize === undefined) throw new Error('palette buffer has no allocation size');
        expect(slice.byteOffset % 256).toBe(0);
        expect(slice.byteOffset + allocator.bindingWindowBytes).toBeLessThanOrEqual(bufferSize);
      }
    } finally {
      allocator.dispose();
    }
  });

  it('prepares both URP and HDRP pbr-skin consumers with the skin-cluster contract', () => {
    const variants = selectSkinPrewarmVariants(
      {
        identifier: 'forgeax::pbr-skin',
        sourcePath: 'default-standard-pbr-skin.wgsl',
        composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
        paramSchema: '[]',
        variants: [
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-urp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-hdrp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl:
              '@group(2) @binding(1) var<storage> palette: array<u32>; @group(2) @binding(4) var<storage> lights: array<u32>;',
          },
        ],
      },
      true,
    );
    expect(variants.map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    ]);
    expect(createMaterialShaderProgram(variants[1]?.composedWgsl ?? '').group2).toBe(
      'skin-cluster',
    );
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: 'hdrp' as never,
          pbrSkinPipelineLayout: 'skin-urp' as never,
          hdrpSkinPipelineLayout: 'skin-hdrp' as never,
        },
        variants[1]?.definesKey,
        'hdrp-skin',
      ),
    ).toBe('skin-hdrp');
  });

  it('warms only device-reachable skin variants while retaining all draw and reflection lanes', () => {
    const deviceAxes = [
      'EXTENDED_LIGHTING_AVAILABLE',
      'DIRECTIONAL_PCSS_AVAILABLE',
      'PROJECTOR_AVAILABLE',
    ] as const;
    const drawAxes = [
      'CLUSTER_FORWARD_AVAILABLE',
      'VERTEX_COLOR_AVAILABLE',
      'TRANSMISSION_AVAILABLE',
      'REFLECTION_FALLBACK_AVAILABLE',
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    ] as const;
    const axes = [...deviceAxes, ...drawAxes];
    const variants = Array.from({ length: 2 ** axes.length }, (_, bits) => ({
      definesKey: String(bits),
      composedWgsl: String(bits),
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        ...Object.fromEntries(axes.map((axis, bit) => [axis, (bits & (1 << bit)) !== 0])),
      },
    }));
    const entry = {
      identifier: 'forgeax::pbr-skin',
      sourcePath: 'skin.wgsl',
      composedWgsl: '',
      paramSchema: '[]',
      variants,
    };
    // A boot cannot know the scene's topology, color, material or SSR choices.
    // The dedicated non-clustered program does not cover all scene-index draws.
    const selected = selectSkinPrewarmVariants(entry, true, false, true, false, true);
    expect(selected).toHaveLength(32);
    for (const variant of selected) {
      expect(variant.defines).toMatchObject({
        EXTENDED_LIGHTING_AVAILABLE: false,
        DIRECTIONAL_PCSS_AVAILABLE: true,
        PROJECTOR_AVAILABLE: false,
      });
    }
    for (const axis of drawAxes) {
      expect(new Set(selected.map((variant) => variant.defines[axis]))).toEqual(
        new Set([false, true]),
      );
    }
    const lowTextureLimit = selectSkinPrewarmVariants(entry, true, false, true, false, false);
    expect(lowTextureLimit).toHaveLength(16);
    expect(
      lowTextureLimit.every((variant) => variant.defines.TRANSMISSION_AVAILABLE === false),
    ).toBe(true);
  });

  it('prewarms direct and clustered skin on WebGL2 without storage-backed PBR prewarming', () => {
    const variants = [
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'urp-uniform',
      },
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'hdrp-uniform',
      },
    ];
    const entry = {
      identifier: 'forgeax::default-standard-pbr-skin',
      sourcePath: 'default-standard-pbr-skin.wgsl',
      composedWgsl: 'default',
      paramSchema: '[]',
      variants,
    };

    expect(selectSkinPrewarmVariants(entry, false).map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false',
    ]);
    expect(selectHdrpPbrPrewarmVariants(entry, false, true)).toEqual([]);
  });
});
