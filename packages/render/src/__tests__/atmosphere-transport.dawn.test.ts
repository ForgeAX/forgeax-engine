/// <reference types="@webgpu/types" />
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';

const source = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8').replace(
    /^#.*$/gm,
    '',
  );

it('measures RGB versus scalar extinction using the physical GPU transport and fixed output transform', async () => {
  const common = source('common');
  const structs = ['AtmosphereMedium', 'View']
    .map((name) => new RegExp(`struct ${name} \\{[\\s\\S]*?\\};`).exec(common)?.[0])
    .join('\n');
  const outputTransform = ['acesInput', 'acesOutput', 'tonemapAcesFilmic']
    .map((name) => {
      const body = new RegExp(`fn ${name}\\([\\s\\S]*?\n}`).exec(source('tone-mapping'))?.[0];
      if (body === undefined) throw new Error(`Missing production output function ${name}`);
      return body;
    })
    .join('\n');
  const kernel =
    outputTransform +
    '\n' +
    structs +
    '\n' +
    'fn atmosphere_scene_visibility(m:AtmosphereMedium,p:vec3<f32>)->f32{return 1.0;}' +
    source('atmosphere-optics') +
    '\n' +
    source('atmosphere-coordinates') +
    '\n' +
    source('atmosphere-sampling');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('GPU unavailable');
  const device = await adapter.requestDevice();
  const uniform = device.createBuffer({
    size: VIEW_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const values = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  values.set(
    [
      0, 0, 0, 6360, 0.005802, 0.013558, 0.0331, 8, 0.003996, 0.000444, 1.2, 0.8, 0.00065, 0.001881,
      0.000085, 25, 0.4, 0.4, 0.4, 15, 60, 1, 0, 1, 0, 0.004675, 96, 1,
    ],
    292,
  );
  device.queue.writeBuffer(uniform, 0, values);
  const trans = device.createTexture({
    size: [256, 64],
    format: 'rgba16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  const multi = device.createTexture({
    size: [32, 32],
    format: 'rgba16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const count = 1024;
  const output = device.createBuffer({
    size: count * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({ code: `${kernel}\n${source('atmosphere-luts')}` });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const encoder = device.createCommandEncoder();
    for (const [entry, target, width, height] of [
      ['atmosphere_transmittance', trans, 256, 64],
      ['atmosphere_multiple_scattering', multi, 32, 32],
    ] as const) {
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      });
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 4, resource: target.createView() },
      ];
      if (entry === 'atmosphere_multiple_scattering')
        entries.push(
          { binding: 1, resource: trans.createView() },
          { binding: 3, resource: sampler },
        );
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      );
      pass.dispatchWorkgroups(width / 8, height / 8);
      pass.end();
    }
    const evaluation = device.createShaderModule({
      code:
        kernel +
        `
      @group(0) @binding(0) var<uniform> v: View;
      @group(0) @binding(1) var trans: texture_2d<f32>;
      @group(0) @binding(2) var multi: texture_2d<f32>;
      @group(0) @binding(3) var filtering: sampler;
      @group(0) @binding(4) var<storage,read_write> output: array<vec4<f32>>;
      fn display(c:vec3<f32>)->vec3<f32>{let linear=tonemapAcesFilmic(c/5000.0);return select(1.055*pow(linear,vec3<f32>(1.0/2.4))-0.055,linear*12.92,linear<=vec3<f32>(0.0031308));}
      @compute @workgroup_size(64) fn evaluate(@builtin(global_invocation_id) id:vec3<u32>){
        let i=id.x;if i>=1024u{return;}
        let elevation=array<f32,4>(1.3962634,0.2617994,0.0349066,-0.0698132)[i/256u];
        let sun=vec3<f32>(cos(elevation),sin(elevation),0.0);
        let distance=96.0*f32(i%32u+1u)/32.0;
        let azimuth=6.2831853*f32((i/32u)%8u)/8.0;
        let dir=normalize(vec3<f32>(cos(azimuth),0.03,sin(azimuth)));
        let origin=vec3<f32>(0.0,6360.01,0.0);
        let ray=atmosphere_integrate(v.atmosphere,origin,dir,distance,sun,vec3<f32>(100000.0),trans,multi,filtering,512u,1.0);
        // A neutral sun-facing Lambertian building, with a small ambient term.
        let local=vec3<f32>(200.0)+0.5*100000.0*atmosphere_solar_transmittance(v.atmosphere,origin+dir*distance,sun,trans,filtering)/ATMOSPHERE_PI;
        let rgb=display(ray.luminance+ray.transmittance*local);
        let scalar=display(ray.luminance+dot(ray.transmittance,vec3<f32>(1.0/3.0))*local);
        let error=abs(rgb-scalar);
        output[i*2u]=vec4<f32>(rgb,max(error.x,max(error.y,error.z)));
        output[i*2u+1u]=vec4<f32>(ray.transmittance,1.0);
      }`,
    });
    expect(
      (await evaluation.getCompilationInfo()).messages.filter((m) => m.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: evaluation, entryPoint: 'evaluate' },
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: trans.createView() },
          { binding: 2, resource: multi.createView() },
          { binding: 3, resource: sampler },
          { binding: 4, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(count / 64);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = Array.from(new Float32Array(readback.getMappedRange()));
    expect(data.every(Number.isFinite)).toBe(true);
    const errors = Array.from({ length: count }, (_, i) => data[i * 8 + 3] ?? Number.NaN).sort(
      (a, b) => a - b,
    );
    const report = {
      samples: count,
      exposure: 1 / 5000,
      p95: errors[Math.floor(count * 0.95)],
      p99: errors[Math.floor(count * 0.99)],
      max: errors.at(-1),
    };
    if (process.env.FORGEAX_ATMOSPHERE_REPORT)
      writeFileSync(process.env.FORGEAX_ATMOSPHERE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    // Colored extinction is measurable on neutral distant geometry: production
    // must retain RGB whenever the scalar representation exceeds this budget.
    expect(errors.at(-1)).toBeGreaterThan(0.05);
    readback.unmap();
  } finally {
    uniform.destroy();
    trans.destroy();
    multi.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
}, 30000);
