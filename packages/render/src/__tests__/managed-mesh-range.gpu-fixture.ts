import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

export async function verifyManagedMeshRange(channel: 'vertices' | 'indices') {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = _internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry();
  const records = runtimeAssets(assets);
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const indexed = channel === 'indices';
  const values = indexed
    ? Float32Array.of(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        1,
        0,
        0,
        1,
      )
    : new Float32Array(9);
  const source: MeshAsset = {
    kind: 'mesh',
    vertices: values,
    attributes: { position: values },
    ...(indexed ? { indices: Uint16Array.of(0, 1, 2) } : {}),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indexed ? 3 : 0,
        vertexCount: values.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
  const first = assets.create(source).unwrap(),
    second = assets.copy(first).unwrap();
  const mesh = (handle: AssetHandle<'mesh'>) => records.borrow<MeshAsset>(handle).unwrap();
  const old = store.ensureResident(first, mesh(first)).unwrap();
  const sibling = store.ensureResident(second, mesh(second)).unwrap();
  expect(sibling.vertexBuffer).toBe(old.vertexBuffer);
  const lease = store.retainMeshResidency(first);
  assert(lease);
  const observer = assets.observe().unwrap();
  const shader = (
    await rhi.createShaderModule(device, {
      code: `
struct Out { @builtin(position) position: vec4f, @location(0) value: vec3f };
@vertex fn vertex(@builtin(vertex_index) i: u32, @location(0) value: vec3f) -> Out {
  var corners = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var result: Out;
  result.position = vec4f(corners[i % 3u], 0, 1);
  result.value = value;
  return result;
}
@fragment fn fragment(input: Out) -> @location(0) vec4f { return vec4f(input.value, 1); }
`,
    })
  ).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: {
        module: shader,
        entryPoint: 'vertex',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 17 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256, usage: 9 }).unwrap();
  const render = async (entry: typeof old) => {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 1, a: 1 } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, entry.vertexBuffer.handle);
    if (entry.indexBuffer === null) pass.draw(3);
    else {
      pass.setIndexBuffer(entry.indexBuffer.handle, entry.indexFormat);
      pass.drawIndexed(3);
    }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = device.queue.onSubmittedWorkDone();
    store.trackMeshSubmission(completed);
    lease.track(completed);
    const mapping = (await readback.mapAsync(1)).unwrap();
    const pixel = new Uint8Array(mapping.getMappedRange().unwrap().slice(0, 4));
    mapping.unmap();
    return [...pixel];
  };
  const edit = (r: number, g: number, b: number) => {
    assets
      .writeRange(
        first,
        indexed
          ? { first: 0, indices: g === 1 ? Uint16Array.of(3, 4, 5) : Uint16Array.of(6, 7, 8) }
          : {
              attribute: 'position',
              first: 0,
              values: Float32Array.of(r, g, b, r, g, b, r, g, b),
            },
      )
      .unwrap();
    const batch = observer.read().unwrap(),
      change = batch.changes[0];
    assert(change);
    store.adoptMeshChange(change, mesh(first)).unwrap();
    batch.accept();
    return store.ensureResident(first, mesh(first)).unwrap();
  };
  try {
    expect(await render(old)).toEqual([0, 0, 0, 255]);
    const green = edit(0, 1, 0);
    expect(indexed ? green.indexBuffer : green.vertexBuffer).not.toBe(
      indexed ? old.indexBuffer : old.vertexBuffer,
    );
    expect(await render(green)).toEqual([0, 255, 0, 255]);
    expect(await render(sibling)).toEqual([0, 0, 0, 255]);
    expect(await render(old)).toEqual([0, 0, 0, 255]);
    const blue = edit(0, 0, 1);
    expect(indexed ? blue.indexBuffer : blue.vertexBuffer).toBe(
      indexed ? green.indexBuffer : green.vertexBuffer,
    );
    expect(await render(blue)).toEqual([0, 0, 255, 255]);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    await lease.release(false);
    observer.dispose();
    store.destroyAll();
    assets.dispose();
    device.destroyTexture(target);
    device.destroyBuffer(readback);
    await device.queue.onSubmittedWorkDone();
  }
}
