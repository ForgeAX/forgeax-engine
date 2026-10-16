import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

export async function verifyCachedDepth() {
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const errors: string[] = [];
  const depth = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'depth32float',
      mipLevelCount: 2,
      usage: 0x14,
    })
    .unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  for (let layer = 0; layer < 2; layer++) {
    for (let mip = 0; mip < 2; mip++) {
      const view = device
        .createTextureView(depth, {
          dimension: '2d',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          baseMipLevel: mip,
          mipLevelCount: 1,
          aspect: 'depth-only',
        })
        .unwrap();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: (layer * 2 + mip + 1) / 4,
          },
        })
        .end();
    }
  }
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const output = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'r32float', usage: 0x11 })
    .unwrap();
  const outputView = device.createTextureView(output, {}).unwrap();
  const depthView = device
    .createTextureView(depth, { dimension: '2d-array', aspect: 'depth-only' })
    .unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      ],
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { kind: 'textureView', value: depthView } }],
    })
    .unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, {
      code: `
    @group(0) @binding(0) var cached: texture_depth_2d_array;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
      let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      return vec4f(p[i],0,1);
    }
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) f32 {
      return textureLoad(cached,vec2i(0),i32(p.x),i32(p.y));
    }`,
    })
  ).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
    })
    .unwrap();
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const commands = device.createCommandEncoder({}).unwrap();
  const pass = commands.beginRenderPass({
    colorAttachments: [
      {
        view: outputView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
  device.queue.submit([commands.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  (await recorder.frameBoundary()).unwrap();
  const tape = decodeTape((await capture).unwrap().bytes).unwrap();
  const model = buildFrameModel(tape);
  expect(model.unseededResources.filter((resource) => resource.format === 'depth32float')).toEqual(
    [],
  );
  const depthSeed = tape.bootstrap.find(
    (resource) =>
      resource.create.kind === 'createTexture' &&
      (resource.create.desc as { format?: string }).format === 'depth32float',
  );
  expect(depthSeed?.initialData.length).toBe(1);
  const omitted = buildFrameModel({
    ...tape,
    bootstrap: tape.bootstrap.map((resource) =>
      resource === depthSeed ? { ...resource, initialData: [] } : resource,
    ),
  });
  expect(omitted.unseededResources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ resourceId: depthSeed?.handleId, format: 'depth32float' }),
    ]),
  );
  const work = model.works[0];
  const resource = work?.attachments?.colorViewHandleIds[0];
  if (work === undefined || resource === undefined) throw new Error('missing depth consumer');
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  if (raw === undefined) throw new Error('missing fresh replay device');
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const result = (await replay.readResourceAtWork(resource, work.workIndex)).unwrap();
    expect([...new Float32Array(result.bytes.buffer, result.bytes.byteOffset, 4)]).toEqual([
      0.25, 0.75, 0.5, 1,
    ]);
    expect(errors).toEqual([]);
  } finally {
    (await replay.dispose()).unwrap();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
