import type { BindGroup, Buffer } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it, vi } from 'vitest';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { buildGpuDrivenPbrInstancesBindGroupLayout } from '../pbr-pipeline';
import { standardPbrInputs } from './gpu-driven-production-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

it('keeps old raster windows live while publishing actual prepared Inputs to main and shadow', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const buffers: Buffer[] = [];
  const allocate = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage }).unwrap();
    buffers.push(buffer);
    return buffer;
  };
  const available = GpuScene.create(device, 256).unwrap();
  assert(available.status === 'available');
  const scene = available.scene;
  const address = scene.inputs.arena.allocateDescriptor(4);
  scene.inputs.arena.writeDescriptorWord(address, 4, 0, 1);
  const oldRead = scene.inputs.capture();
  const oldInput = oldRead.buffer().unwrap();
  oldRead.seal().unwrap();
  const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
  const windowsLayout = buildGpuDrivenPbrInstancesBindGroupLayout(device, device.caps);
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [empty, empty, empty, windowsLayout] })
    .unwrap();
  const shader = (
    await createShaderModule(device, {
      code: `
@group(3) @binding(8) var<storage,read> inputs: array<u32>;
struct V { @builtin(position) p: vec4<f32>, @location(0) color: vec4<f32> }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> V {
  var p = array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
  var result: V; result.p = vec4<f32>(p[index],0,1);
  result.color = select(vec4<f32>(1,0,0,1), vec4<f32>(0,1,0,1), inputs[${address}u] == 9u);
  return result;
}
@fragment fn fragment(input: V) -> @location(0) vec4<f32> { return input.color; }
`,
    })
  ).unwrap();
  const standard = standardPbrInputs(device, shader, empty);
  assert(standard.materialArtifact !== undefined && standard.materialPipelineState !== undefined);
  const visible = allocate(4096, 128 | 8);
  const shadow = allocate(4096, 128 | 8);
  const readback = allocate(256 * 4, 1 | 8);
  const raster = MaterialAbiRasterAdapter.create({
    device,
    artifact: standard.materialArtifact,
    visibleBuffer: visible,
    pipelineState: {
      ...standard.materialPipelineState,
      gpuDrivenInstancesBindGroupLayout: windowsLayout,
      gpuDrivenPbrPipelineLayout: layout,
    },
  }).unwrap();
  const preparation = scene.inputs.prepareBuffer().unwrap();
  const target = device
    .createTexture({ size: { width: 4, height: 4 }, format: 'rgba8unorm', usage: 16 | 1 })
    .unwrap();
  try {
    raster.ensureSceneTables(
      scene.transformBuffer,
      scene.transformByteLength,
      scene.instanceBuffer,
      scene.rowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
      scene.primitiveBuffer,
      scene.rowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
      undefined,
      oldInput.buffer,
    );
    const mainA = raster.visibleWindowBindGroupForBuffer(visible, 0, 64).unwrap();
    const shadowA = raster.shadowVisibleWindowBindGroupForBuffer(shadow, 0, 64).unwrap();
    const task = raster
      .prepareInputBindings(scene.inputs, { kind: 'successor', preparation }, [visible, shadow])
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout,
        vertex: { module: shader, entryPoint: 'vertex', buffers: [] },
        fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const unused = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
    const view = device.createTextureView(target, {}).unwrap();
    const render = async (group: BindGroup) => {
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(pipeline);
      for (let index = 0; index < 3; index++) pass.setBindGroup(index, unused);
      pass.setBindGroup(3, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readback, bytesPerRow: 256 },
        { width: 4, height: 4 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const color = Array.from(new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4));
      mapped.unmap();
      return color;
    };
    expect(task.isCurrent()).toBe(false);
    expect(await render(mainA)).toEqual([255, 0, 0, 255]);
    for (let step = 0; step < 1000 && !preparation.isCurrent(); step++)
      preparation.step(64).unwrap();
    expect(preparation.isCurrent()).toBe(true);
    const mainB = task.replacement(mainA);
    const shadowB = task.replacement(shadowA);
    assert(mainB !== undefined && shadowB !== undefined);
    const create = vi.spyOn(device, 'createBindGroup');
    const write = vi.spyOn(device.queue, 'writeBuffer');
    try {
      preparation.commitPrepared().unwrap();
      task.publish().unwrap();
      expect(create).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      write.mockRestore();
    }
    scene.inputs.arena.writeDescriptorWord(address, 4, 0, 9);
    const nextRead = scene.inputs.capture();
    nextRead.buffer().unwrap();
    nextRead.seal().unwrap();
    try {
      expect(raster.visibleWindowBindGroupForBuffer(visible, 0, 64).unwrap()).toBe(mainB);
      expect(raster.shadowVisibleWindowBindGroupForBuffer(shadow, 0, 64).unwrap()).toBe(shadowB);
      expect(await render(mainB)).toEqual([0, 255, 0, 255]);
      expect(await render(shadowB)).toEqual([0, 255, 0, 255]);
      expect(await render(mainA)).toEqual([255, 0, 0, 255]);
      expect(await render(shadowA)).toEqual([255, 0, 0, 255]);
    } finally {
      nextRead.release();
      task.release();
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    raster.dispose();
    preparation.release();
    oldRead.release();
    scene.dispose();
    await device.queue.onSubmittedWorkDone();
    device.destroyTexture(target).unwrap();
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    native.destroy();
  }
});
