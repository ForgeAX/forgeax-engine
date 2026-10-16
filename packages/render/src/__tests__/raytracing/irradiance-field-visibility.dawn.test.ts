import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildMeshDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import type { Buffer } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  createGlobalSdfComposition,
  type GlobalSdfCompositionInputs,
  packGlobalSdfComposition,
} from '../../raytracing/global-sdf';
import {
  createGlobalSdfTexture,
  GLOBAL_SDF_TEXTURE_WGSL,
} from '../../raytracing/global-sdf-texture';
import {
  createIrradianceFieldSampleLayout,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';

it('hard-rejects receiver-to-probe walls and retains incomplete transport through the live sampler', async () => {
  const source = `
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCacheAt}
@group(0) @binding(0) var<storage,read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn verifySegment() {
 let p=vec3f(0,0,-3.3);let n=vec3f(0,0,1);
 results[0]=sampleIrradianceField(p,n,vec3f(0));
 results[1]=sampleRadianceCacheAt(p,n,vec3f(0),n,0.25);
}`;
  const imports = {
    'forgeax_ray::irradiance_field_sample': readFileSync(
      new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
      'utf8',
    ),
  };
  const compiled = await Promise.all(
    [true, false].map(
      async (visibility) =>
        (
          await compileShader(source, {
            id: `field-segment-${visibility}`,
            imports,
            defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
          })
        ).unwrap().wgsl,
    ),
  );
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(device);
  if (raw === undefined) throw new Error('visibility regression requires real GPU validation');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: Buffer[] = [];
  const buffer = (data: Uint8Array, uniform = false) => {
    const value = device
      .createBuffer({ size: data.byteLength, usage: (uniform ? 64 : 128) | 12 })
      .unwrap();
    owned.push(value);
    device.queue.writeBuffer(value, 0, data).unwrap();
    return value;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  const result: {
    status: 'running' | 'pass' | 'fail';
    failure?: string;
    backend: string;
    adapter: { vendor: string; architecture: string; device: string; description: string } | null;
    controls: Record<string, { guarded: number[]; falsifier: number[] }>;
    errors: string[];
  } = {
    status: 'running',
    backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
    adapter:
      raw.adapterInfo === undefined
        ? null
        : {
            vendor: raw.adapterInfo.vendor,
            architecture: raw.adapterInfo.architecture,
            device: raw.adapterInfo.device,
            description: raw.adapterInfo.description,
          },
    controls: {},
    errors,
  };
  try {
    const field = buffer(
      packIrradianceFieldUniform(
        {
          origin: [-1.5, -1.5, -4.5],
          spacing: 1,
          dimensions: [4, 4, 4],
          probeCount: 64,
          levels: 1,
        },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] }],
      ),
      true,
    );
    const radiance = new Float32Array(64 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    for (let i = 0; i < radiance.length; i += 4) radiance.set([1, 1, 1, 1], i);
    const irradiance = buffer(bytes(radiance));
    const momentData = new Float32Array(64 * 64 * 2);
    for (let i = 0; i < momentData.length; i += 2) momentData.set([8, 64], i);
    const moments = buffer(bytes(momentData));
    const metaData = new Uint32Array(64 * 4);
    for (let i = 0; i < 64; i++) metaData.set([1, 1, 0, 0], i * 4);
    const meta = buffer(bytes(metaData));
    const output = buffer(new Uint8Array(32));
    const layout0 = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
      })
      .unwrap();
    const layout1 = createIrradianceFieldSampleLayout(device, 'live').unwrap();
    const pipelineLayout = device
      .createPipelineLayout({ bindGroupLayouts: [layout0, layout1] })
      .unwrap();
    const pipelines = await Promise.all(
      compiled.map(async (code) =>
        device
          .createComputePipeline({
            layout: pipelineLayout,
            compute: {
              module: (await webgpu.createShaderModule(device, { code })).unwrap(),
              entryPoint: 'verifySegment',
            },
          })
          .unwrap(),
      ),
    );
    const group0 = device
      .createBindGroup({
        layout: layout0,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const mesh = createBoxGeometry(3, 3, 0.25).unwrap();
    if (!(mesh.attributes.position instanceof Float32Array) || mesh.indices === undefined)
      throw new Error('the canonical wall requires indexed float32 positions');
    const distanceField = (
      await buildMeshDistanceField(mesh.attributes.position, mesh.indices, { resolution: 32 })
    ).unwrap();
    const grid = {
      origin: [-2, -2, -5] as const,
      dimensions: [17, 17, 17] as const,
      spacing: 0.25,
      maxDistance: 4,
      coverageDistance: 0.125,
    };
    const wall: SdfMeshInstance = {
      instanceId: 7,
      geometryId: 9,
      mask: 255,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1],
      field: distanceField,
    };
    const controls = [
      { name: 'mask-zero', source: [{ ...wall, mask: 0 }] },
      { name: 'wall', source: [wall] },
      {
        name: 'moved-wall',
        source: [{ ...wall, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 0, -3, 1] }],
      },
      { name: 'removed-wall', source: [] },
      { name: 'outside-region', source: [] },
      { name: 'proven-empty-exterior', source: [], exterior: true },
      { name: 'proven-exterior-wall', source: [wall], exterior: true },
      {
        name: 'missing-field',
        source: [{ ...wall, field: { missing: true as const, bounds: distanceField.bounds } }],
      },
      {
        name: 'partial-coverage',
        source: [
          {
            ...wall,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.5, -2.5, 1],
            field: {
              missing: true as const,
              bounds: { min: [-0.05, -0.05, -0.05] as const, max: [0.05, 0.05, 0.05] as const },
            },
          },
        ],
      },
    ];
    const projectionModule = (
      await webgpu.createShaderModule(device, { code: GLOBAL_SDF_TEXTURE_WGSL })
    ).unwrap();
    for (const control of controls) {
      const currentGrid = {
        ...grid,
        origin:
          control.name === 'outside-region' || control.name === 'proven-empty-exterior'
            ? ([-2, -2, -3] as const)
            : control.name === 'proven-exterior-wall'
              ? ([-2, -2, -3.25] as const)
              : grid.origin,
        maxDistance: control.name === 'partial-coverage' ? 0.5 : grid.maxDistance,
      };
      device.queue
        .writeBuffer(field, 60, new Uint32Array([Number(control.exterior === true)]))
        .unwrap();
      const packed = packGlobalSdfComposition(control.source, currentGrid).unwrap();
      const composition = (
        await createGlobalSdfComposition(
          device,
          webgpu.createShaderModule,
          control.source,
          currentGrid,
        )
      ).unwrap();
      const input = Object.fromEntries(
        Object.entries(composition.buffers).map(([name, buffer]) => [
          name,
          { buffer, size: packed.data[name as keyof typeof packed.data].byteLength },
        ]),
      ) as GlobalSdfCompositionInputs;
      const visibility = createGlobalSdfTexture(device, projectionModule, {
        grid: currentGrid,
        input,
      });
      try {
        const encoder = device.createCommandEncoder().unwrap();
        composition.record(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const projected = device.createCommandEncoder().unwrap();
        const pass = projected.beginComputePass();
        pass.setPipeline(visibility.pipeline);
        pass.setBindGroup(0, visibility.group);
        pass.dispatchWorkgroups(Math.ceil(composition.voxelCount / 64));
        pass.end();
        device.queue.submit([projected.finish().unwrap()]).unwrap();
        const group1 = device
          .createBindGroup({
            layout: layout1,
            entries: [
              ...[field, irradiance, moments, meta].map((buffer, binding) => ({
                binding,
                resource: { kind: 'buffer' as const, value: { buffer } },
              })),
              { binding: 4, resource: { kind: 'buffer', value: input.settings } },
              { binding: 5, resource: { kind: 'textureView', value: visibility.view } },
            ],
          })
          .unwrap();
        const values: number[][] = [];
        for (const pipeline of pipelines) {
          const e = device.createCommandEncoder().unwrap();
          const p = e.beginComputePass();
          p.setPipeline(pipeline);
          p.setBindGroup(0, group0);
          p.setBindGroup(1, group1);
          p.dispatchWorkgroups(1);
          p.end();
          device.queue.submit([e.finish().unwrap()]).unwrap();
          values.push(Array.from(new Float32Array((await readBuffer(device, output, 32)).buffer)));
        }
        const guarded = values[0],
          falsifier = values[1];
        if (guarded === undefined || falsifier === undefined)
          throw new Error('missing paired segment result');
        result.controls[control.name] = { guarded, falsifier };
        for (const offset of [0, 4]) {
          expect(
            falsifier.slice(offset, offset + 4),
            `${control.name}: disabled visibility`,
          ).toEqual([1, 1, 1, 1]);
          const expected =
            control.name === 'wall' || control.name === 'proven-exterior-wall'
              ? [0, 0, 0, 0]
              : control.name === 'missing-field' ||
                  control.name === 'partial-coverage' ||
                  control.name === 'outside-region'
                ? [0, 0, 0, -1]
                : [1, 1, 1, 1];
          expect(guarded.slice(offset, offset + 4), control.name).toEqual(expected);
        }
      } finally {
        device.destroyTexture(visibility.texture);
        composition.dispose();
      }
    }
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);
    result.status = 'pass';
  } catch (error) {
    result.status = 'fail';
    result.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    mkdirSync('artifacts/irradiance-field/visibility', { recursive: true });
    writeFileSync(
      `artifacts/irradiance-field/visibility/result-${result.backend}.json`,
      JSON.stringify(result, null, 2),
    );
    for (const value of owned) device.destroyBuffer(value);
  }
}, 60_000);
