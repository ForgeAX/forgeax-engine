import type { ShaderReflectionBoundGlobal } from '@forgeax/engine-naga';
import { expect, it } from 'vitest';
import type { CompileResult } from '../../compile';
import type { MaterialCookedPass } from '../cook';
import { cookStaticShadow, OPAQUE_SWITCHES } from './standard-static-shadow.fixture';

const SIZE = 32;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
type Coverage = 'opaque' | 'local' | 'view' | 'lod' | 'mask';

async function depth(
  device: GPUDevice,
  cooked: MaterialCookedPass,
  scene: boolean,
  coverage: Coverage,
): Promise<Float32Array> {
  const compiled = scene ? cooked.sceneCompile : cooked.compile;
  if (compiled === undefined) throw new Error('missing scene-index program');
  const resources: { destroy(): void }[] = [];
  const buffer = (data: Float32Array | Uint32Array, usage: number) => {
    const result = device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(result, 0, data);
    resources.push(result);
    return result;
  };
  const rowTransform = (row: number) => {
    const matrix = [...IDENTITY];
    matrix[0] = 0.5;
    matrix[12] = row === 0 ? -0.5 : 0.5;
    matrix[14] = row === 0 ? 0.25 : 0.75;
    return matrix;
  };
  const upload = (global: ShaderReflectionBoundGlobal, directRow: number) => {
    const name = global.name ?? '';
    const rows = name.startsWith('sceneTransforms')
      ? 3
      : name.startsWith('scene') || name === 'visibleItems' || name.startsWith('instances')
        ? 2
        : 1;
    const stride = global.elementStride ?? global.span ?? 16;
    const data = new Float32Array(Math.max(16, stride * rows) / 4);
    const uint = new Uint32Array(data.buffer);
    const member = (field: string, values: readonly number[], row = 0) => {
      const entry = global.members?.find((candidate) => candidate.name === field);
      if (entry === undefined) throw new Error(`missing ${name}.${field}`);
      data.set(values, (entry.offset + row * stride) / 4);
    };
    if (name.startsWith('view')) {
      member('lightViewProj_A', IDENTITY);
      member('cameraPos', [0, 0, 3]);
      if (coverage === 'view') {
        member('clippingPlanes', [0, 1, 0, 0]);
        member('clippingControl', [1, 0, 1, 0]);
      }
    } else if (name.startsWith('sceneTransforms')) {
      data.set(IDENTITY);
      data.set(rowTransform(0), stride / 4);
      data.set(rowTransform(1), stride / 2);
    } else if (name.startsWith('sceneInstances')) {
      uint.set([0, 0, 0, 0, 1, 0, 0, 0]);
    } else if (name.startsWith('scenePrimitives')) {
      for (let row = 0; row < 2; row++) uint[(row * stride) / 4 + 2] = row + 1;
    } else if (name === 'visibleItems') {
      const materialStride = compiled.reflection.boundGlobals.find(
        (entry) => entry.name === 'sceneMaterials',
      )?.elementStride;
      if (materialStride === undefined) throw new Error('missing scene material stride');
      uint.set([0, 0, 0, 0, 1, materialStride / 16, 0, 0]);
      if (coverage === 'lod') {
        data[3] = 0.5;
        data[7] = -0.5;
      }
    } else if (name.startsWith('meshes')) {
      data.set(IDENTITY);
    } else if (name.startsWith('instances')) {
      data.set(rowTransform(0));
      data.set(rowTransform(1), stride / 4);
    } else if (name === 'material' || name === 'sceneMaterials') {
      for (let row = 0; row < rows; row++) {
        const selected = scene ? row : directRow;
        member('baseColor', [1, 0.5, 0.25, selected === 0 ? 0.2 : 1], row);
        if (coverage === 'mask') member('alphaCutoff', [0.5], row);
        for (const entry of global.members ?? []) {
          if (
            entry.name.endsWith('CoordinatesTransform') ||
            entry.name.endsWith('CoordinatesMetadata')
          )
            member(entry.name, [0, 0, 1, 1], row);
          if (entry.name.endsWith('CoordinatesRotation')) member(entry.name, [1, 0, 0, 0], row);
        }
        if (coverage === 'local') {
          member('clippingControl', [1, 0, 1, 0], row);
          member('clippingPlaneA', [selected === 0 ? -1 : 1, 0, 0, -0.5], row);
        }
      }
    }
    return buffer(
      data,
      global.addressSpace === 'uniform' ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE,
    );
  };

  try {
    const module = device.createShaderModule({ code: compiled.wgsl });
    await validModule(module);
    const layouts = compiled.bindings.map((layout) =>
      device.createBindGroupLayout({
        entries: layout.entries.filter(
          (entry) => entry.visibility !== 0,
        ) as GPUBindGroupLayoutEntry[],
      }),
    );
    const vertices = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
    let vertexStride = 0;
    const attributes = cooked.abi.vertexInputs.map((input) => {
      const lanes = input.format === 'float32x3' ? 3 : input.format === 'float32x4' ? 4 : 2;
      const attribute = {
        shaderLocation: input.location,
        offset: vertexStride * 4,
        format: input.format as GPUVertexFormat,
      };
      vertexStride += lanes;
      return attribute;
    });
    const data = new Float32Array(6 * vertexStride);
    for (let vertex = 0; vertex < 6; vertex++) {
      const x = vertices[vertex * 2] ?? 0;
      const y = vertices[vertex * 2 + 1] ?? 0;
      for (let slot = 0; slot < attributes.length; slot++) {
        const input = cooked.abi.vertexInputs[slot];
        const attribute = attributes[slot];
        if (input === undefined || attribute === undefined) throw new Error('missing vertex input');
        data.set(
          input.semantic === 'position'
            ? [x, y, 0]
            : input.semantic === 'normal'
              ? [0, 0, 1]
              : input.semantic === 'tangent'
                ? [1, 0, 0, 1]
                : [(x + 1) / 2, (y + 1) / 2],
          vertex * vertexStride + attribute.offset / 4,
        );
      }
    }
    const vertexBuffer = buffer(data, GPUBufferUsage.VERTEX);
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: scene ? 'vs_scene_index' : 'vs_main',
        buffers: [{ arrayStride: vertexStride * 4, attributes }],
      },
      fragment: { module, entryPoint: 'fs_shadow', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const texture = device.createTexture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    resources.push(texture);
    device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]),
      { bytesPerRow: 8 },
      [2, 2],
    );
    const globals = compiled.reflection.boundGlobals;
    const groups = Array.from({ length: scene ? 1 : 2 }, (_, row) =>
      layouts.map((layout, group) =>
        device.createBindGroup({
          layout,
          entries: globals
            .filter((global) => global.group === group && global.visibility !== 0)
            .map((global) => ({
              binding: global.binding,
              resource:
                global.resourceKind === 'sampler'
                  ? device.createSampler()
                  : global.resourceKind === 'texture'
                    ? texture.createView()
                    : { buffer: upload(global, row) },
            })),
        }),
      ),
    );
    const target = device.createTexture({
      size: [SIZE, SIZE],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    resources.push(target);
    const readback = device.createBuffer({
      size: 256 * SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    resources.push(readback);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: target.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    for (let row = 0; row < groups.length; row++) {
      groups[row]?.forEach((group, slot) => {
        pass.setBindGroup(slot, group);
      });
      pass.draw(6, scene ? 2 : 1, 0, row);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target, aspect: 'depth-only' },
      { buffer: readback, bytesPerRow: 256 },
      [SIZE, SIZE],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const padded = new Float32Array(readback.getMappedRange());
    const result = new Float32Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row++)
      result.set(padded.subarray(row * 64, row * 64 + SIZE), row * SIZE);
    readback.unmap();
    return result;
  } finally {
    for (const resource of resources) resource.destroy();
  }
}

async function validModule(module: GPUShaderModule) {
  const info = await module.getCompilationInfo();
  expect(
    info.messages.filter((message) => message.type === 'error').map((message) => message.message),
  ).toEqual([]);
}

it('preserves real Standard shadow depth, two scene material rows, clipping and LOD coverage', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const candidate = await cookStaticShadow();
    const reference = await cookStaticShadow({
      staticSwitches: { ...OPAQUE_SWITCHES, alphaClipping: true },
    });
    for (const scene of [false, true]) {
      for (const coverage of ['opaque', 'local', 'view', ...(scene ? ['lod'] : [])] as Coverage[]) {
        const expected = await depth(device, reference.shadow, scene, coverage);
        const actual = await depth(device, candidate.shadow, scene, coverage);
        expect(actual, `${scene ? 'scene' : 'direct'} ${coverage}`).toEqual(expected);
        const written = actual.filter((value) => value < 1).length;
        expect(written).toBeGreaterThan(0);
        expect(actual).toContain(0.25);
        expect(actual).toContain(0.75);
        if (coverage === 'opaque') expect(written).toBe(SIZE * SIZE);
        else expect(written).toBeLessThan(SIZE * SIZE);
      }
      const masked = await depth(device, reference.shadow, scene, 'mask');
      expect(masked).not.toContain(0.25);
      expect(masked).toContain(0.75);
      expect(masked.filter((value) => value < 1)).toHaveLength((SIZE * SIZE) / 4);
    }
    for (const options of [
      { context: { geometry: 'skinned' as const } },
      { custom: true },
      { normalMapped: true },
      { context: { capability: 'uniform-fallback' as const } },
    ]) {
      const cooked = await cookStaticShadow(options);
      for (const compiled of [
        cooked.shadow.compile,
        cooked.shadow.sceneCompile,
        ...('normalMapped' in options ? [cooked.forward.compile, cooked.forward.sceneCompile] : []),
      ].filter((value): value is CompileResult => value !== undefined))
        await validModule(device.createShaderModule({ code: compiled.wgsl }));
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    device.destroy();
  }
}, 60_000);
