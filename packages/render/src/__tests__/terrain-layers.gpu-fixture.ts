import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { standardSurfaceParameters, type TextureAsset } from '@forgeax/engine-types';
import { assert, expect, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';

/** Real shared material/image rows, narrow uploads and fixed old/new roots in one submission. */
export async function verifyTerrainLayerEdits(sampling: string) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = _internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const registry = new AssetRegistry(),
    world = new World({ assets: registry });
  registry.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const pixels = Uint8Array.from(Array.from({ length: 16 }, () => [255, 128, 0, 255]).flat());
  const texture = registry
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      mips: { kind: 'none' },
      data: pixels,
    })
    .unwrap();
  const layer = registry
    .create({
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([{ name: 'baseColorTexture', type: 'texture' }]),
      values: { baseColor: [1, 1, 1, 1], baseColorTexture: texture },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const terrain = () =>
    registry
      .create({
        kind: 'terrain',
        columns: 2,
        rows: 2,
        spacing: 1,
        subsectionVertices: 2,
        heights: new Float32Array(4),
        weights: new Float32Array(4).fill(1),
        layers: [{ material: layer, blend: 'weight' }],
      })
      .unwrap();
  const first = terrain(),
    second = terrain();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const owner = new TerrainLayers(
      () => store,
      () => device,
      {
        createShaderModule: (descriptor) => rhi.createShaderModuleImmediate(device, descriptor),
      },
    ),
    sources = new TerrainSourceCache();
  const a = sources.resolve(worldRenderResources(world), first),
    b = sources.resolve(worldRenderResources(world), second);
  const observer = registry.observe().unwrap();
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const adopted = () => {
    const batch = observer.read().unwrap();
    for (const change of batch.changes) {
      const content = runtimeAssets(registry).borrow<TextureAsset>(change.handle).unwrap();
      store
        .adoptTextureChange(
          change,
          content.kind === 'texture' ? content : undefined,
          worldRenderResources(world),
        )
        .unwrap();
    }
    owner.adopt(worldRenderResources(world), batch.changes);
    sources.adopt(worldRenderResources(world), batch.changes);
    batch.accept();
    return batch.changes.map((change) => change.handle);
  };
  const fixed = (source = a) => {
    const snapshot = { ...defaultMaterialSnapshot() };
    owner.bind(snapshot, owner.capture(worldRenderResources(world), source));
    return snapshot;
  };
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 3, visibility: 4, buffer: { type: 'storage' } },
        ...[1, 2, 4, 6].map((binding) => ({
          binding,
          visibility: 4,
          texture: { sampleType: 'float' as const, viewDimension: '2d-array' as const },
        })),
        ...[5, 7, 8, 9].map((binding) => ({
          binding,
          visibility: 4,
          sampler: { type: 'filtering' as const },
        })),
      ],
    })
    .unwrap();
  const shader = (
    await rhi.createShaderModule(device, {
      code: `
struct SurfaceInput { uv0: vec2<f32> }
struct Material { terrainLayerRoots: vec4<f32>, terrainLayerLevels: vec4<f32>, offset: u32, pad: u32, uv: vec2<f32> }
@group(0) @binding(0) var<uniform> material: Material;
@group(0) @binding(1) var terrainColorLayers: texture_2d_array<f32>;
@group(0) @binding(5) var terrainColorLayers_sampler: sampler;
@group(0) @binding(2) var terrainNormalHeightLayers: texture_2d_array<f32>;
@group(0) @binding(7) var terrainNormalHeightLayers_sampler: sampler;
@group(0) @binding(4) var terrainOrmLayers: texture_2d_array<f32>;
@group(0) @binding(8) var terrainOrmLayers_sampler: sampler;
@group(0) @binding(6) var terrainEmissionLayers: texture_2d_array<f32>;
@group(0) @binding(9) var terrainEmissionLayers_sampler: sampler;
@group(0) @binding(3) var<storage, read_write> output: array<vec4<f32>>;
${sampling.replace(/^#.*\n/gm, '')}
@compute @workgroup_size(1) fn run() { output[material.offset] = terrain_layer(0, SurfaceInput(material.uv)).color; }
`,
    })
  ).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module: shader, entryPoint: 'run' },
    })
    .unwrap();
  const output = device.createBuffer({ size: 128, usage: 132 }).unwrap();
  const read = device.createBuffer({ size: 128, usage: 9 }).unwrap();
  const run = async (snapshots: ReturnType<typeof fixed>[], uv = [0.375, 0.375]) => {
    const encoder = device.createCommandEncoder().unwrap();
    const buffers = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const data = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...uv]);
      new Uint32Array(data.buffer)[8] = index;
      const uniform = device.createBuffer({ size: 48, usage: 72 }).unwrap();
      buffers.push(uniform);
      device.queue.writeBuffer(uniform, 0, data).unwrap();
      const layers = [
        'terrainColorLayers',
        'terrainNormalHeightLayers',
        'terrainOrmLayers',
        'terrainEmissionLayers',
      ].map((name) => {
        const texture = owner.texture(snapshot, name);
        assert(texture);
        return texture;
      });
      const group = device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
            { binding: 3, resource: { kind: 'buffer', value: { buffer: output } } },
            ...layers.flatMap((layer, i) => {
              const textureBinding = [1, 2, 4, 6][i];
              const samplerBinding = [5, 7, 8, 9][i];
              assert(textureBinding !== undefined && samplerBinding !== undefined);
              return [
                {
                  binding: textureBinding,
                  resource: { kind: 'textureView' as const, value: layer.textureView },
                },
                {
                  binding: samplerBinding,
                  resource: { kind: 'sampler' as const, value: layer.sampler },
                },
              ];
            }),
          ],
        })
        .unwrap();
      const pass = encoder.beginComputePass({});
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    encoder.copyBufferToBuffer(output, 0, read, 0, snapshots.length * 16);
    const uploads = store.prepareTextureMips().unwrap();
    device.queue
      .submit([
        ...(uploads?.buffer === undefined ? [] : [uploads.buffer]),
        encoder.finish().unwrap(),
      ])
      .unwrap();
    uploads?.complete(true);
    const mapping = (await read.mapAsync(1)).unwrap();
    const result = Array.from(
      new Float32Array(
        mapping
          .getMappedRange()
          .unwrap()
          .slice(0, snapshots.length * 16),
      ),
    );
    mapping.unmap();
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    return result;
  };
  try {
    const original = fixed();
    expect((await run([original])).slice(0, 4)).toEqual([1, 0.501953125, 0, 1]);
    const bytesBefore = writes.mock.calls.length;
    registry.update(layer, { values: { baseColor: [0.5, 1, 1, 1] } }).unwrap();
    expect(adopted()).toEqual([layer]);
    const numeric = fixed(),
      shared = fixed(b);
    const values = await run([original, numeric, shared]);
    expect(values).toEqual([1, 0.501953125, 0, 1, 0.5, 0.501953125, 0, 1, 0.5, 0.501953125, 0, 1]);
    const bytes = writes.mock.calls
      .slice(bytesBefore)
      .reduce((sum, call) => sum + call[2].byteLength, 0);
    expect(bytes).toBeLessThan(512);
    expect(sources.resolve(worldRenderResources(world), first)).toBe(a);
    expect(sources.resolve(worldRenderResources(world), second)).toBe(b);
    registry
      .writeRange(texture, {
        origin: { x: 1, y: 1 },
        size: { width: 1, height: 1 },
        data: new Uint8Array([0, 255, 0, 255]),
      })
      .unwrap();
    expect(adopted()).toEqual([texture]);
    const edited = fixed();
    const beforeRangeUpload = writes.mock.calls.length;
    expect(await run([original, numeric, edited])).toEqual([
      1, 0.501953125, 0, 1, 0.5, 0.501953125, 0, 1, 0, 1, 0, 1,
    ]);
    expect(
      writes.mock.calls.slice(beforeRangeUpload).reduce((sum, call) => sum + call[2].byteLength, 0),
    ).toBeLessThan(512);
    registry
      .update(texture, {
        shape: { viewDimension: '2d', extent: { width: 2, height: 8 } },
        data: Uint8Array.from(Array.from({ length: 16 }, () => [0, 0, 255, 255]).flat()),
      })
      .unwrap();
    expect(adopted()).toEqual([texture]);
    const resized = fixed();
    expect((await run([edited, resized])).slice(4)).toEqual([0, 0, 1, 1]);
    // Evict older GPU roots, then replay their retained CPU trees beside the latest version.
    await run([resized]);
    await run([resized]);
    expect((await run([original, resized])).slice(0, 4)).toEqual([1, 0.501953125, 0, 1]);
    // Linearize source texels before filtering, including repeated borders.
    registry
      .update(texture, {
        colorSpace: 'srgb',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        data: Uint8Array.from([0, 64, 128, 255].flatMap((value) => [value, value, value, 255])),
      })
      .unwrap();
    adopted();
    const filtered = fixed();
    const average = (0.05126953125 + 0.2158203125 + 1) / 4;
    // The derived layer is rgba16float. WebGPU leaves the precision of a filtered
    // sample implementation-defined: Vulkan returns the f32 blend, while Apple GPUs
    // return a filtered half-float texture at half precision (0.316650390625 for
    // the 0.3167724609375 midpoint). One half-float spacing of the expected value
    // stays orders of magnitude below the sRGB-after-filter falsifier (~0.15).
    const halfFloatSpacing = (value: number) =>
      value === 0 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(Math.abs(value))) - 10);
    const expectFiltered = (actual: readonly number[], expected: readonly number[]) => {
      expect(actual).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const observed = actual[i],
          wanted = expected[i];
        assert(observed !== undefined && wanted !== undefined);
        expect(Math.abs(observed - wanted)).toBeLessThanOrEqual(
          Math.max(0.00001, halfFloatSpacing(wanted)),
        );
      }
    };
    expectFiltered(await run([filtered], [0.5, 0.5]), [average * 0.5, average, average, 1]);
    expectFiltered(await run([filtered], [0, 0]), [average * 0.5, average, average, 1]);
    registry
      .writeRange(texture, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array([255, 255, 255, 255]),
      })
      .unwrap();
    adopted();
    const borderEdited = fixed();
    expectFiltered(await run([filtered, borderEdited], [0, 0]), [
      average * 0.5,
      average,
      average,
      1,
      (average + 0.25) * 0.5,
      average + 0.25,
      average + 0.25,
      1,
    ]);
    // The renderer's GPU teardown/reconfigure retains immutable CPU captures.
    await device.queue.onSubmittedWorkDone();
    owner.dispose();
    store.configureGpuDevice(device, undefined, device.caps);
    expectFiltered(await run([original, borderEdited], [0, 0]), [
      1,
      0.501953125,
      0,
      1,
      (average + 0.25) * 0.5,
      average + 0.25,
      average + 0.25,
      1,
    ]);
    expect(sources.resolve(worldRenderResources(world), first)).toBe(a);
    expect(sources.resolve(worldRenderResources(world), second)).toBe(b);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    writes.mockRestore();
    observer.dispose();
    owner.dispose();
    store.destroyAll();
    device.destroyBuffer(output);
    device.destroyBuffer(read);
  }
}
