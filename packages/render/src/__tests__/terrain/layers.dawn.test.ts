import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type MaterialAsset,
  standardSurfaceParameters,
  type TerrainLayer,
  type TerrainMaterialEncoding,
  type TerrainSource,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';

const material = (color: readonly number[], normalTexture?: string): MaterialAsset => ({
  kind: 'material',
  parameters: standardSurfaceParameters(
    normalTexture === undefined ? [] : [{ name: 'normalTexture', type: 'texture' }],
  ),
  values: { baseColor: color, ...(normalTexture === undefined ? {} : { normalTexture }) },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
});
const texel = (values: readonly number[]): TextureAsset => ({
  kind: 'texture',
  format: 'rgba8unorm',
  colorSpace: 'linear',
  shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
  mips: { kind: 'none' },
  data: Uint8Array.from(values),
});

it('reads actual cooked layer channels through the Landscape fragment kernel and keeps blend falsifiers', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = (file: string) =>
    readFileSync(resolve(process.cwd(), 'packages/shader/src', file), 'utf8').replace(
      /^#.*\n/gm,
      '',
    );
  const surface = source('terrain-surface.wgsl')
    .replace(/terrain\w+_sampler/g, 'samp')
    .replace('fn evaluate_surface', 'fn evaluate_weight_surface');
  const idSurface = source('terrain-id-surface.wgsl')
    .replace(/terrain\w+_sampler/g, 'samp')
    .replace('fn evaluate_surface', 'fn evaluate_id_surface');
  const code =
    source('surface_v1.wgsl') +
    source('tbn.wgsl') +
    `
struct Material { terrainLayerModes:vec4<f32>, strategy:f32, padding:f32, uv:vec2<f32> };
@group(0) @binding(0) var<uniform> material:Material;
@group(0) @binding(1) var terrainWeightTexture:texture_2d<f32>;
@group(0) @binding(2) var terrainColorLayers:texture_2d_array<f32>;
@group(0) @binding(3) var terrainNormalHeightLayers:texture_2d_array<f32>;
@group(0) @binding(4) var terrainOrmLayers:texture_2d_array<f32>;
@group(0) @binding(5) var terrainEmissionLayers:texture_2d_array<f32>;
@group(0) @binding(6) var samp:sampler;
` +
    surface +
    idSurface +
    `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  return vec4<f32>(positions[i],0.0,1.0);
}
fn channels()->SurfaceData {
  var input:SurfaceInput; input.uv0=material.uv; input.vertexNormalWS=vec3<f32>(0.0,1.0,0.0);
  input.tangentWS=vec4<f32>(1.0,0.0,0.0,1.0); input.frontFacing=true;
  if (material.strategy == 1.0) { return evaluate_id_surface(input); }
  return evaluate_weight_surface(input);
}
@fragment fn color()->@location(0) vec4<f32> { let s=channels(); return vec4<f32>(s.baseColor,s.opacity); }
@fragment fn normal()->@location(0) vec4<f32> { return vec4<f32>(channels().normalWS,1.0); }
@fragment fn orm()->@location(0) vec4<f32> { let s=channels(); return vec4<f32>(s.occlusion,s.roughness,s.metallic,1.0); }
`;
  const module = createShaderModuleImmediate(device, { code }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5].map((binding) => ({
          binding,
          visibility: 2,
          texture: {
            sampleType: 'float' as const,
            viewDimension: binding === 1 ? ('2d' as const) : ('2d-array' as const),
          },
        })),
        { binding: 6, visibility: 2, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipelines = ['color', 'normal', 'orm'].map((entryPoint) =>
    device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint, targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap(),
  );
  const target = device
    .createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      usage: 0x01 | 0x10,
    })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const read = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }).unwrap();
  const uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x08 }).unwrap();
  const sampler = device
    .createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();
  const run = async (
    layers: readonly TerrainLayer[],
    weights: readonly number[],
    assets: Readonly<Record<string, Asset>>,
    encoding: TerrainMaterialEncoding = { kind: 'weights' },
    controls?: TerrainSource,
    uv: readonly number[] = [0.5, 0.5],
  ) => {
    const output = buildTerrainAssets(
      controls ?? {
        columns: 2,
        rows: 2,
        spacing: 1,
        subsectionVertices: 2,
        heights: new Float32Array(4),
        weights: Float32Array.from(Array.from({ length: 4 }, () => weights).flat()),
        layers,
      },
      (key) => key,
      assets,
      encoding,
    ).unwrap();
    const material = output['section/0/material'];
    if (material?.kind !== 'material') throw new Error('missing cooked material');
    const modes = material.parameters?.find((param) => param.name === 'terrainLayerModes')?.default;
    if (!Array.isArray(modes)) throw new Error('missing layer modes');
    device.queue
      .writeBuffer(
        uniform,
        0,
        Float32Array.from([...modes, encoding.kind === 'ids' ? 1 : 0, 0, ...uv]),
      )
      .unwrap();
    const names = [
      'weights',
      'terrain-color-layers',
      'terrain-normal-height-layers',
      'terrain-orm-layers',
      'terrain-emission-layers',
    ];
    const textures = names.map((name) => {
      const asset =
        output[`${encoding.kind === 'ids' && name !== 'weights' ? 'layers' : 'section/0'}/${name}`];
      if (asset?.kind !== 'texture') throw new Error('missing derived texture');
      const width = asset.shape.extent.width,
        height = asset.shape.extent.height,
        layers = 'layers' in asset.shape.extent ? asset.shape.extent.layers : 1;
      const texture = device
        .createTexture({
          size: { width, height, depthOrArrayLayers: layers },
          format: asset.format,
          usage: 0x02 | 0x04,
        })
        .unwrap();
      const data = asset.data.subarray(0, width * height * layers * (name === 'weights' ? 4 : 8));
      device.queue
        .writeTexture(
          { texture },
          data,
          { bytesPerRow: width * (name === 'weights' ? 4 : 8), rowsPerImage: height },
          { width, height, depthOrArrayLayers: layers },
        )
        .unwrap();
      return texture;
    });
    const views = textures.map((texture, i) =>
      device.createTextureView(texture, { dimension: i === 0 ? '2d' : '2d-array' }).unwrap(),
    );
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
          ...views.map((view, i) => ({
            binding: i + 1,
            resource: { kind: 'textureView' as const, value: view },
          })),
          { binding: 6, resource: { kind: 'sampler', value: sampler } },
        ],
      })
      .unwrap();
    const result: number[][] = [];
    try {
      for (const pipeline of pipelines) {
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: target },
          { buffer: read, bytesPerRow: 256 },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await read.mapAsync(0x01)).unwrap();
        result.push(Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16))));
        mapped.unmap();
      }
    } finally {
      for (const texture of textures) device.destroyTexture(texture).unwrap();
    }
    return result;
  };
  try {
    const zero = await run([{ material: 'red', blend: 'weight' }], [0], {
      red: material([1, 0, 0, 1]),
    });
    expect(zero[0]).toEqual([1, 1, 1, 1]);
    // Native shader arithmetic may preserve either IEEE zero sign; the
    // exact numerical default remains [0, 1, 0, 1].
    const zeroNormal = zero[1];
    if (zeroNormal === undefined) throw new Error('missing zero-weight normal output');
    expect(zeroNormal.map((value) => (value === 0 ? 0 : value))).toEqual([0, 1, 0, 1]);
    expect(zero[2]).toEqual([1, 0.5, 0, 1]);
    const colors = {
      red: material([1, 0, 0, 1]),
      green: material([0, 1, 0, 1]),
      blue: material([0, 0, 1, 1]),
    };
    const idPolicy = { kind: 'ids', maxWeightError: 0.01 } as const;
    const idZero = await run([{ material: 'red', blend: 'weight' }], [0], colors, idPolicy);
    expect(idZero).toEqual(zero);
    const manyLayers: TerrainLayer[] = Array.from({ length: 32 }, (_, i) => ({
      material: `layer-${i}`,
      blend: 'weight',
    }));
    const manyAssets = Object.fromEntries(
      manyLayers.map((layer, i) => [
        layer.material,
        material(i === 31 ? [0, 0, 1, 1] : [1, 0, 0, 1]),
      ]),
    );
    const manyWeights = Array<number>(32).fill(0);
    manyWeights[0] = 0.25;
    manyWeights[31] = 0.75;
    const compact = await run(manyLayers, manyWeights, manyAssets, idPolicy);
    const ordinary = await run(manyLayers, manyWeights, manyAssets);
    for (let channel = 0; channel < 4; channel++)
      expect(
        Math.abs((compact[0]?.[channel] ?? 0) - (ordinary[0]?.[channel] ?? 0)),
      ).toBeLessThanOrEqual(1 / 255);
    expect(compact[0]?.[2]).toBeCloseTo(1 - 16384 / 65535, 5);
    const triangle: TerrainSource = {
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(4),
      layers: [
        { material: 'red', blend: 'weight' },
        { material: 'green', blend: 'weight' },
        { material: 'blue', blend: 'weight' },
      ],
      weights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]),
    };
    const three = await run(
      triangle.layers,
      [],
      colors,
      { kind: 'ids', maxWeightError: 1 },
      triangle,
    );
    expect(three[0]).toEqual([0, 0.5, 0.5, 1]);
    const upper = await run(
      triangle.layers,
      [],
      colors,
      { kind: 'ids', maxWeightError: 1 },
      triangle,
      [0.75, 0.75],
    );
    expect(upper[0]).toEqual([0.5, 0.25, 0.25, 1]);
    const edge = await run(
      triangle.layers,
      [],
      colors,
      { kind: 'ids', maxWeightError: 1 },
      triangle,
      [1, 1],
    );
    expect(edge[0]).toEqual([1, 0, 0, 1]);
    const alpha = await run(
      [
        { material: 'red', blend: 'weight' },
        { material: 'green', blend: 'alpha' },
        { material: 'blue', blend: 'alpha' },
      ],
      [1, 0.25, 0.5],
      colors,
    );
    const reversed = await run(
      [
        { material: 'red', blend: 'weight' },
        { material: 'blue', blend: 'alpha' },
        { material: 'green', blend: 'alpha' },
      ],
      [1, 0.5, 0.25],
      colors,
    );
    const a = 64 / 255,
      b = 128 / 255;
    for (const [actual, expected] of [
      [alpha[0], [(1 - a) * (1 - b), a * (1 - b), b, 1]],
      [reversed[0], [(1 - a) * (1 - b), a, b * (1 - a), 1]],
    ] as const)
      for (let c = 0; c < 4; c++) expect(actual?.[c]).toBeCloseTo(expected[c] ?? 0, 5);
    expect(alpha[0]?.[1]).not.toBeCloseTo(reversed[0]?.[1] ?? 0, 3);
    const epsilon = await run(
      [
        { material: 'red', blend: 'height', height: 'zero', heightRange: [0, 1] },
        { material: 'blue', blend: 'height', height: 'zero', heightRange: [0, 1] },
      ],
      [0, 0],
      {
        red: material([1, 0, 0, 1], 'positive'),
        blue: material([0, 0, 1, 1], 'negative'),
        positive: texel([255, 128, 128, 255]),
        negative: texel([0, 127, 127, 255]),
        zero: texel([0, 0, 0, 255]),
      },
    );
    expect(epsilon[0]).toEqual([0.5, 0, 0.5, 1]);
    // Both zero-author-weight height layers must participate; their opposing normals
    // cancel and the fragment uses the neutral unit normal instead of NaN/zero.
    const epsilonNormal = epsilon[1];
    if (epsilonNormal === undefined) throw new Error('missing height-blend normal output');
    expect(epsilonNormal.map((value) => (value === 0 ? 0 : value))).toEqual([0, 1, 0, 1]);
  } finally {
    device.destroyTexture(target).unwrap();
    device.destroyBuffer(read).unwrap();
    device.destroyBuffer(uniform).unwrap();
  }
}, 60000);
