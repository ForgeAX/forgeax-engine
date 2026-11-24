import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import {
  boundSceneTextureReaderKernel,
  sceneTextureCases,
} from '../../../../shader/src/__tests__/sdf-scene-texture.fixture';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  createSdfSceneTextureKernel,
  invalidateSdfSceneTexture,
  packSdfSceneTexture,
  planSdfSceneTexture,
  SDF_SCENE_TEXTURE_PROJECT_WGSL,
} from '../../raytracing/sdf-scene-texture';

async function readRecord(device: RhiDevice, output: Buffer) {
  const staging = device.createBuffer({ size: 96, usage: 9 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyBufferToBuffer(output, 0, staging, 0, 96);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapping = (await staging.mapAsync(1)).unwrap();
    const data = new Uint32Array(mapping.getMappedRange().unwrap()).slice();
    mapping.unmap();
    return data;
  } finally {
    device.destroyBuffer(staging).unwrap();
  }
}
it('uses the actual projection and reader across repeated edits without a stale invocation snapshot', async () => {
  const device = (
    await (
      await webgpu.rhi.requestAdapter({ powerPreference: 'high-performance' })
    )
      .unwrap()
      .requestDevice()
  ).unwrap();
  const raw = device.nativeDevice().unwrap();
  if (!raw) throw Error('Actual raw device identity required');
  const info = raw.adapterInfo;
  const identity = {
    vendor: info?.vendor,
    architecture: info?.architecture,
    device: info?.device,
    description: info?.description,
  };
  if (![identity.vendor, identity.device, identity.description].some(Boolean))
    throw Error('Actual adapter identity required');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const directory =
    process.env.FORGEAX_SCENE_TEXTURE_INTEGRATION_OUTPUT ??
    join(tmpdir(), `forgeax-scene-integration-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const source = sceneTextureCases()[0];
  if (!source) throw Error('Authored raw source missing');
  const instances = source.words.slice(16, 16 + (source.source[0] ?? 0)),
    fields = source.words.slice(16 + (source.source[0] ?? 0), source.words[12]);
  const plan = planSdfSceneTexture(instances.byteLength, fields.byteLength, 1, {
    maxTextureDimension2D: 8,
    maxBytes: 768,
  }).unwrap();
  const owned: Buffer[] = [];
  const buffer = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage }).unwrap();
    owned.push(b);
    return b;
  };
  const texture = device
    .createTexture({
      size: { width: plan.width, height: plan.height },
      format: 'rgba32uint',
      usage: 15,
    })
    .unwrap();
  const results: { phase: string; actual: number[]; expected: number[] }[] = [];
  try {
    const instanceBuffer = buffer(instances.byteLength, 140),
      fieldBuffer = buffer(fields.byteLength, 140),
      params = buffer(32, 76),
      output = buffer(96, 132);
    const view = device.createTextureView(texture, { dimension: '2d' }).unwrap();
    const projectionCode = (
      await compileShader(SDF_SCENE_TEXTURE_PROJECT_WGSL, { id: 'scene-integration-project' })
    ).unwrap().wgsl;
    const readerCode = (
      await compileShader(boundSceneTextureReaderKernel(), { id: 'scene-integration-reader' })
    ).unwrap().wgsl;
    writeFileSync(join(directory, 'projection.wgsl'), projectionCode);
    writeFileSync(join(directory, 'reader.wgsl'), readerCode);
    const projection = (
      await createSdfSceneTextureKernel(
        device,
        (await webgpu.createShaderModule(device, { code: projectionCode })).unwrap(),
      )
    ).unwrap();
    const readerLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
          { binding: 1, visibility: 4, buffer: { type: 'uniform', minBindingSize: 32 } },
          { binding: 2, visibility: 4, buffer: { type: 'storage', minBindingSize: 96 } },
        ],
      })
      .unwrap();
    const reader = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [readerLayout] }).unwrap(),
        compute: {
          module: (await webgpu.createShaderModule(device, { code: readerCode })).unwrap(),
          entryPoint: 'main',
        },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: readerLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: params, size: 32 } } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: output, size: 96 } } },
        ],
      })
      .unwrap();
    const invalid = new Array<number>(24).fill(0);
    invalid[22] = 1;
    invalid[23] = 0x51df0000;
    const expected = [...source.expected];
    expected[23] = 0x51df0000;
    const upload = (epoch: number) =>
      device.queue.writeBuffer(params, 0, packSdfSceneTexture(plan, epoch).unwrap()).unwrap();
    const record = async (phase: string, wanted: number[], project = false) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      if (project) {
        const pass = encoder.beginComputePass({ label: 'actual-canonical-projection' });
        projection
          .record(
            pass,
            {
              instances: { buffer: instanceBuffer, size: instances.byteLength },
              fields: { buffer: fieldBuffer, size: fields.byteLength },
            },
            { buffer: params, size: 32 },
            view,
            plan,
          )
          .unwrap();
        pass.end();
      }
      const pass = encoder.beginComputePass({ label: 'actual-accepted-reader' });
      pass.setPipeline(reader);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const actual = await readRecord(device, output);
      writeFileSync(join(directory, `${phase}.bin`), new Uint8Array(actual.buffer));
      results.push({ phase, actual: Array.from(actual), expected: wanted });
      expect(Array.from(actual), phase).toEqual(wanted);
    };
    device.queue.writeBuffer(instanceBuffer, 0, instances).unwrap();
    device.queue.writeBuffer(fieldBuffer, 0, fields).unwrap();
    upload(7);
    invalidateSdfSceneTexture(device, texture, 7).unwrap();
    await record('invalidated-before-first-copy', invalid);
    await record('source-epoch7-complete', expected, true);
    upload(8);
    await record('new-owner-epoch-rejects-old-ready-view', invalid);
    invalidateSdfSceneTexture(device, texture, 8).unwrap();
    instances[16] = 17;
    fields[52] = 0x80000001;
    device.queue.writeBuffer(instanceBuffer, 0, instances).unwrap();
    device.queue.writeBuffer(fieldBuffer, 0, fields).unwrap();
    await record('invalidated-during-canonical-edit', invalid);
    const edited = [...expected];
    edited[8] = 17;
    edited[18] = 0x80000001;
    await record('source-epoch8-complete', edited, true);
    const mismatch = packSdfSceneTexture(plan, 8).unwrap();
    mismatch[1] = 80;
    device.queue.writeBuffer(params, 0, mismatch).unwrap();
    await record('same-epoch-wrong-owner-span', invalid);
    upload(8);
    await record('restored-owner-span-reuses-complete-view', edited);
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);
  } finally {
    device.destroyTexture(texture);
    for (const b of owned) device.destroyBuffer(b);
    writeFileSync(
      join(directory, 'receipt.json'),
      JSON.stringify(
        {
          identity,
          results,
          errors,
          scope:
            'Actual RHI projection to integer reader and metadata packet across submitted edits. Not production Scene edit scheduling, geometry qualification, World/GI/performance acceptance.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
