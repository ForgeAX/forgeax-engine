import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { projectShaderConditionals } from '../../../shader-compiler/src/conditionals.js';

it('validates full Standard and Water vertex-color interfaces at default device limits', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Standard varying validation requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    expect(device.limits.maxInterStageShaderVariables).toBe(16);
    for (const file of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const output = /struct VsOut \{[\s\S]*?\n\};/u.exec(source)?.[0];
      if (output === undefined) throw new Error(`Missing Standard vertex interface: ${file}`);
      for (const water of [false, true]) {
        for (const sceneIndex of [false, true]) {
          const label = `${file}:water=${water}:scene-index=${sceneIndex}`;
          const projected = projectShaderConditionals(
            output,
            {
              WATER_WAVES_AVAILABLE: water,
              GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
              VERTEX_COLOR_AVAILABLE: true,
            },
            'all',
          );
          const module = device.createShaderModule({
            label,
            code: `${projected}
@vertex fn vertex() -> VsOut {
  var output: VsOut;
  output.clip = vec4<f32>(0.0, 0.0, 0.5, 1.0);
  return output;
}
@fragment fn fragment(input: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  return input.color + vec4<f32>(select(0.0, 1.0, front));
}`,
          });
          expect(
            (await module.getCompilationInfo()).messages.filter(
              (message) => message.type === 'error',
            ),
            label,
          ).toEqual([]);
          await device.createRenderPipelineAsync({
            label,
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
          });
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
  }
});

it.each([
  {
    name: 'perspective',
    columns:
      'vec4(1.2,0.0,0.0,0.0), vec4(0.0,1.2,0.0,0.0), vec4(0.0,0.0,1.01,1.0), vec4(0.0,0.0,-0.101,0.0)',
  },
  {
    name: 'orthographic',
    columns:
      'vec4(0.5,0.0,0.0,0.0), vec4(0.0,0.5,0.0,0.0), vec4(0.0,0.0,0.1,0.0), vec4(0.0,0.0,0.0,1.0)',
  },
])('reconstructs Water NDC at rasterized deformed positions with $name projection', async ({
  name,
  columns,
}) => {
  const source = projectShaderConditionals(
    readFileSync(new URL('../default-standard-pbr.wgsl', import.meta.url), 'utf8'),
    {
      WATER_WAVES_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
    },
    'all',
  );
  const output = /struct VsOut \{[\s\S]*?\n\};/u.exec(source)?.[0];
  const ndc = /^fn standardFragmentNdc\([\s\S]*?^\}/mu.exec(source)?.[0];
  if (output === undefined || ndc === undefined)
    throw new Error('Missing Water projection interface');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Water NDC validation requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const size = 32;
  const texture = device.createTexture({
    size: [size, size],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: size * size * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({
      code: `
${output.replace('\n};', '\n  @location(14) referenceNdc: vec3<f32>,\n};')}
struct TestView { worldViewProj: mat4x4<f32>, viewportWidth: f32, viewportHeight: f32 }
const view = TestView(mat4x4<f32>(${columns}), ${size}.0, ${size}.0);
${ndc}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> VsOut {
  let positions = array<vec3<f32>, 3>(vec3(-0.8,-0.8,2.0), vec3(1.2,-0.6,4.0), vec3(-0.2,1.1,3.0));
  var position = positions[index];
  position.y += sin(position.x * 2.0 + position.z) * 0.2;
  position.x += cos(position.z) * 0.08;
  var output: VsOut;
  output.clip = view.worldViewProj * vec4<f32>(position, 1.0);
  output.referenceNdc = output.clip.xyz / output.clip.w;
  return output;
}
@fragment fn fragment(input: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let expected = vec3<f32>(input.clip.xy / ${size}.0 * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), input.clip.z);
  let legacyError = abs(input.referenceNdc - expected);
  return vec4<f32>(abs(standardFragmentNdc(input) - expected), 1.0 + max(max(legacyError.x, legacyError.y), legacyError.z));
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: size * 16 }, [
      size,
      size,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange());
    let covered = 0;
    let maximumError = 0;
    let maximumLegacyError = 0;
    for (let pixel = 0; pixel < size * size; pixel++) {
      if ((pixels[pixel * 4 + 3] ?? 0) < 0.5) continue;
      covered++;
      maximumLegacyError = Math.max(maximumLegacyError, (pixels[pixel * 4 + 3] ?? 1) - 1);
      for (let channel = 0; channel < 3; channel++)
        maximumError = Math.max(maximumError, pixels[pixel * 4 + channel] ?? 0);
    }
    expect(covered).toBeGreaterThan(10);
    // Raster vertices use subpixel fixed-point coordinates (at least four
    // fractional bits); world varyings retain their floating-point positions.
    const tolerance = 2 / (size * 16) + 0.000002;
    expect(maximumError).toBeLessThan(tolerance);
    if (name === 'perspective') expect(maximumLegacyError).toBeGreaterThan(tolerance * 2);
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    texture.destroy();
    readback.destroy();
    device.destroy();
  }
});
