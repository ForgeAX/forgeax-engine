/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import {
  type CloudDensityControls,
  type CloudDensityPoint,
  evaluateReferenceConservative,
  evaluateReferenceMedium,
} from '../density/reference-model';
import { cloudHenyeyGreenstein } from '../lighting/optics';
import { loadCloudKernel } from './cloud-mode0-kernels.fixture';

it('matches the production sampled density and normalized phase to independent CPU oracles', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const textures: GPUTexture[] = [];
  const values = [
    [128, 153, 179, 255],
    [32, 64, 96, 255],
    [204, 204, 204, 255],
    [204, 179, 153, 255],
  ];
  const sample = (i: number) =>
    (values[i] ?? []).map((v) => v / 255) as [number, number, number, number];
  const controls: CloudDensityControls = {
    layoutScaleMeters: 1000,
    coverageBias: 0,
    extinctionPerMeter: 0.001,
    albedo: [1, 0.8, 0.5, 1],
    layoutWeight: 1,
    maskWeight: 1,
    profileWeight: 1,
    bodyWeight: 1,
    erosionWeight: 1,
  };
  const cpuTextures = {
    pattern: () => sample(0),
    mask: () => sample(1),
    profile: () => sample(2),
    body: () => sample(3),
  };
  const output = device.createBuffer({
    size: 128 * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 128 * 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const lighting = await loadCloudKernel('lighting');
    const module = device.createShaderModule({
      code: `${await loadCloudKernel('coordinates')}\n${await loadCloudKernel('medium')}\n${lighting.slice(lighting.indexOf('const CLOUD_ISOTROPIC_PHASE'))}
@group(0) @binding(0) var<storage,read_write> out:array<vec4f>;
@group(0) @binding(1) var pattern:texture_2d<f32>;
@group(0) @binding(2) var mask:texture_2d<f32>;
@group(0) @binding(3) var profile:texture_2d<f32>;
@group(0) @binding(4) var body:texture_3d<f32>;
@group(0) @binding(5) var filtering:sampler;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  let h=f32(id.x%17u)/16.0;
  let bias=f32(id.x%5u)*0.1-0.2;
  let point=CloudDensityPoint(vec3f(5000.0,6000.0,7000.0),vec3f(0.0,6000.0,0.0),h,vec3f(100.0,200.0,300.0));
  let controls=CloudDensityControls(1000.0,bias,0.001,vec4f(1.0,0.8,0.5,1.0),1.0,1.0,1.0,1.0,1.0);
  let c=evaluate_reference_conservative(point,controls,pattern,mask,profile,body,filtering,id.x%2u==1u);
  let medium=evaluate_reference_medium(point,controls,c);
  out[id.x*2u]=c;
  out[id.x*2u+1u]=vec4f(medium.extinctionPerMeter,medium.albedo.r,medium.materialAO,cloud_henyey_greenstein(0.5,f32(id.x%9u)/4.0-1.0));
}`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    for (let i = 0; i < 4; i++) {
      const texture = device.createTexture({
        size: [1, 1, 1],
        dimension: i === 3 ? '3d' : '2d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(texture);
      device.queue.writeTexture(
        { texture },
        new Uint8Array(values[i] ?? []),
        { bytesPerRow: 4 },
        [1, 1, 1],
      );
    }
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: output } },
        ...textures.map((t, i) => ({ binding: i + 1, resource: t.createView() })),
        {
          binding: 5,
          resource: device.createSampler({
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            addressModeW: 'repeat',
            minFilter: 'linear',
            magFilter: 'linear',
          }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128 * 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    for (let i = 0; i < 128; i++) {
      const point: CloudDensityPoint = {
        positionMeters: [5000, 6000, 7000],
        cameraRelativeMeters: [0, 6000, 0],
        heightFraction: (i % 17) / 16,
        windOffsetMeters: [100, 200, 300],
      };
      const c = { ...controls, coverageBias: (i % 5) * 0.1 - 0.2 };
      const conservative = evaluateReferenceConservative(point, c, cpuTextures, i % 2 === 1);
      const medium = evaluateReferenceMedium(point, c, conservative);
      for (let j = 0; j < 4; j++) expect(actual[i * 8 + j]).toBeCloseTo(conservative[j] ?? NaN, 5);
      expect(actual[i * 8 + 4]).toBeCloseTo(medium.extinctionPerMeter, 7);
      expect(actual[i * 8 + 5]).toBe(1);
      expect(actual[i * 8 + 6]).toBe(1);
      expect(actual[i * 8 + 7]).toBeCloseTo(cloudHenyeyGreenstein(0.5, (i % 9) / 4 - 1), 5);
    }
    readback.unmap();
  } finally {
    for (const t of textures) t.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
