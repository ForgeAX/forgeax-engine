/// <reference types="@webgpu/types" />
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('evaluates phase normalization, Beer extinction, zero-density limit and spherical endpoints on GPU', async () => {
  const common = readFileSync(new URL('../../../shader/src/common.wgsl', import.meta.url), 'utf8');
  const medium = /struct AtmosphereMedium \{[\s\S]*?\};/.exec(common)?.[0];
  expect(medium).toBeDefined();
  const optics = readFileSync(
    new URL('../../../shader/src/atmosphere-optics.wgsl', import.meta.url),
    'utf8',
  ).replace(/^#.*$/gm, '');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `${medium}\nfn atmosphere_scene_visibility(m:AtmosphereMedium,p:vec3<f32>)->f32{return 1.0;}\n${optics}
      @group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
      @compute @workgroup_size(1) fn main() {
        var m: AtmosphereMedium;
        m.originRadius=vec4<f32>(0.0,0.0,0.0,6360.0);
        m.rayleigh=vec4<f32>(0.005802,0.013558,0.0331,8.0);
        m.mie=vec4<f32>(0.003996,0.000444,1.2,0.8);
        m.absorption=vec4<f32>(0.000650,0.001881,0.000085,25.0);
        m.ground=vec4<f32>(0.4,0.4,0.4,15.0);
        m.geometry=vec4<f32>(60.0,1.0,0.0,1.0);
        let sigma=atmosphere_medium(m,vec3<f32>(0.0,6360.0,0.0)).extinction;
        result[0]=vec4<f32>(exp(-sigma*10.0),1.0);
        result[1]=vec4<f32>(atmosphere_segment(vec3<f32>(0.0,0.0000001,0.1),3.0),1.0);
        let interval=atmosphere_interval(m,vec3<f32>(0.0,6361.0,0.0),vec3<f32>(0.0,1.0,0.0),1e6);
        result[2]=vec4<f32>(interval,atmosphere_planet_visibility(m,vec3<f32>(0.0,6361.0,0.0),vec3<f32>(0.0,-1.0,0.0)),1.0);
        var phaseR=0.0; var phaseM=0.0;
        for(var i=0u;i<4096u;i+=1u) {
          let mu=-1.0+(f32(i)+0.5)*2.0/4096.0;
          phaseR+=atmosphere_rayleigh_phase(mu)*4.0*ATMOSPHERE_PI/4096.0;
          phaseM+=atmosphere_mie_phase(mu,0.8)*4.0*ATMOSPHERE_PI/4096.0;
        }
        result[3]=vec4<f32>(phaseR,phaseM,0.0,1.0);
        let opticalA=vec3<f32>(0.1,0.2,0.3);
        result[4]=vec4<f32>(atmosphere_segment(opticalA,2.0)+exp(-opticalA*2.0)*atmosphere_segment(opticalA,3.0),1.0);
        result[5]=vec4<f32>(atmosphere_segment(opticalA,5.0),1.0);
      }`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
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
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 96);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (const [i, beta] of [0.005802, 0.013558, 0.0331].entries())
      expect(values[i]).toBeCloseTo(Math.exp(-(beta + 0.003996 + 0.000444) * 10), 6);
    expect(values[4]).toBe(3);
    expect(values[5]).toBeCloseTo(3, 5);
    expect(values[6]).toBeCloseTo(-Math.expm1(-0.3) / 0.1, 6);
    expect(values[8]).toBe(0);
    expect(values[9]).toBeCloseTo(59, 3);
    expect(values[10]).toBe(0);
    expect(values[12]).toBeCloseTo(1, 4);
    expect(values[13]).toBeCloseTo(1, 3);
    for (let i = 0; i < 3; i++) expect(values[16 + i]).toBeCloseTo(values[20 + i] ?? 0, 5);
    readback.unmap();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
