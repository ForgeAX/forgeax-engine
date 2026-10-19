import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from './errors';
import { readbackTexturePixelsBatch } from './readback';
import type { CreateShaderModuleFn } from './recorder/core';

function readbackFailure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}

function depthBlitShader(arrayed: boolean, mipLevel: number, arrayLayer: number): string {
  return `
@group(0) @binding(0) var sourceDepth: texture_depth_${arrayed ? '2d_array' : '2d'};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(i32(position.x), i32(position.y));
  return vec4<f32>(textureLoad(sourceDepth, pixel, ${arrayed ? `${arrayLayer}, ` : ''}${mipLevel}), 0.0, 0.0, 1.0);
}
`;
}

export async function readbackDepthTexture(
  device: RhiDevice,
  source: Texture,
  width: number,
  height: number,
  mipLevel: number,
  arrayLayer: number,
  createShaderModule: CreateShaderModuleFn,
  arrayed: boolean,
  isCancelled?: () => boolean,
): Promise<Result<Uint8Array, RhiDebugError>> {
  let output: Texture | undefined;
  try {
    if (isCancelled?.()) return readbackFailure('depth snapshot was cancelled');
    const sourceView = device.createTextureView(source, {
      dimension: arrayed ? '2d-array' : '2d',
      aspect: 'depth-only',
    });
    if (!sourceView.ok)
      return readbackFailure(
        `depth readback source view creation failed: ${sourceView.error.code}`,
      );

    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          texture: {
            sampleType: 'depth',
            viewDimension: arrayed ? '2d-array' : '2d',
            multisampled: false,
          },
        },
      ],
    });
    if (!layout.ok)
      return readbackFailure(`depth readback bind group layout failed: ${layout.error.code}`);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok)
      return readbackFailure(`depth readback pipeline layout failed: ${pipelineLayout.error.code}`);
    const shader = await createShaderModule(device, {
      code: depthBlitShader(arrayed, mipLevel, arrayLayer),
      label: 'rhi-debug-depth-readback',
    });
    if (!shader.ok) return readbackFailure(`depth readback shader failed: ${shader.error.code}`);
    if (isCancelled?.()) return readbackFailure('depth snapshot was cancelled');
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout.value,
      vertex: { module: shader.value, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: shader.value,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba32float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    if (!pipeline.ok)
      return readbackFailure(`depth readback pipeline failed: ${pipeline.error.code}`);
    const bindGroup = device.createBindGroup({
      layout: layout.value,
      entries: [{ binding: 0, resource: { kind: 'textureView', value: sourceView.value } }],
    });
    if (!bindGroup.ok)
      return readbackFailure(`depth readback bind group failed: ${bindGroup.error.code}`);

    const outputResult = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1,
      usage: 0x11,
    });
    if (!outputResult.ok)
      return readbackFailure(`depth readback output texture failed: ${outputResult.error.code}`);
    output = outputResult.value;
    const outputView = device.createTextureView(output, { dimension: '2d' });
    if (!outputView.ok)
      return readbackFailure(`depth readback output view failed: ${outputView.error.code}`);

    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return readbackFailure(`depth readback encoder failed: ${encoderResult.error.code}`);
    const pass = encoderResult.value.beginRenderPass({
      colorAttachments: [
        {
          view: outputView.value,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline.value);
    pass.setBindGroup(0, bindGroup.value);
    pass.draw(3, 1, 0, 0);
    pass.end();

    const finished = encoderResult.value.finish();
    if (!finished.ok)
      return readbackFailure(`depth readback finish failed: ${finished.error.code}`);
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok)
      return readbackFailure(
        `depth readback submit failed: ${submitted.error.code}: ${submitted.error.hint}`,
      );
    const read = await readbackTexturePixelsBatch(
      device,
      [
        {
          handleId: 'depth-output',
          texture: output,
          bytesPerBlock: 16,
          blockWidth: 1,
          blockHeight: 1,
          totalBytes: width * height * 16,
          slices: [
            { layer: 0, mip: 0, width, height, byteOffset: 0, byteLength: width * height * 16 },
          ],
        },
      ],
      isCancelled === undefined ? {} : { isCancelled },
    );
    if (!read.ok) return read;
    const rgba = read.value.get('depth-output');
    if (rgba === undefined) return readbackFailure('depth readback returned no bytes');
    const pixels = new Uint8Array(rgba);
    const bytes = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      bytes.set(pixels.subarray(pixel * 16, pixel * 16 + 4), pixel * 4);
    }
    return ok(bytes);
  } catch (cause) {
    return readbackFailure(`depth readback failed: ${String(cause)}`);
  } finally {
    if (output !== undefined) device.destroyTexture(output);
  }
}
