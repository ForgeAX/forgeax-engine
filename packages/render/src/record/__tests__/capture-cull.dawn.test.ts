import { mat4 } from '@forgeax/engine-math';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import { buildPlanarReflectionView } from '../../capture/planar-view';
import { computeViewProjectionMatrix } from '../helpers';
import { captureCullFixture } from './capture-cull.fixture';

for (const mirror of [false, true])
  it(`preserves real GPU pixels while removing outside capture draws (mirror=${mirror})`, async () => {
    const { device, native } = await nativeDeviceFixture();
    native.pushErrorScope('validation');
    try {
      const f = captureCullFixture();
      let camera = f.camera;
      if (mirror) {
        const world = mat4.invert(
          mat4.create(),
          mat4.lookAt(mat4.create(), [0, 3, 5], [0, 0, 0], [0, 1, 0]),
        );
        const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100);
        const view = buildPlanarReflectionView({
          world,
          projection,
          plane: [0, 1, 0, 0],
          clipBias: 0,
        });
        assert(view);
        camera = {
          ...camera,
          world: view.world,
          position: view.position,
          captureProjection: view.projection,
        };
        f.put(1, 0, 1, 0);
        f.put(2, 0, -1, 0);
        f.put(3, 30, 1, 0);
      } else {
        f.put(1);
        f.put(2, 0, 0, 5);
        f.put(3, 30, 0, -5);
      }
      const rows = [1, 2, 3].map((key) => f.source(key));
      const visible = f.prepare(camera);
      const selected = rows
        .map((row, index) => (visible.visible(row) ? index : -1))
        .filter((index) => index >= 0);
      expect(selected).toEqual([0]);
      const module = (
        await createShaderModule(device, {
          code: `
@group(0) @binding(0) var<uniform> viewProjection: mat4x4<f32>;
@vertex fn vs(@location(0) p: vec3<f32>, @location(1) c0: vec4<f32>,
  @location(2) c1: vec4<f32>, @location(3) c2: vec4<f32>, @location(4) c3: vec4<f32>)
  -> @builtin(position) vec4<f32> {
  return viewProjection * mat4x4<f32>(c0, c1, c2, c3) * vec4<f32>(p, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(.25, .5, .75, 1.0); }
`,
        })
      ).unwrap();
      const layout = device
        .createBindGroupLayout({
          entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
        })
        .unwrap();
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
      const pipeline = device
        .createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module,
            entryPoint: 'vs',
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
              {
                arrayStride: 64,
                stepMode: 'instance',
                attributes: [0, 1, 2, 3].map((column) => ({
                  shaderLocation: column + 1,
                  offset: column * 16,
                  format: 'float32x4' as const,
                })),
              },
            ],
          },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        })
        .unwrap();
      const projection = device.createBuffer({ size: 64, usage: 64 | 8 }).unwrap();
      device.queue
        .writeBuffer(projection, 0, computeViewProjectionMatrix(camera, mat4.create()))
        .unwrap();
      const group = device
        .createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: projection } } }],
        })
        .unwrap();
      const vertices = device.createBuffer({ size: 36, usage: 32 | 8 }).unwrap();
      device.queue
        .writeBuffer(vertices, 0, Float32Array.of(-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0))
        .unwrap();
      const worlds = device.createBuffer({ size: rows.length * 64, usage: 32 | 8 }).unwrap();
      for (const [index, row] of rows.entries())
        device.queue.writeBuffer(worlds, index * 64, row.transform.world).unwrap();
      const width = 32,
        height = 32,
        bytesPerRow = 256;
      const render = async (indices: readonly number[]) => {
        const texture = device
          .createTexture({ size: { width, height }, format: 'rgba8unorm', usage: 16 | 1 })
          .unwrap();
        const view = device.createTextureView(texture, {}).unwrap();
        const output = device.createBuffer({ size: bytesPerRow * height, usage: 9 }).unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.setVertexBuffer(0, vertices);
        for (const index of indices) {
          pass.setVertexBuffer(1, worlds, index * 64, 64);
          pass.draw(3);
        }
        pass.end();
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: output, bytesPerRow, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const mapped = (await output.mapAsync(1)).unwrap();
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
          pixels.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
        mapped.unmap();
        device.destroyBuffer(output).unwrap();
        device.destroyTexture(texture).unwrap();
        return pixels;
      };
      const baseline = await render([0, 1, 2]),
        culled = await render(selected),
        empty = await render([]);
      expect(culled).toEqual(baseline);
      expect(culled).not.toEqual(empty);
      expect(
        baseline.filter((value, index) => index % 4 !== 3 && value !== 0).length,
      ).toBeGreaterThan(3);
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      native.destroy();
    }
  });
