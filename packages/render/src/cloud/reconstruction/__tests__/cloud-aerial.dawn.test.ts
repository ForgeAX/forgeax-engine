/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

it('evaluates independent near and far air/fog at their own distances without changing cloud T', async () => {
  const engine = await loadEngineShaderEntries();
  // An independent, deliberately high-contrast air field makes using the far
  // position for both lanes fail. The production atmosphere kernel has its
  // separate 512-step numerical oracle; this tests the shared cloud adapter.
  const fog = `#define_import_path forgeax_view::fog
#import forgeax_view::common::View
struct KnownFog { transmittance: vec3f, inscatter: vec3f }
struct KnownHeightFog { transmittance: f32, inscatter: vec3f }
fn view_fog(v:View,p:vec3f)->KnownFog {
  return KnownFog(vec3f(0.2,0.4,0.8),vec3f(1.0,2.0,3.0)*p.y*0.001);
}
fn height_fog_with_source(v:View,p:vec3f,source:vec3f)->KnownHeightFog {
  return KnownHeightFog(0.5,source*p.y*0.001);
}`;
  const compiled = await compileShader(
    `
#import forgeax_view::common::View
#import forgeax_cloud::aerial::{cloud_aerial_transport,cloud_height_transport}
@group(0) @binding(0) var<storage,read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  var v:View;
  v.fogColorDensity=vec4f(1.0,2.0,3.0,0.0);
  let nearPosition=vec3f(0.0,1000.0,0.0);
  let farPosition=vec3f(0.0,5000.0,0.0);
  let position=select(nearPosition,farPosition,id.x%2u==1u);
  let cloud=select(vec4f(10.0,20.0,30.0,0.25),vec4f(3.0,5.0,7.0,0.75),id.x%2u==0u);
  out[id.x]=cloud_aerial_transport(v,position,cloud);
  out[2u+id.x]=cloud_height_transport(v,position,cloud);
  out[4u+id.x]=cloud_aerial_transport(v,position,vec4f(0.0,0.0,0.0,1.0));
  out[6u+id.x]=cloud_aerial_transport(v,position,vec4f(1000000.0,2000000.0,3000000.0,1.0));
}`,
    { id: 'cloud-aerial-oracle.wgsl', imports: { ...engine.imports, 'forgeax_view::fog': fog } },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 128,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 128,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((entry) => entry.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    );
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const expected = [
      [0.85, 2.5, 6.35, 0.75],
      [5.75, 15.5, 35.25, 0.25],
      [1.75, 3, 4.25, 0.75],
      [8.75, 17.5, 26.25, 0.25],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [200000, 800000, 2400000, 1],
      [200000, 800000, 2400000, 1],
    ].flat();
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 4);
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
