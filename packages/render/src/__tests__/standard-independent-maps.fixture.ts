import { vec3 } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { STANDARD_SAMPLE_REUSE, STANDARD_TEXTURE_MASK_OVERRIDE } from '@forgeax/engine-shader';
import {
  derive,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_SURFACE_PARAM_SCHEMA,
} from '@forgeax/engine-types';
import { expect } from 'vitest';
import alphaHashSource from '../../../shader/src/alpha-hash.wgsl?raw';
import surfaceSource from '../../../shader/src/default_standard_surface.wgsl?raw';
import abiSource from '../../../shader/src/surface_v1.wgsl?raw';
import samplingSource from '../../../shader/src/surface-sampling.wgsl?raw';
import normalSource from '../../../shader/src/tbn.wgsl?raw';
import coordinatesSource from '../../../shader/src/texture-coordinates.wgsl?raw';
import { generateParameterModule } from '../../../shader-compiler/src/material/cook';
import { lowerStandardPhysicalBindings } from '../../../shader-compiler/src/material/lower-standard-contract';
import { packMaterialProgramRow } from '../material-row';
import { buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';
import { materialStandardTextureMask } from '../render-system-extract';

// Execute the shipped Surface, generated ABI, material row writer and PSO
// overrides. The diagnostic fragment exposes Surface outputs before lighting;
// no material arithmetic is duplicated in the shader used by this test.
const schema = [
  ...STANDARD_SURFACE_PARAM_SCHEMA,
  ...STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) =>
    [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
      'bumpTexture',
      'emissiveTexture',
      'occlusionTexture',
      'metallicTexture',
      'roughnessTexture',
      'alphaTexture',
    ].includes(entry.name),
  ),
];
const derived = derive(schema);
// Every texture and alpha-hash block is live; the raster fixture has no ray
// context and no projection fields in its contract.
const UNDEFINED = new Set([
  'RAY_SURFACE_CONTEXT',
  'TRIPLANAR_PROJECTION_AVAILABLE',
  'OBJECT_SPACE_NORMAL_AVAILABLE',
]);
function preprocess(text: string): string {
  const live: boolean[] = [];
  return text
    .split('\n')
    .filter((line) => {
      const ifdef = /^#ifdef\s+(\w+)/.exec(line);
      if (ifdef) live.push(!UNDEFINED.has(ifdef[1] as string));
      else if (line.startsWith('#else')) live.push(!(live.pop() as boolean));
      else if (line.startsWith('#endif')) live.pop();
      return !line.startsWith('#') && live.every(Boolean);
    })
    .join('\n');
}
const source = lowerStandardPhysicalBindings(
  preprocess(
    [
      generateParameterModule(schema),
      abiSource,
      samplingSource,
      coordinatesSource,
      normalSource,
      alphaHashSource,
      surfaceSource,
    ].join('\n'),
  ) +
    `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}
@fragment fn fs() -> @location(0) vec4f {
  var input: SurfaceInput;
  input.frontFacing = true;
  input.vertexNormalWS = vec3f(0,0,1);
  input.tangentWS = vec4f(1,0,0,1);
  input.uv0 = vec2f(0.25,0.5);
  input.uv1 = vec2f(0.75,0.5);
  input.vertexColor = vec4f(1,1,1,0.5);
  let value = evaluate_surface(input);
  if (value.opacity <= value.alphaClipThreshold) { discard; }
  return vec4f(value.metallic, value.roughness, value.opacity, 1);
}`,
  schema,
  true,
);

const texels: Readonly<Record<string, readonly number[]>> = {
  metallicRoughnessTexture: [200, 150, 100, 250, 20, 30, 40, 50],
  metallicTexture: [32, 64, 128, 192, 224, 160, 96, 48],
  roughnessTexture: [80, 120, 160, 200, 40, 60, 100, 140],
  alphaTexture: [240, 180, 120, 60, 20, 40, 80, 160],
  baseColorTexture: [255, 255, 255, 192, 255, 255, 255, 64],
};

