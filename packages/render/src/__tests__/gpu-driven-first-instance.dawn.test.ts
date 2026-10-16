import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup, Buffer, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import {
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { derive, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { BatchTopology, batchLevelStride } from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { snapshot, standardPbrInputs, updateSnapshot } from './gpu-driven-production-fixture';

const WIDTH = 32;
const ROW_BYTES = WIDTH * 16;
const PYRAMID_SIZE = 64;
const EMPTY_DEPTH = 3.402823e38;
const MATERIAL_ROW = createStandardPbrArtifactReceipt().materialRow;
// Derive the expected address stride independently from the GPU Scene receipt.
const MATERIAL_ADDRESS_STRIDE = derive(STANDARD_PIPELINE_PARAM_SCHEMA).totalBytes / 16;
const BASE_COLOR = derive(STANDARD_PIPELINE_PARAM_SCHEMA).numericMembers.find(
  (member) => member.name === 'baseColor',
);
if (
  MATERIAL_ROW.addressUnitBytes !== 16 ||
  MATERIAL_ROW.byteLength !== MATERIAL_ADDRESS_STRIDE * 16 ||
  !Number.isInteger(MATERIAL_ADDRESS_STRIDE)
)
  throw new Error('first-instance fixture requires the published 16-byte material address ABI');
if (BASE_COLOR === undefined || BASE_COLOR.offset % 16 !== 0)
  throw new Error('first-instance fixture requires an aligned published baseColor field');

// Use the production slot-3 bind group. Like Standard's scene-index entry,
// instance_index addresses visibleItems; visible.z independently addresses a
// whole-bound Surface table. Each scene instance writes its own integer pixel.
const RASTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> materialRows: array<vec4<f32>>;
@group(3) @binding(1) var<storage, read> shadowVisible: array<vec4<u32>>;
@group(3) @binding(2) var<storage, read> visibleItems: array<vec4<u32>>;
@group(3) @binding(7) var<storage, read> surfaceRows: array<u32>;
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) item: vec4<u32>,
};
@vertex
fn vs_scene_index(@builtin(vertex_index) vertex: u32,
                  @builtin(instance_index) drawIndex: u32) -> VertexOut {
  let visible = visibleItems[drawIndex];
  let positions = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  let position = positions[vertex % 3u];
  var out: VertexOut;
  out.position = vec4(-1.0 + (2.0 * f32(visible.x) + position.x + 1.0) / ${WIDTH}.0,
                      position.y, 0.0, 1.0);
  out.item = vec4(visible.x + 1u, visible.y + 1u, surfaceRows[visible.z],
                  select(0u, 255u, all(shadowVisible[drawIndex] == visible) &&
                    all(materialRows[visible.y + ${BASE_COLOR.offset / 16}u] ==
                      vec4(0.25 * f32(visible.x + 1u), 0.5, 0.75, 1.0))));
  return out;
}
@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<u32> { return in.item; }
`;

function member(entityKey: number, asset: number, x: number): RenderableSnapshot {
  const source = snapshot(entityKey, asset);
  const world = new Float32Array(source.transform.world);
  world[12] = x;
  world[14] = -10;
  const draw = source.gpuDrivenDraws?.[0];
  if (draw === undefined) throw new Error('missing first-instance fixture draw');
  return {
    ...source,
    transform: { world },
    lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    gpuDrivenDraws: [
      {
        ...draw,
        kind: asset === 3 ? 'non-indexed' : 'indexed',
        lodRanges: [{ first: asset === 3 ? 0 : 3, count: 3, baseVertex: 3 }],
      },
    ],
  };
}

function camera() {
  const near = 0.1;
  const far = 100;
  const viewProjection = mat4.identity(mat4.create());
  viewProjection[0] = 0.5;
  viewProjection[5] = 0.5;
  viewProjection[10] = 1 / (far - near);
  viewProjection[14] = far / (far - near);
  const span = (2 * 0.25 * Math.sqrt(3)) / 0.3;
  return {
    planes: frustum.fromViewProjection(frustum.create(), viewProjection),
    lod: {
      position: new Float32Array([0, 0, 0]),
      projection: 'orthographic',
      fov: 0,
      orthoTop: span / 2,
      orthoBottom: -span / 2,
    } as LodViewCamera,
    occlusion: {
      viewProjection: new Float32Array(viewProjection),
      near,
      far,
      orthographic: true,
      historyKey: 'first-instance-evidence',
    },
  };
}

function wallPyramid(device: RhiDevice) {
  const mipLevelCount = Math.log2(PYRAMID_SIZE) + 1;
  const descriptor = {
    format: 'r32float',
    size: { width: PYRAMID_SIZE, height: PYRAMID_SIZE },
    mipLevelCount,
    usage: 0x04 | 0x02,
  } as const;
  const texture = device.createTexture(descriptor).unwrap();
  const textureView = device.createTextureView(texture, { mipLevelCount }).unwrap();
  return {
    write(leftWall: boolean) {
      for (let level = 0; level < mipLevelCount; level += 1) {
        const size = PYRAMID_SIZE >> level;
        const texels = new Float32Array(size * size).fill(EMPTY_DEPTH);
        if (leftWall && size > 1) {
          for (let y = 0; y < size; y += 1) texels.fill(5, y * size, y * size + size / 2);
        }
        device.queue
          .writeTexture(
            { texture, mipLevel: level },
            texels,
            { bytesPerRow: size * 4, rowsPerImage: size },
            { width: size, height: size, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
    },
    import(graph: RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>) {
      const imported = graph
        .importTexture('first-instance-wall', descriptor, () => texture)
        .unwrap();
      return graph.importView(imported, { mipLevelCount }, () => textureView).unwrap();
    },
    dispose: () => device.destroyTexture(texture),
  };
}

async function readWords(buffer: Buffer): Promise<Uint32Array> {
  const mapped = (await buffer.mapAsync(0x1)).unwrap();
  const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  return words;
}

describe('GPU-driven native first-instance addressing', () => {
  it.each([
    true,
    false,
  ])('rasterizes actual feature=%s across LOD, late, growth and recovery', async (enabled) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(enabled ? { requiredFeatures: ['indirect-first-instance'] } : {})
    ).unwrap();
    const rawDevice = _internal_getRawDevice(device);
    if (rawDevice === undefined) throw new Error('first-instance native device unavailable');
    // Both assertions concern the feature actually granted to the native
    // device, not a substituted RhiCaps object.
    expect(rawDevice.features.has('indirect-first-instance')).toBe(enabled);
    expect(device.caps.firstInstanceIndirect).toBe(enabled);
    rawDevice.pushErrorScope('validation');
    const compute = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const raster = (await rhi.createShaderModule(device, { code: RASTER_WGSL })).unwrap();
    const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const materialLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: Array.from({ length: 8 }, (_, binding) => ({
          binding,
          visibility: 0x1,
          buffer: { type: binding === 5 ? ('uniform' as const) : ('read-only-storage' as const) },
        })),
      })
      .unwrap();
    const layout = device
      .createPipelineLayout({
        bindGroupLayouts: [materialLayout, emptyLayout, emptyLayout, instancesLayout],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout,
        vertex: { module: raster, entryPoint: 'vs_scene_index', buffers: [] },
        fragment: { module: raster, entryPoint: 'fs_main', targets: [{ format: 'rgba32uint' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
    const ownedBuffers: Buffer[] = [];
    const createBuffer = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage }).unwrap();
      ownedBuffers.push(buffer);
      return buffer;
    };
    const indices = createBuffer(12, GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST);
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0, 1, 2])).unwrap();
    const surface = createBuffer(WIDTH * 4, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST);
    device.queue
      .writeBuffer(
        surface,
        0,
        Uint32Array.from({ length: WIDTH }, (_, row) => row + 100),
      )
      .unwrap();
    const pixels = createBuffer(
      ROW_BYTES * 2,
      GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    );
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 4).unwrap();
    if (availability.status !== 'available') throw new Error('native GPU Scene unavailable');
    const scene = availability.scene;
    const topology = new BatchTopology();
    const add = (members: RenderableSnapshot[]) => {
      const delta = projection.apply(members.map(updateSnapshot));
      scene.sync(delta).unwrap();
      topology.apply(delta);
    };
    // The culled first batch makes both real draw kinds use nonzero bases.
    add([member(1, 1, 10), member(2, 2, -1), member(3, 3, 1)]);
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(compute) },
    }).unwrap();
    const cameras = camera();
    const pyramid = wallPyramid(device);
    let material: MaterialAbiRasterAdapter | undefined;
    let previousGroup: BindGroup | undefined;
    let previousVisible: Buffer | undefined;
    let previousMirrorBase = 0;
    try {
      for (let frame = 0; frame < 5; frame += 1) {
        if (frame === 2) add(Array.from({ length: 19 }, (_, index) => member(index + 4, 2, 1)));
        if (frame === 3) view._recoverFromOverflow().unwrap();
        pyramid.write(frame < 2);
        view
          .update(topology.plan(), scene, cameras.planes, cameras.lod, 0, undefined, undefined, {
            ...cameras.occlusion,
            historyKey: frame >= 3 ? 'first-instance-recovery' : cameras.occlusion.historyKey,
          })
          .unwrap();
        const visible = view.visibleBuffer;
        const indirect = view.indirectBuffer;
        if (visible === undefined || indirect === undefined)
          throw new Error('missing native view buffers');
        const inspection = view.inspect();
        const mirrorBase = inspection.visibleBufferCapacity;
        if (frame === 2 || frame === 3) {
          expect(visible).not.toBe(previousVisible);
          expect(mirrorBase).toBeGreaterThanOrEqual(previousMirrorBase);
        }
        if (frame === 3) expect(mirrorBase).toBeGreaterThan(previousMirrorBase);
        if (material === undefined) {
          const input = standardPbrInputs(device, raster, emptyLayout);
          if (
            input.standardPbrPipelineState === undefined ||
            input.standardPbrArtifact === undefined
          ) {
            throw new Error('missing receipt-backed material fixture');
          }
          material = MaterialAbiRasterAdapter.create({
            device,
            visibleBuffer: visible,
            artifact: input.standardPbrArtifact,
            pipelineState: {
              ...input.standardPbrPipelineState,
              gpuDrivenInstancesBindGroupLayout: instancesLayout,
              gpuDrivenPbrPipelineLayout: layout,
            },
          }).unwrap();
        }
        material.ensureVisibleBuffer(visible).unwrap();
        const tables = scene.inspect().tables;
        const materialGroup = device
          .createBindGroup({
            layout: materialLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: scene.materialBuffer,
                    offset: 0,
                    size: tables.material.bytes,
                  },
                },
              },
            ],
          })
          .unwrap();
        material.ensureSceneTables(
          scene.instanceBuffer,
          tables.instance.bytes,
          scene.primitiveBuffer,
          tables.primitive.bytes,
          surface,
        );
        const plan = topology.plan();
        expect(plan.batches).toHaveLength(3);
        for (const batch of plan.batches.slice(1)) expect(batch.visibleBase).toBeGreaterThan(0);
        const groups: BindGroup[] = [];
        const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
        const pyramidView = pyramid.import(graph);
        const gpu = view
          .addPasses(graph, 'first-instance', true, undefined, undefined, true)
          .unwrap();
        const output = graph
          .createTexture('first-instance-pixels', {
            format: 'rgba32uint',
            size: { width: WIDTH, height: 2 },
          })
          .unwrap();
        const outputView = graph.view(output).unwrap();
        const argumentsBytes = inspection.indirectCapacity * 20;
        const argumentReadback = createBuffer(
          argumentsBytes * 2,
          GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        );
        const argumentResource = graph
          .importBuffer(
            'first-instance-arguments',
            {
              size: argumentsBytes * 2,
              usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
            },
            () => argumentReadback,
          )
          .unwrap();
        const rasterMaterial = material;
        const addRaster = (late: boolean) => {
          const frameGroups = plan.batches.map((batch) => {
            const base = batch.visibleBase + batchLevelStride(batch) + (late ? mirrorBase : 0);
            const group = (
              late
                ? rasterMaterial.shadowVisibleWindowBindGroupForBuffer(
                    visible,
                    base,
                    batch.visibleCapacity,
                  )
                : rasterMaterial.visibleWindowBindGroupForBuffer(
                    visible,
                    base,
                    batch.visibleCapacity,
                  )
            ).unwrap();
            groups.push(group);
            return group;
          });
          graph
            .addRasterPass(late ? 'first-instance.late-pixels' : 'first-instance.early-pixels', {
              accesses: [
                { resource: gpu.visible, usage: 'storage-read' },
                { resource: gpu.material, usage: 'storage-read' },
                { resource: gpu.indirect, usage: 'indirect-read' },
                { resource: outputView, usage: 'color-attachment' },
              ],
              colorAttachments: [
                {
                  view: outputView,
                  loadOp: late ? 'load' : 'clear',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
              ],
              encode: ({ pass }) => {
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, materialGroup);
                for (let group = 1; group < 3; group += 1) pass.setBindGroup(group, emptyGroup);
                pass.setViewport(0, late ? 1 : 0, WIDTH, 1, 0, 1);
                pass.setIndexBuffer(indices, 'uint16');
                for (const [index, batch] of plan.batches.entries()) {
                  const group = frameGroups[index];
                  if (group === undefined) throw new Error('missing visible group');
                  pass.setBindGroup(3, group);
                  const offset = batch.indirectOffset + 20 + (late ? argumentsBytes : 0);
                  if (batch.key.drawKind === 'indexed') pass.drawIndexedIndirect(indirect, offset);
                  else pass.drawIndirect(indirect, offset);
                }
              },
            })
            .unwrap();
          graph
            .addCopyPass(
              late ? 'first-instance.late-arguments' : 'first-instance.early-arguments',
              {
                accesses: [
                  { resource: gpu.indirect, usage: 'copy-src' },
                  { resource: argumentResource, usage: 'copy-dst' },
                ],
                encode: ({ encoder }) =>
                  encoder.copyBufferToBuffer(
                    indirect,
                    late ? argumentsBytes : 0,
                    argumentReadback,
                    late ? argumentsBytes : 0,
                    argumentsBytes,
                  ),
              },
            )
            .unwrap();
        };
        addRaster(false);
        if (gpu.addLateOcclusion === undefined) throw new Error('missing native late phase');
        gpu.addLateOcclusion(pyramidView).unwrap();
        addRaster(true);
        expect(new Set(groups.slice(0, 3)).size).toBe(enabled ? 1 : 3);
        expect(new Set(groups.slice(3)).size).toBe(enabled ? 1 : 3);
        if (frame === 4) expect(groups[0]).toBe(previousGroup);
        if (frame === 2 || frame === 3) expect(groups[0]).not.toBe(previousGroup);
        const pixelResource = graph
          .importBuffer(
            'first-instance-readback',
            {
              size: ROW_BYTES * 2,
              usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
            },
            () => pixels,
          )
          .unwrap();
        graph
          .addCopyPass('first-instance.read-pixels', {
            accesses: [
              { resource: outputView, usage: 'copy-src' },
              { resource: pixelResource, usage: 'copy-dst' },
            ],
            encode: ({ encoder, resources }) =>
              encoder.copyTextureToBuffer(
                { texture: resources.texture(output).unwrap() as unknown as GPUTexture },
                { buffer: pixels as unknown as GPUBuffer, bytesPerRow: ROW_BYTES, rowsPerImage: 2 },
                { width: WIDTH, height: 2, depthOrArrayLayers: 1 },
              ),
          })
          .unwrap();
        const compiled = graph
          .compile({ device, surfaceSize: { width: WIDTH, height: 2 } })
          .unwrap();
        view._commitResourceReplacement();
        const encoder = device
          .createCommandEncoder({ label: `first-instance-frame-${frame}` })
          .unwrap();
        compiled.execute({ encoder }).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const [pixelWords, argumentsWords] = await Promise.all([
          readWords(pixels),
          readWords(argumentReadback),
        ]);
        const early =
          frame === 0 ? [1, 2] : frame < 3 ? [2] : Array.from({ length: 21 }, (_, i) => i + 1);
        const late = frame === 2 ? [1, ...Array.from({ length: 19 }, (_, i) => i + 3)] : [];
        for (const [phase, rows] of [early, late].entries()) {
          for (let row = 0; row < WIDTH; row += 1) {
            const pixel = Array.from(
              pixelWords.slice((phase * WIDTH + row) * 4, (phase * WIDTH + row + 1) * 4),
            );
            if (rows.includes(row)) {
              // Material addresses count the receipt's 16-byte units, not
              // primitive slots. The shader also loads the distinct material
              // color through that address. Surface rows follow candidate
              // order (the non-indexed batch remains last).
              const candidate = row === 2 && frame >= 2 ? 21 : row > 2 ? row - 1 : row;
              expect(
                pixel,
                `feature=${enabled}, frame=${frame}, phase=${phase}, row=${row}`,
              ).toEqual([row + 1, row * MATERIAL_ADDRESS_STRIDE + 1, candidate + 100, 255]);
            } else expect(pixel).toEqual([0, 0, 0, 0]);
          }
          for (const batch of plan.batches) {
            const command = (phase * argumentsBytes + batch.indirectOffset + 20) / 4;
            const firstInstance =
              argumentsWords[command + (batch.key.drawKind === 'indexed' ? 4 : 3)];
            expect(firstInstance).toBe(
              enabled
                ? batch.visibleBase + batchLevelStride(batch) + (phase === 1 ? mirrorBase : 0)
                : 0,
            );
            expect(argumentsWords[command]).toBe(3);
            expect(argumentsWords[command + 2]).toBe(batch.key.drawKind === 'indexed' ? 3 : 0);
            if (batch.key.drawKind === 'indexed') expect(argumentsWords[command + 3]).toBe(3);
          }
        }
        const validationError = await rawDevice.popErrorScope();
        expect(validationError?.message).toBeUndefined();
        rawDevice.pushErrorScope('validation');
        (await compiled.retire()).unwrap();
        previousVisible = visible;
        previousMirrorBase = mirrorBase;
        previousGroup = groups[0];
      }
    } finally {
      await device.queue.onSubmittedWorkDone();
      material?.dispose();
      view.dispose();
      scene.dispose();
      pyramid.dispose();
      for (const buffer of ownedBuffers) device.destroyBuffer(buffer);
      const validationError = await rawDevice.popErrorScope();
      expect(validationError?.message).toBeUndefined();
    }
  }, 30_000);
});
