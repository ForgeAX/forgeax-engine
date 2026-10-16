/// <reference types="@webgpu/types" />
import { readFileSync, writeFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';

const source = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8').replace(
    /^#.*$/gm,
    '',
  );

it('bounds production sky and RGB AP against 512-step transport across altitude, sun and the AP boundary', async () => {
  const common = source('common');
  const structs = ['AtmosphereMedium', 'View']
    .map((name) => new RegExp(`struct ${name} \\{[\\s\\S]*?\\};`).exec(common)?.[0])
    .join('\n');
  const outputTransform = ['acesInput', 'acesOutput', 'tonemapAcesFilmic']
    .map((name) => {
      const body = new RegExp(`fn ${name}\\([\\s\\S]*?\n}`).exec(source('tonemap'))?.[0];
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
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const texture = (size: number[], dimension: GPUTextureDimension = '2d') => {
    const t = device.createTexture({
      size,
      dimension,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    owned.push(t);
    return t.createView();
  };
  const trans = texture([256, 64]),
    multi = texture([32, 32]),
    sky = texture([192, 208]);
  const aerial = texture([32, 32, 32], '3d'),
    extinction = texture([32, 32, 32], '3d');
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const cases = [1, 1000, 65000].flatMap((height) =>
    [60, 10, 1, -4].map((elevation) => ({ height, elevation })),
  );
  const samples = 1024;
  const uniform = device.createBuffer({
    size: VIEW_UNIFORM_BYTES * cases.length,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  owned.push(uniform);
  const output = device.createBuffer({
    size: cases.length * samples * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  owned.push(output);
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  owned.push(readback);
  const data = new Float32Array((VIEW_UNIFORM_BYTES / 4) * cases.length);
  cases.forEach(({ height, elevation }, index) => {
    const v = data.subarray(
      index * (VIEW_UNIFORM_BYTES / 4),
      (index + 1) * (VIEW_UNIFORM_BYTES / 4),
    );
    const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 1, 120000);
    const view = mat4.lookAt(
      mat4.create(),
      [0, height, 0],
      [0, height - (height > 60000 ? 1 : 0), height > 60000 ? -2 : -1],
      [0, 1, 0],
    );
    const pv = mat4.multiply(mat4.create(), projection, view);
    v.set(pv, 0);
    v.set(mat4.invert(mat4.create(), pv), 44);
    v.set([0, -Math.sin((elevation * Math.PI) / 180), Math.cos((elevation * Math.PI) / 180)], 16);
    v.set([100000, 100000, 100000], 20);
    v.set([0, height, 0], 24);
    v.set([1, 120000, 0, 0], 228);
    v.set(
      [
        0, 0, 0, 6360, 0.005802, 0.013558, 0.0331, 8, 0.003996, 0.000444, 1.2, 0.8, 0.00065,
        0.001881, 0.000085, 25, 0.4, 0.4, 0.4, 15, 60, 1, 0, 1, 0, 0.004675, 96, 1,
      ],
      292,
    );
  });
  device.queue.writeBuffer(uniform, 0, data);
  try {
    const module = device.createShaderModule({ code: `${kernel}\n${source('atmosphere-luts')}` });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const evaluation = device.createShaderModule({
      code:
        kernel +
        `
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var trans:texture_2d<f32>;
@group(0) @binding(2) var multi:texture_2d<f32>;
@group(0) @binding(3) var sky:texture_2d<f32>;
@group(0) @binding(4) var aerial:texture_3d<f32>;
@group(0) @binding(5) var extinction:texture_3d<f32>;
@group(0) @binding(6) var filtering:sampler;
@group(0) @binding(7) var<storage,read_write> output:array<vec4<f32>>;
fn display(c:vec3<f32>)->vec3<f32>{let linear=tonemapAcesFilmic(c/5000.0);return select(1.055*pow(linear,vec3<f32>(1.0/2.4))-0.055,linear*12.92,linear<=vec3<f32>(0.0031308));}
@compute @workgroup_size(64) fn evaluate(@builtin(global_invocation_id) id:vec3<u32>){
 let i=id.x;if i>=1024u{return;}
 let uv=vec2<f32>((f32(i%32u)+0.37)/32.0,(f32((i/32u)%8u)+0.41)/16.0);
 let distance=array<f32,4>(3.0,48.0,94.5,120.0)[i/256u];
 let ray=atmosphere_view_ray(v,uv);let origin=atmosphere_observer(v.atmosphere,ray.origin);
 let sun=normalize(-v.lightDir);let point=ray.origin+ray.direction*distance*1000.0;
 let reference=atmosphere_aerial_integrate(v,origin,ray.direction,distance,trans,multi,filtering,512u);
 let production=atmosphere_aerial_sample(v,point,trans,multi,aerial,extinction,filtering);
 let local=vec3<f32>(200.0)+0.5*v.lightColor*atmosphere_solar_transmittance(v.atmosphere,origin+ray.direction*distance,sun,trans,filtering)/ATMOSPHERE_PI;
 let error=abs(display(reference.luminance+reference.transmittance*local)-display(production.luminance+production.transmittance*local));
 let skyRef=atmosphere_integrate(v.atmosphere,origin,ray.direction,1e7,sun,v.lightColor,trans,multi,filtering,512u,1.0).luminance;
 var skyLut=textureSampleLevel(sky,filtering,atmosphere_sky_uv(v.atmosphere,origin,sun,ray.direction),0.0).rgb*v.lightColor;
 if length(origin)>=v.atmosphere.originRadius.w+v.atmosphere.geometry.x { skyLut=atmosphere_integrate(v.atmosphere,origin,ray.direction,1e7,sun,v.lightColor,trans,multi,filtering,64u,1.0).luminance; }
 let skyError=abs(display(skyRef)-display(skyLut));
 output[i]=vec4<f32>(error,max(skyError.x,max(skyError.y,skyError.z)));
}`,
    });
    expect(
      (await evaluation.getCompilationInfo()).messages.filter((m) => m.type === 'error'),
    ).toEqual([]);
    const evaluate = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: evaluation, entryPoint: 'evaluate' },
    });
    const stages = await Promise.all(
      ['transmittance', 'multiple_scattering', 'sky_view', 'aerial_perspective'].map(
        async (name) => ({
          name,
          pipeline: await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module, entryPoint: `atmosphere_${name}` },
          }),
        }),
      ),
    );
    const encoder = device.createCommandEncoder();
    for (let c = 0; c < cases.length; c++) {
      for (const { name, pipeline } of stages) {
        if (c > 0 && (name === 'transmittance' || name === 'multiple_scattering')) continue;
        const entries: GPUBindGroupEntry[] = [
          {
            binding: 0,
            resource: { buffer: uniform, offset: c * VIEW_UNIFORM_BYTES, size: VIEW_UNIFORM_BYTES },
          },
        ];
        if (name !== 'transmittance')
          entries.push({ binding: 1, resource: trans }, { binding: 3, resource: sampler });
        if (name === 'sky_view' || name === 'aerial_perspective')
          entries.push({ binding: 2, resource: multi });
        entries.push({
          binding: name === 'aerial_perspective' ? 5 : 4,
          resource:
            name === 'transmittance'
              ? trans
              : name === 'multiple_scattering'
                ? multi
                : name === 'sky_view'
                  ? sky
                  : aerial,
        });
        if (name === 'aerial_perspective') entries.push({ binding: 6, resource: extinction });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
        );
        if (name === 'transmittance') pass.dispatchWorkgroups(32, 8);
        else if (name === 'multiple_scattering') pass.dispatchWorkgroups(4, 4);
        else if (name === 'sky_view') pass.dispatchWorkgroups(24, 26);
        else pass.dispatchWorkgroups(8, 8, 8);
        pass.end();
      }
      const pass = encoder.beginComputePass();
      pass.setPipeline(evaluate);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: evaluate.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: uniform,
                offset: c * VIEW_UNIFORM_BYTES,
                size: VIEW_UNIFORM_BYTES,
              },
            },
            { binding: 1, resource: trans },
            { binding: 2, resource: multi },
            { binding: 3, resource: sky },
            { binding: 4, resource: aerial },
            { binding: 5, resource: extinction },
            { binding: 6, resource: sampler },
            {
              binding: 7,
              resource: { buffer: output, offset: c * samples * 16, size: samples * 16 },
            },
          ],
        }),
      );
      pass.dispatchWorkgroups(16);
      pass.end();
    }
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(readback.getMappedRange()));
    expect(values.every(Number.isFinite)).toBe(true);
    const summary = (values: number[]) => {
      values.sort((a, b) => a - b);
      return {
        p95: values[Math.floor(values.length * 0.95)] ?? Number.NaN,
        p99: values[Math.floor(values.length * 0.99)] ?? Number.NaN,
        max: values.at(-1) ?? Number.NaN,
      };
    };
    const report = cases.map((c, index) => {
      const valuesForCase = values.slice(index * samples * 4, (index + 1) * samples * 4);
      return {
        ...c,
        ap: summary(valuesForCase.filter((_, i) => i % 4 !== 3)),
        sky: summary(valuesForCase.filter((_, i) => i % 4 === 3)),
      };
    });
    if (process.env.FORGEAX_ATMOSPHERE_QUALITY_REPORT)
      writeFileSync(
        process.env.FORGEAX_ATMOSPHERE_QUALITY_REPORT,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    readback.unmap();
    for (const c of report)
      for (const roi of ['ap', 'sky'] as const) {
        expect(c[roi].p95, JSON.stringify(c)).toBeLessThanOrEqual(0.02);
        expect(c[roi].p99, JSON.stringify(c)).toBeLessThanOrEqual(0.05);
      }
  } finally {
    for (const resource of owned) resource.destroy();
    device.destroy();
  }
}, 60000);
