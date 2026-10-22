import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { directDfgLutBytes } from '../../../shader/src/direct-dfg-lut-data';
import { cookMaterialAsset } from '../../../shader-compiler/src/material/cook';
import { collectMaterialSources } from '../../../shader-compiler/src/material/pack-cooker';
import { buildMaterialSourceCatalog } from '../../../shader-compiler/src/material/source-catalog';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import {
  type AssetGuid,
  type MaterialAsset,
  standardSurfaceParameters,
} from '../../../types/src/index';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { packMaterialProgramRow } from '../material-row';
import type { MaterialSnapshot } from '../render-system-extract';

const engine = fileURLToPath(new URL('../../../shader/src/', import.meta.url));
const width = 32;
const height = 16;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

it.each([
  ['mesh', false],
  ['mesh', true],
  ['skinned', false],
  ['skinned', true],
] as const)(
  'selects each scene material DFG mode in Forward and GBuffer (%s, transmission=%s)',
  async (geometry, transmission) => {
    const sources = buildMaterialSourceCatalog(
      await collectMaterialSources([engine], [engine]),
    ).unwrap();
    const table: Record<string, MaterialAsset> = {
      lut: {
        kind: 'material',
        parameters: standardSurfaceParameters([
          { name: 'directMultiscatteringLut', type: 'u32', default: 1 },
          ...(transmission
            ? [
                { name: 'transmission', type: 'f32' as const, default: 0 },
                { name: 'thickness', type: 'f32' as const, default: 0 },
                { name: 'attenuationColor', type: 'vec3' as const, default: [1, 1, 1] },
                { name: 'attenuationDistance', type: 'f32' as const, default: 0 },
              ]
            : []),
        ]),
        values: {
          baseColor: [0.8, 0.4, 0.2, 1],
          metallic: 1,
          roughness: 1,
          directMultiscatteringLut: 1,
        },
        passes: [
          {
            name: 'Forward',
            program: {
              module: geometry === 'mesh' ? 'forgeax::default-standard-pbr' : 'forgeax::pbr-skin',
            },
          },
          ...(geometry === 'skinned' && !transmission
            ? [
                {
                  name: 'ShadowCaster',
                  program: { module: 'forgeax::default-shadow-caster' },
                  renderState: { passKind: 'shadow-caster' as const },
                },
              ]
            : []),
        ],
      },
      fit: {
        kind: 'material',
        parent: 'lut' as unknown as AssetGuid,
        values: { directMultiscatteringLut: 0 },
      },
    };
    const context = { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, geometry };
    const lut = (await cookMaterialAsset({ material: 'lut', table, sources, context })).unwrap();
    const fit = (await cookMaterialAsset({ material: 'fit', table, sources, context })).unwrap();
    const pass = lut.passes[0];
    const scene = pass?.sceneCompile;
    if (!pass || !scene) throw new Error('Standard material must publish its scene-index program');
    expect(fit.passes[0]?.sceneCompile?.wgsl).toBe(scene.wgsl);
    expect(fit.passes[0]?.layoutIdentity).toBe(pass.layoutIdentity);
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Scene-index DFG regression requires a native GPU adapter');
    const device = await adapter.requestDevice({
      requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const buffers: GPUBuffer[] = [];
    const textures: GPUTexture[] = [];
    const resourceBuffers = new Map<string, GPUBuffer>();
    const makeBuffer = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const makeTexture = (
      format: GPUTextureFormat,
      size: GPUExtent3D,
      usage: GPUTextureUsageFlags,
    ) => {
      const texture = device.createTexture({ format, size, usage });
      textures.push(texture);
      return texture;
    };
    try {
      device.pushErrorScope('validation');
      const program = async (compiled: NonNullable<typeof scene>) => {
        const module = device.createShaderModule({ code: compiled.wgsl });
        expect(
          (await module.getCompilationInfo()).messages.filter(
            (message) => message.type === 'error',
          ),
        ).toEqual([]);
        // Use the producer's reflected binding contract, as in gpu-driven-pbr.
        // No substitute fragment or material-provider shader is introduced here.
        const layouts = compiled.bindings.map((group) =>
          device.createBindGroupLayout({ entries: group.entries as GPUBindGroupLayoutEntry[] }),
        );
        const groups = compiled.bindings.map((group, groupIndex) =>
          device.createBindGroup({
            layout: layouts[groupIndex] as GPUBindGroupLayout,
            entries: group.entries.map((entry): GPUBindGroupEntry => {
              if (entry.buffer) {
                const buffer =
                  resourceBuffers.get(`${groupIndex}:${entry.binding}`) ??
                  makeBuffer(
                    32768,
                    GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                  );
                resourceBuffers.set(`${groupIndex}:${entry.binding}`, buffer);
                return { binding: entry.binding, resource: { buffer } };
              }
              if (entry.sampler)
                return {
                  binding: entry.binding,
                  resource: device.createSampler(
                    entry.sampler.type === 'comparison'
                      ? { compare: 'less-equal' }
                      : entry.sampler.type === 'filtering'
                        ? { minFilter: 'linear', magFilter: 'linear' }
                        : {},
                  ),
                };
              if (!entry.texture) throw new Error('Unexpected Standard resource kind');
              const dimension = entry.texture.viewDimension ?? '2d';
              const isLut = groupIndex === 1 && entry.binding === 72;
              const size = isLut ? 16 : 1;
              const layers =
                dimension === 'cube' || dimension === 'cube-array'
                  ? 6
                  : dimension === '2d-array'
                    ? 4
                    : 1;
              const texture = makeTexture(
                entry.texture.sampleType === 'depth'
                  ? 'depth32float'
                  : isLut
                    ? 'rg16float'
                    : 'rgba16float',
                [size, size, layers],
                GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              );
              if (isLut)
                device.queue.writeTexture(
                  { texture },
                  directDfgLutBytes(),
                  { bytesPerRow: 64, rowsPerImage: 16 },
                  [16, 16],
                );
              return { binding: entry.binding, resource: texture.createView({ dimension }) };
            }),
          }),
        );
        const bufferAt = (group: number, binding: number): GPUBuffer => {
          const buffer = resourceBuffers.get(`${group}:${binding}`);
          if (!buffer) throw new Error(`Missing production buffer ${group}:${binding}`);
          return buffer;
        };
        const writeMembers = (
          group: number,
          binding: number,
          values: Record<string, readonly number[]>,
        ) => {
          const global = compiled.reflection.boundGlobals.find(
            (value) => value.group === group && value.binding === binding,
          );
          if (!global) throw new Error('Missing reflected uniform');
          const bytes = new ArrayBuffer(32768);
          const floats = new Float32Array(bytes);
          const uints = new Uint32Array(bytes);
          for (const [name, value] of Object.entries(values)) {
            const member = global.members?.find((item) => item.name === name);
            if (!member) throw new Error(`Missing reflected field ${name}`);
            (member.type === 'u32' || member.type === 'vec4<u32>' ? uints : floats).set(
              value,
              member.offset / 4,
            );
          }
          device.queue.writeBuffer(bufferAt(group, binding), 0, bytes);
        };
        return { module, layouts, groups, bufferAt, writeMembers };
      };
      const { module, layouts, groups, bufferAt, writeMembers } = await program(scene);
      writeMembers(0, 0, {
        worldViewProj: identity,
        lightViewProj_A: identity,
        inverseViewProj: identity,
        temporalCurrentViewProj: identity,
        temporalPreviousViewProj: identity,
        lightDir: [0, 0, -1],
        lightColor: [1, 1, 1],
        cameraPos: [0, 0, 2],
        lightingChannels: [0xffffffff],
        temporalProjection: [0.1, 10, 1, 0],
      });
      writeMembers(2, 6, { grid: [1, 1, 1, 0], near_far_log: [0.1, 10, Math.log(100), 0] });
      const materialBytes = new Uint8Array(pass.abi.materialRow.byteLength * 2);
      for (const [index, material] of [lut, fit].entries()) {
        const row = packMaterialProgramRow(
          pass.paramSchema,
          { paramSnapshot: material.resolved.asset.values } as MaterialSnapshot,
          pass.abi.materialRow.byteLength,
        );
        if (!row) throw new Error('Material row does not fit the producer ABI');
        materialBytes.set(row, index * row.length);
      }
      device.queue.writeBuffer(bufferAt(1, 46), 0, materialBytes);
      // The bound uniform is deliberately the zero-valued child: scene selection
      // must use visibleItems.y, including before any helper observes material.
      device.queue.writeBuffer(
        bufferAt(1, 0),
        0,
        materialBytes.subarray(pass.abi.materialRow.byteLength),
      );
      const worlds = [-0.5, 0.5].map((x) => {
        const world = [...identity];
        world[12] = x;
        return world;
      });
      const transformBytes = new Float32Array((GPU_SCENE_LAYOUTS.transform.stride * 3) / 4);
      const rootWorlds =
        geometry === 'skinned'
          ? worlds.map(() => {
              const poison = [...identity];
              poison[12] = 20;
              return poison;
            })
          : worlds;
      for (const [index, world] of [identity, ...rootWorlds].entries()) {
        const offset = (index * GPU_SCENE_LAYOUTS.transform.stride) / 4;
        transformBytes.set(world, offset);
        transformBytes.set(world, offset + 16);
      }
      device.queue.writeBuffer(bufferAt(2, 0), 0, transformBytes);
      const primitive = new Uint32Array((GPU_SCENE_LAYOUTS.primitive.stride * 2) / 4);
      const instances = new Uint32Array((GPU_SCENE_LAYOUTS.instance.stride * 2) / 4);
      for (let i = 0; i < 2; i++) {
        const offset = (i * GPU_SCENE_LAYOUTS.primitive.stride) / 4;
        primitive[offset + gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'transformIndex') / 4] =
          i + 1;
        primitive[offset + gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'flags') / 4] = 32; // no shadow reception
        primitive[
          offset + gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'lightingChannels') / 4
        ] = 0xffffffff;
        const instance = (i * GPU_SCENE_LAYOUTS.instance.stride) / 4;
        instances[instance] = i;
      }
      device.queue.writeBuffer(bufferAt(3, 6), 0, primitive);
      device.queue.writeBuffer(bufferAt(3, 0), 0, instances);
      if (geometry === 'skinned') {
        // Storage Skin task ABI: candidate -> hash slot -> descriptor -> paired
        // current/previous joints. Visible rows name candidates 2 and 3; every
        // unused row holds a valid poison matrix that moves geometry out of view.
        const rows = new Uint32Array(32 * 4);
        const floats = new Float32Array(rows.buffer);
        const poison = [...identity];
        poison[12] = 20;
        for (let row = 0; row < 32; row += 4) floats.set(poison, row * 4);
        const descriptorBase = 4;
        for (const [index, candidate] of [2, 3].entries()) {
          const world = worlds[index];
          const previousDelta = [0.2, -0.3][index];
          if (world === undefined || previousDelta === undefined)
            throw new Error('Missing Skin pose');
          const base = 8 + index * 8;
          rows.set([index, 0, 0, 0], candidate * 4);
          rows.set([candidate + 1, 1, base, 3], (descriptorBase + index) * 4);
          floats.set(world, base * 4);
          const previous = [...world];
          previous[12] = (previous[12] ?? 0) - previousDelta;
          floats.set(previous, (base + 4) * 4);
        }
        for (const candidate of [0, 1]) rows.set([0xffffffff, 0, 0, 0], candidate * 4);
        device.queue.writeBuffer(bufferAt(2, 1), 0, rows);
        device.queue.writeBuffer(bufferAt(2, 2), 0, new Uint32Array([0, descriptorBase, 0, 0]));
      }
      const vertex = new Float32Array(3 * 20);
      for (const [i, position] of [
        [-0.4, -0.7, 0.5],
        [0.4, -0.7, 0.5],
        [0, 0.7, 0.5],
      ].entries()) {
        vertex.set([...position, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0], i * 20);
      }
      const vertices = makeBuffer(
        vertex.byteLength,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      device.queue.writeBuffer(vertices, 0, vertex);
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'float32x4' },
      ];
      for (let location = 6; location <= 12; location++)
        attributes.push({ shaderLocation: location, offset: 24, format: 'float32x2' });
      if (geometry === 'skinned')
        attributes.push(
          { shaderLocation: 4, offset: 48, format: 'uint32x4' },
          { shaderLocation: 5, offset: 64, format: 'float32x4' },
        );
      const layout = device.createPipelineLayout({ bindGroupLayouts: layouts });
      const results: Record<string, number[][]> = {};
      const fragments = [
        'fs_opaque',
        'fs_gbuffer',
        ...(geometry === 'skinned' && !transmission ? ['fs_temporal'] : []),
      ];
      for (const fragment of fragments) {
        const formats: GPUTextureFormat[] =
          fragment !== 'fs_gbuffer'
            ? ['rgba32float']
            : [
                'rgba16float',
                'r32uint',
                'r32uint',
                'r32uint',
                'rg32uint',
                'rg32uint',
                'rgba16float',
              ];
        const targets = formats.map((format) =>
          makeTexture(
            format,
            [width, height],
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          ),
        );
        const pipeline = await device.createRenderPipelineAsync({
          layout,
          vertex: {
            module,
            entryPoint: fragment === 'fs_temporal' ? 'vs_temporal' : 'vs_scene_index',
            buffers: [{ arrayStride: 80, attributes }],
          },
          fragment: {
            module,
            entryPoint: fragment,
            targets: formats.map((format) => ({ format })),
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        });
        for (const swap of fragment === 'fs_temporal' ? [false] : [false, true]) {
          device.queue.writeBuffer(
            bufferAt(3, 2),
            0,
            new Uint32Array([
              0,
              swap ? pass.abi.materialRow.byteLength / 16 : 0,
              geometry === 'skinned' ? 2 : 0,
              0,
              1,
              swap ? 0 : pass.abi.materialRow.byteLength / 16,
              geometry === 'skinned' ? 3 : 0,
              0,
            ]),
          );
          const encoder = device.createCommandEncoder();
          const raster = encoder.beginRenderPass({
            colorAttachments: targets.map((texture) => ({
              view: texture.createView(),
              loadOp: 'clear',
              storeOp: 'store',
            })),
          });
          raster.setPipeline(pipeline);
          for (const [index, group] of groups.entries()) raster.setBindGroup(index, group);
          raster.setVertexBuffer(0, vertices);
          raster.draw(3, 2);
          raster.end();
          const target = targets[fragment === 'fs_gbuffer' ? 5 : 0];
          if (!target) throw new Error('Missing readback target');
          const bytesPerRow = fragment === 'fs_gbuffer' ? width * 8 : width * 16;
          const readback = makeBuffer(
            bytesPerRow * height,
            GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          );
          encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [
            width,
            height,
          ]);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const mapped = readback.getMappedRange();
          const pixels =
            fragment === 'fs_gbuffer' ? new Uint32Array(mapped) : new Float32Array(mapped);
          const channels = fragment === 'fs_gbuffer' ? 2 : 4;
          const pair = [8, 23].map((x) =>
            Array.from(
              pixels.slice((8 * width + x) * channels, (8 * width + x) * channels + channels),
            ),
          );
          results[`${fragment}/${swap}`] = pair;
          if (fragment === 'fs_gbuffer')
            expect
              .soft(pair.map((pixel) => ((pixel[0] ?? 0) >>> 23) & 1))
              .toEqual(swap ? [0, 1] : [1, 0]);
          if (fragment === 'fs_temporal') {
            for (const [index, motion] of [0.1, -0.15].entries()) {
              expect(pair[index]?.[0]).toBeCloseTo(motion, 5);
              expect(pair[index]?.[1]).toBeCloseTo(0, 5);
              expect(pair[index]?.[2]).toBeCloseTo(Math.log2(6.05), 5);
              expect(pair[index]?.[3]).toBeCloseTo(0, 5); // opaque, valid motion
            }
          }
          readback.unmap();
        }
      }
      const shadow = lut.passes.find((entry) => entry.pass === 'ShadowCaster');
      if (geometry === 'skinned' && !transmission) {
        if (!shadow?.sceneCompile) throw new Error('Missing cooked scene-index Skin shadow');
        expect(shadow.context.geometry).toBe('skinned');
        expect(shadow.context.pass).toBe('shadow');
        expect(shadow.abi.materialRow.addressUnitBytes).toBe(16);
        const shadowProgram = await program(shadow.sceneCompile);
        shadowProgram.writeMembers(0, 0, { lightViewProj_A: identity });
        shadowProgram.writeMembers(0, 7, { index: [0], isSpot: [0] });
        const rows = new Uint8Array(shadow.abi.materialRow.byteLength * 2);
        for (const [index, material] of [lut, fit].entries()) {
          const packed = packMaterialProgramRow(
            shadow.paramSchema,
            { paramSnapshot: material.resolved.asset.values } as MaterialSnapshot,
            shadow.abi.materialRow.byteLength,
          );
          if (!packed) throw new Error('Shadow material does not fit its own ABI');
          rows.set(packed, index * packed.byteLength);
        }
        device.queue.writeBuffer(shadowProgram.bufferAt(1, 46), 0, rows);
        device.queue.writeBuffer(
          shadowProgram.bufferAt(3, 2),
          0,
          new Uint32Array([0, 0, 2, 0, 1, shadow.abi.materialRow.byteLength / 16, 3, 0]),
        );
        const pipeline = await device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: shadowProgram.layouts }),
          vertex: {
            module: shadowProgram.module,
            entryPoint: 'vs_scene_index',
            buffers: [{ arrayStride: 80, attributes }],
          },
          fragment: { module: shadowProgram.module, entryPoint: 'fs_shadow', targets: [] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });
        const depth = makeTexture(
          'depth32float',
          [width, height],
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        );
        const encoder = device.createCommandEncoder();
        const raster = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: 1,
          },
        });
        raster.setPipeline(pipeline);
        for (const [index, group] of shadowProgram.groups.entries())
          raster.setBindGroup(index, group);
        raster.setVertexBuffer(0, vertices);
        raster.draw(3, 2);
        raster.end();
        const readback = makeBuffer(
          256 * height,
          GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        );
        encoder.copyTextureToBuffer(
          { texture: depth, aspect: 'depth-only' },
          { buffer: readback, bytesPerRow: 256 },
          [width, height],
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        const samples = [8, 23, 16].map((x) => values[8 * 64 + x]);
        expect(samples).toEqual([0.5, 0.5, 1]);
        readback.unmap();
        results.shadowDepth = [samples as number[]];
      }
      const original = results['fs_opaque/false'];
      const swapped = results['fs_opaque/true'];
      if (!original || !swapped) throw new Error('Missing Forward readback');
      for (let channel = 0; channel < 3; channel++) {
        expect(original[0]?.[channel]).toBeGreaterThan(0);
        expect(original[0]?.[channel]).toBeCloseTo(swapped[1]?.[channel] ?? NaN, 5);
        expect(original[1]?.[channel]).toBeCloseTo(swapped[0]?.[channel] ?? NaN, 5);
      }
      expect
        .soft(Math.abs((original[0]?.[0] ?? NaN) - (original[1]?.[0] ?? NaN)))
        .toBeGreaterThan(0.001);
      expect(await device.popErrorScope()).toBeNull();
      process.stdout.write(`${JSON.stringify({ geometry, transmission, results })}\n`);
    } finally {
      for (const buffer of buffers) buffer.destroy();
      for (const texture of textures) texture.destroy();
      device.destroy();
    }
  },
  30_000,
);
