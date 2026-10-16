import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFrameState } from '../record/frame-snapshot';
import { uploadMaterialUniforms } from '../record/material-uniforms';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';

describe('material upload storage', () => {
  it('reuses storage across frames and restores bytes after an intervening capture context', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device
      .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 8, usage: 0x48 })
      .unwrap();
    const writes: Uint8Array[] = [];
    const nativeWrite = device.queue.writeBuffer.bind(device.queue);
    const write = vi
      .spyOn(device.queue, 'writeBuffer')
      .mockImplementation((target, offset, data, ...rest) => {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const start = rest[0] ?? 0;
        writes.push(bytes.slice(start, start + (rest[1] ?? bytes.byteLength - start)));
        return nativeWrite(target, offset, data, ...rest);
      });
    const frameState = {} as RenderFrameState;
    let reads = 0;
    const tint = [1, 0, 0, 1];
    const red: MaterialSnapshot = {
      baseColor: vec3.create(1, 0, 0),
      metallic: 0,
      roughness: 0.5,
      materialParamSchema: [{ name: 'tint', type: 'vec4' }],
      paramSnapshot: {
        get tint() {
          reads++;
          return tint;
        },
      },
    };
    const green: MaterialSnapshot = { ...red, paramSnapshot: { tint: [0, 1, 0, 1] } };
    const context = (material: MaterialSnapshot, count = 1) =>
      ({
        runtime: { device },
        frameState,
        materialSlotCount: count,
        materialSlots: Array(count).fill(material),
        materialSlotOwners: Array.from({ length: count }, (_, renderableIndex) => ({
          renderableIndex,
        })),
        validatedOrdered: [],
        pipelineState: { materialUniformBuffer: { buffer } },
      }) as unknown as _InternalRenderPipelineContext;
    try {
      const a = context(red);
      uploadMaterialUniforms(a);
      expect(reads).toBe(1);
      expect(writes).toHaveLength(1);
      uploadMaterialUniforms(a);
      expect(writes).toHaveLength(1);
      expect(reads).toBe(1);
      expect(frameState.materialUboPayloadCache).toBeDefined(); // Explicit ABI values are written once, without a second overlay.
      const storage = frameState.materialUboPayloadCache?.payload.buffer;
      const b = context(green);
      uploadMaterialUniforms(b);
      expect(writes).toHaveLength(2);
      expect(frameState.materialUboPayloadCache?.payload.buffer).toBe(storage);
      uploadMaterialUniforms(a);
      expect(writes).toHaveLength(3);
      expect(new Float32Array(writes.at(-1)?.buffer ?? new ArrayBuffer(0))[0]).toBe(1);
      const replacement = device
        .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 8, usage: 0x48 })
        .unwrap();
      try {
        const replaced = {
          ...a,
          pipelineState: {
            ...a.pipelineState,
            materialUniformBuffer: {
              buffer: replacement,
              sizeInBytes: MATERIAL_PER_ENTITY_STRIDE * 8,
            },
          },
        };
        uploadMaterialUniforms(replaced);
        expect(writes).toHaveLength(4);
        uploadMaterialUniforms(replaced);
        expect(writes).toHaveLength(4);
        uploadMaterialUniforms(a);
        expect(writes).toHaveLength(4);
      } finally {
        device.destroyBuffer(replacement).unwrap();
      }
      tint[0] = 0.25;
      uploadMaterialUniforms(context(red));
      expect(new Float32Array(writes.at(-1)?.buffer ?? new ArrayBuffer(0))[0]).toBe(0.25);
      expect(frameState.materialUboPayloadCache?.payload.buffer).toBe(storage);
      uploadMaterialUniforms(context(green, 3));
      const grown = frameState.materialUboPayloadCache?.payload.buffer;
      expect(grown).not.toBe(storage);
      uploadMaterialUniforms(context(red));
      expect(frameState.materialUboPayloadCache?.payload.buffer).toBe(grown);
      expect(writes.at(-1)?.byteLength).toBe(MATERIAL_PER_ENTITY_STRIDE);
    } finally {
      write.mockRestore();
      device.destroyBuffer(buffer).unwrap();
    }
  });
  it('skips repeated page uploads and invalidates when the physical page roster grows', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffers = Array.from({ length: 3 }, () =>
      device.createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE, usage: 0x48 }).unwrap(),
    );
    const write = vi.spyOn(device.queue, 'writeBuffer');
    const material: MaterialSnapshot = {
      baseColor: vec3.create(1, 0, 0),
      metallic: 0,
      roughness: 0.5,
    };
    const storage = {
      buffer: null,
      sizeInBytes: MATERIAL_PER_ENTITY_STRIDE * 2,
      pages: {
        byteStride: MATERIAL_PER_ENTITY_STRIDE,
        byteSize: MATERIAL_PER_ENTITY_STRIDE,
        buffers: buffers.slice(0, 2),
      },
    };
    const context = {
      runtime: { device },
      frameState: {},
      materialSlotCount: 2,
      materialSlots: [material, material],
      materialSlotOwners: [{ renderableIndex: 0 }, { renderableIndex: 1 }],
      validatedOrdered: [],
      pipelineState: { materialUniformBuffer: storage },
    } as unknown as _InternalRenderPipelineContext;
    try {
      uploadMaterialUniforms(context);
      expect(write.mock.calls.map((call) => call[0])).toEqual(buffers.slice(0, 2));
      uploadMaterialUniforms(context);
      expect(write).toHaveBeenCalledTimes(2);
      storage.pages = { ...storage.pages, buffers: [...buffers] };
      uploadMaterialUniforms(context);
      expect(write).toHaveBeenCalledTimes(4);
      uploadMaterialUniforms(context);
      expect(write).toHaveBeenCalledTimes(4);
    } finally {
      write.mockRestore();
      for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    }
  });
  it('skips equal cross-frame bytes, uploads a coalesced changed slot and observes mutable values', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device
      .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 4, usage: 0x48 })
      .unwrap();
    const write = vi.spyOn(device.queue, 'writeBuffer');
    const frameState = {} as RenderFrameState;
    const red: MaterialSnapshot = {
      materialParamSchema: [
        { name: 'baseColor', type: 'vec4' },
        { name: 'roughness', type: 'f32' },
        { name: 'metallic', type: 'f32' },
      ],
      baseColor: vec3.create(1, 0, 0),
      metallic: 0,
      roughness: 0.5,
    };
    const green: MaterialSnapshot = { ...red, baseColor: vec3.create(0, 1, 0) };
    const context = (materials: MaterialSnapshot[], state = frameState) =>
      ({
        runtime: { device },
        frameState: state,
        materialSlots: materials,
        materialSlotCount: materials.length,
        materialSlotOwners: materials.map((_, renderableIndex) => ({ renderableIndex })),
        validatedOrdered: [],
        pipelineState: { materialUniformBuffer: { buffer } },
      }) as unknown as _InternalRenderPipelineContext;
    try {
      uploadMaterialUniforms(context([red, red, red]));
      uploadMaterialUniforms(context([red, red, red]));
      expect(write).toHaveBeenCalledTimes(1);
      uploadMaterialUniforms(context([red, green, red]));
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1]?.[1]).toBe(MATERIAL_PER_ENTITY_STRIDE);
      expect(write.mock.calls[1]?.[4]).toBe(MATERIAL_PER_ENTITY_STRIDE);
      red.baseColor[0] = 0.25;
      uploadMaterialUniforms(context([red, green, red]));
      expect(write).toHaveBeenCalledTimes(3);
      expect(write.mock.calls[2]?.[4]).toBe(MATERIAL_PER_ENTITY_STRIDE * 3);
      // A second view writes the same allocation. The first view must restore it.
      uploadMaterialUniforms(context([green, green, green], {} as RenderFrameState));
      uploadMaterialUniforms(context([red, green, red]));
      expect(write).toHaveBeenCalledTimes(5);
      expect(write.mock.calls[4]?.[1]).toBe(0);
      expect(write.mock.calls[4]?.[4]).toBe(MATERIAL_PER_ENTITY_STRIDE * 3);
      uploadMaterialUniforms(context([green, red, red]));
      expect(write).toHaveBeenCalledTimes(6);
      expect(write.mock.calls[5]?.[4]).toBe(MATERIAL_PER_ENTITY_STRIDE * 2);
    } finally {
      write.mockRestore();
      device.destroyBuffer(buffer).unwrap();
    }
  });

  it('reuses producer-owned immutable packing but still repacks ordinary mutable snapshots', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE, usage: 0x48 }).unwrap();
    let reads = 0;
    const material: MaterialSnapshot = {
      immutableValues: true,
      baseColor: vec3.create(1, 0, 0),
      metallic: 0,
      roughness: 0.5,
      materialParamSchema: [{ name: 'tint', type: 'vec4' }],
      paramSnapshot: {
        get tint() {
          reads++;
          return [1, 0, 0, 1];
        },
      },
    };
    const frameState = {} as RenderFrameState;
    const context = (mat: MaterialSnapshot) =>
      ({
        runtime: { device },
        frameState,
        materialSlotCount: 1,
        materialSlots: [mat],
        materialSlotOwners: [{ renderableIndex: 0 }],
        validatedOrdered: [],
        pipelineState: { materialUniformBuffer: { buffer } },
      }) as unknown as _InternalRenderPipelineContext;
    const write = vi.spyOn(device.queue, 'writeBuffer');
    try {
      uploadMaterialUniforms(context(material));
      uploadMaterialUniforms(context(material));
      uploadMaterialUniforms(context(material));
      expect(reads).toBe(2);
      expect(write).toHaveBeenCalledTimes(1);
      const { immutableValues: _, ...mutable } = material;
      uploadMaterialUniforms(context(mutable));
      uploadMaterialUniforms(context(mutable));
      expect(reads).toBe(4);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      device.destroyBuffer(buffer).unwrap();
    }
  });
  it('compares current texture coordinate words even when immutable material values are cached', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE, usage: 0x48 }).unwrap();
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'color', type: 'vec4' },
      { name: 'albedo', type: 'texture2d' },
    ];
    const offset = [0, 0] as [number, number];
    const material: MaterialSnapshot = {
      immutableValues: true,
      baseColor: vec3.create(1, 0, 0),
      roughness: 0.5,
      metallic: 0,
      materialParamSchema: schema,
      paramSnapshot: { color: [1, 0, 0, 1] },
      textureCoordinates: new Map([['albedo', { transform: { offset } }]]),
    };
    const frameState = {} as RenderFrameState;
    const context = () =>
      ({
        runtime: { device },
        frameState,
        materialSlotCount: 1,
        materialSlots: [material],
        materialSlotOwners: [{ renderableIndex: 0 }],
        validatedOrdered: [],
        pipelineState: { materialUniformBuffer: { buffer } },
      }) as unknown as _InternalRenderPipelineContext;
    const write = vi.spyOn(device.queue, 'writeBuffer');
    try {
      uploadMaterialUniforms(context());
      uploadMaterialUniforms(context());
      uploadMaterialUniforms(context());
      expect(write).toHaveBeenCalledTimes(1);
      offset[0] = 0.25;
      uploadMaterialUniforms(context());
      expect(write).toHaveBeenCalledTimes(2);
      const record = derive(schema, STANDARD_PIPELINE_PARAM_SCHEMA).coordinateRecords[0];
      expect(record).toBeDefined();
      expect(
        new Float32Array(frameState.materialUboPayloadCache?.payload.buffer ?? new ArrayBuffer(0))[
          (record?.offset ?? -4) / 4
        ],
      ).toBe(0.25);
      // Changing the ABI must clear bytes written by fields removed from the new contract.
      const replacement = {
        ...material,
        materialParamSchema: [{ name: 'color', type: 'vec4' }] as readonly ParamSchemaEntry[],
        textureCoordinates: undefined,
      };
      uploadMaterialUniforms({
        ...context(),
        materialSlots: [replacement],
      } as _InternalRenderPipelineContext);
      expect(write).toHaveBeenCalledTimes(3);
      expect(
        new Float32Array(frameState.materialUboPayloadCache?.payload.buffer ?? new ArrayBuffer(0))[
          (record?.offset ?? -4) / 4
        ],
      ).toBe(0);
    } finally {
      write.mockRestore();
      device.destroyBuffer(buffer).unwrap();
    }
  });
  it('invalidates byte coverage when an unadmitted schema changes on the same array', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE, usage: 0x48 }).unwrap();
    const schema: ParamSchemaEntry[] = [
      { name: 'keep', type: 'vec4' },
      { name: 'old', type: 'f32' },
    ];
    const material: MaterialSnapshot = {
      baseColor: vec3.create(1, 0, 0),
      metallic: 0,
      roughness: 0.5,
      materialParamSchema: schema,
      paramSnapshot: { keep: [1, 0, 0, 1], old: 7, next: 9 },
    };
    const frameState = {} as RenderFrameState;
    const context = () =>
      ({
        runtime: { device },
        frameState,
        materialSlotCount: 1,
        materialSlots: [material],
        materialSlotOwners: [{ renderableIndex: 0 }],
        validatedOrdered: [],
        pipelineState: { materialUniformBuffer: { buffer } },
      }) as unknown as _InternalRenderPipelineContext;
    const write = vi.spyOn(device.queue, 'writeBuffer');
    try {
      uploadMaterialUniforms(context());
      uploadMaterialUniforms(context());
      expect(write).toHaveBeenCalledTimes(1);
      schema[1] = { name: 'next', type: 'f32' };
      uploadMaterialUniforms(context());
      expect(write).toHaveBeenCalledTimes(2);
      expect(
        new Float32Array(
          frameState.materialUboPayloadCache?.payload.buffer ?? new ArrayBuffer(0),
        )[4],
      ).toBe(9);
      schema.splice(1, 1);
      uploadMaterialUniforms(context());
      expect(write).toHaveBeenCalledTimes(3);
      expect(
        new Float32Array(
          frameState.materialUboPayloadCache?.payload.buffer ?? new ArrayBuffer(0),
        )[4],
      ).toBe(0);
    } finally {
      write.mockRestore();
      device.destroyBuffer(buffer).unwrap();
    }
  });
});