export async function verifyIndependentMaps(observeDevice: (device: RhiDevice) => () => void) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const disposeDevice = observeDevice(device);
  const uniform = device.createBuffer({ size: derived.totalBytes, usage: 0x48 }).unwrap();
  const output = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'rgba32float', usage: 0x11 })
    .unwrap();
  const outputView = device.createTextureView(output, {}).unwrap();
  const readback = device.createBuffer({ size: 256, usage: 0x09 }).unwrap();
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }).unwrap();
  const repeatSampler = device
    .createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'repeat',
    })
    .unwrap();
  const views = derived.resourceBindings
    .filter((resource) => resource.kind === 'texture')
    .map((resource) => {
      const texture = device
        .createTexture({
          label: resource.name,
          size: { width: 2, height: 1 },
          format: 'rgba8unorm',
          usage: 0x06,
        })
        .unwrap();
      device.queue
        .writeTexture(
          { texture },
          new Uint8Array(texels[resource.name] ?? [255, 255, 255, 255, 255, 255, 255, 255]),
          { bytesPerRow: 8 },
          { width: 2, height: 1 },
        )
        .unwrap();
      return [resource.name, device.createTextureView(texture, {}).unwrap()] as const;
    });
  const textureViews = new Map(views);
  const materialLayout = device
    .createBindGroupLayout({ entries: buildPbrMaterialUserRegionEntries(schema) })
    .unwrap();
  const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [emptyLayout, materialLayout] })
    .unwrap();
  const shader = (await recorder.backend.createShaderModule(device, { code: source })).unwrap();
  const independent = ['metallicTexture', 'roughnessTexture', 'alphaTexture'];
  const cases = [
    { name: 'neutral', slots: [], channel: 0, uv: false, cutoff: 0 },
    { name: 'packed', slots: ['metallicRoughnessTexture'], channel: 2, uv: false, cutoff: 0 },
    { name: 'default-channels', slots: independent, channel: undefined, uv: false, cutoff: 0 },
    {
      name: 'metallic-only',
      slots: ['metallicTexture', 'metallicRoughnessTexture'],
      channel: undefined,
      uv: false,
      cutoff: 0,
    },
    {
      name: 'roughness-only',
      slots: ['roughnessTexture', 'metallicRoughnessTexture'],
      channel: undefined,
      uv: false,
      cutoff: 0,
    },
    ...[0, 1, 2, 3].map((channel) => ({
      name: `channel-${channel}`,
      slots: [...independent, 'metallicRoughnessTexture', 'baseColorTexture'],
      channel,
      uv: false,
      cutoff: 0,
    })),
    { name: 'uv-set-transform', slots: independent, channel: 0, uv: true, cutoff: 0 },
    {
      name: 'shared-independent-image',
      slots: independent,
      channel: undefined,
      uv: false,
      cutoff: 0,
      alias: { roughnessTexture: 'metallicTexture', alphaTexture: 'metallicTexture' },
      reuse: [0, 3, 3],
    },
    {
      name: 'shared-image-different-uv',
      slots: independent,
      channel: undefined,
      uv: false,
      roughUv: true,
      cutoff: 0,
      alias: { roughnessTexture: 'metallicTexture', alphaTexture: 'metallicTexture' },
      reuse: [0, 0, 3],
    },
    {
      name: 'shared-image-different-sampler',
      slots: independent,
      channel: undefined,
      uv: false,
      cutoff: 0,
      samplerMismatch: true,
      alias: { roughnessTexture: 'metallicTexture', alphaTexture: 'metallicTexture' },
      reuse: [0, 0, 3],
    },
    {
      name: 'shared-packed-and-base-images',
      slots: [...independent, 'metallicRoughnessTexture', 'baseColorTexture'],
      channel: undefined,
      uv: false,
      cutoff: 0,
      alias: {
        metallicTexture: 'metallicRoughnessTexture',
        roughnessTexture: 'metallicRoughnessTexture',
        alphaTexture: 'baseColorTexture',
      },
      reuse: [2, 2, 1],
    },
    { name: 'alpha-discard', slots: independent, channel: 3, uv: false, cutoff: 0.1 },
    { name: 'alpha-pass', slots: independent, channel: 1, uv: false, cutoff: 0.1 },
  ];
  const receipts = [];
  try {
    for (const row of cases) {
      const aliases: Readonly<Record<string, string>> | undefined = row.alias;
      const coordinates = new Map([
        [
          'metallicTexture',
          {
            set: row.uv ? 1 : 0,
            transform: { offset: [row.samplerMismatch ? -0.5 : 0, 0] as const },
          },
        ],
        [
          'roughnessTexture',
          {
            set: 0,
            transform: {
              offset: [row.samplerMismatch ? -0.5 : row.uv || row.roughUv ? 0.5 : 0, 0] as const,
            },
          },
        ],
        [
          'alphaTexture',
          { set: 0, transform: { offset: [row.samplerMismatch ? -0.5 : 0, 0] as const } },
        ],
      ]);
      const payload = packMaterialProgramRow(
        schema,
        {
          baseColor: vec3.create(1, 1, 1),
          metallic: 0.8,
          roughness: 0.6,
          paramSnapshot: {
            baseColor: [1, 1, 1, 0.5],
            metallic: 0.8,
            roughness: 0.6,
            ...(row.channel === undefined
              ? {}
              : {
                  metallicChannel: row.channel,
                  roughnessChannel: row.channel,
                  alphaChannel: row.channel,
                }),
            alphaCutoff: row.cutoff,
          },
          textureCoordinates: coordinates,
        },
        derived.totalBytes,
      );
      if (payload === undefined) throw new Error('material row overflow');
      device.queue.writeBuffer(uniform, 0, payload).unwrap();
      const textureNames = [...textureViews.keys()];
      const textureHandles = new Map(
        row.slots.map((slot) => [slot, textureNames.indexOf(aliases?.[slot] ?? slot)]),
      );
      const samplerHandles = row.samplerMismatch ? new Map([['roughnessTexture', 2]]) : new Map();
      const mask = materialStandardTextureMask(
        undefined,
        'forgeax::default-standard-pbr',
        Object.fromEntries(row.slots.map((slot) => [slot, 1])),
        { textureHandles, samplerHandles, textureCoordinates: coordinates },
      );
      if (mask === undefined) throw new Error('missing Standard texture mask');
      if (row.reuse) {
        expect(
          STANDARD_SAMPLE_REUSE.map(
            ({ shift, sources }) =>
              (mask >>> shift) & (2 ** Math.ceil(Math.log2(sources.length + 1)) - 1),
          ),
        ).toEqual(row.reuse);
      }
      const group = device
        .createBindGroup({
          layout: materialLayout,
          entries: [
            { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
            ...derived.resourceBindings.map((resource) => {
              if (resource.kind === 'sampler') {
                return {
                  binding: resource.binding,
                  resource: {
                    kind: 'sampler' as const,
                    value:
                      row.samplerMismatch && resource.name === 'roughnessTexture_sampler'
                        ? repeatSampler
                        : sampler,
                  },
                };
              }
              const view = textureViews.get(aliases?.[resource.name] ?? resource.name);
              if (view === undefined) throw new Error(`missing texture ${resource.name}`);
              return {
                binding: resource.binding,
                resource: { kind: 'textureView' as const, value: view },
              };
            }),
          ],
        })
        .unwrap();
      const pipeline = device
        .createRenderPipeline({
          layout,
          vertex: { module: shader, entryPoint: 'vs', buffers: [] },
          fragment: {
            module: shader,
            entryPoint: 'fs',
            constants: { [STANDARD_TEXTURE_MASK_OVERRIDE]: mask },
            targets: [{ format: 'rgba32float' }],
          },
        })
        .unwrap();
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, emptyGroup);
      pass.setBindGroup(1, group, [0]);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const live = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16))];
      mapped.unmap();
      const sample = (slot: string, channel: number, right = false) =>
        (texels[aliases?.[slot] ?? slot]?.[(right ? 4 : 0) + channel] ?? 255) / 255;
      const packed = row.slots.includes('metallicRoughnessTexture');
      const metallic =
        0.8 *
        (row.slots.includes('metallicTexture')
          ? sample('metallicTexture', row.channel ?? 2, row.uv)
          : packed
            ? sample('metallicRoughnessTexture', row.channel ?? 2)
            : 1);
      const roughness = Math.max(
        0.04,
        0.6 *
          (row.slots.includes('roughnessTexture')
            ? sample(
                'roughnessTexture',
                row.channel ?? 1,
                row.uv || row.roughUv || row.samplerMismatch,
              )
            : packed
              ? sample('metallicRoughnessTexture', row.channel ?? 1)
              : 1),
      );
      const opacity =
        0.25 *
        (row.slots.includes('alphaTexture') ? sample('alphaTexture', row.channel ?? 1) : 1) *
        (row.slots.includes('baseColorTexture') ? sample('baseColorTexture', 3) : 1);
      const expected = opacity <= row.cutoff ? [0, 0, 0, 0] : [metallic, roughness, opacity, 1];
      live.forEach((value, index) => {
        expect(value, row.name).toBeCloseTo(expected[index] ?? Number.NaN, 5);
      });
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      expect(model.works).toHaveLength(1);
      expect(model.unseededResources.filter((entry) => entry.format === 'rgba8unorm')).toEqual([]);
      const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const disposeFresh = observeDevice(fresh);
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const inspection = (
          await replay.inspectWork(0, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        expect(inspection.bindings?.length).toBeGreaterThan(0);
        expect(inspection.pipeline).toBeDefined();
        const bytes = inspection.attachment?.bytes;
        if (bytes === undefined) throw new Error('missing replay pixels');
        const replayPixels = [...new Float32Array(bytes.buffer, bytes.byteOffset, 4)];
        expect(replayPixels).toEqual(live);
        receipts.push({
          name: row.name,
          digest: captured.digest,
          bytes: captured.bytes,
          workIndex: 0,
          eventIndex: inspection.eventIndex,
          live,
          replay: replayPixels,
        });
      } finally {
        (await replay.dispose()).unwrap();
        disposeFresh();
      }
    }
    return receipts;
  } finally {
    (await recorder.dispose()).unwrap();
    disposeDevice();
  }
}
