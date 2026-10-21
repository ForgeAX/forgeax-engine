import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { RhiDevice, RhiRenderPassEncoder, ShaderModule } from '@forgeax/engine-rhi';
import { transmissionBackdropAvailable } from '../../assembly/device-feature-admission';
import type { MeshGpuHandles } from '../../device/gpu-residency';
import { GpuBuffer } from '../../gpu-resource';
import {
  assembleMaterialWithSkylightEntries,
  createSkylightFallback,
  skylightBindGroupResources,
} from '../../ibl/skylight-bind-group';
import { buildBindGroupLayoutDescriptor } from '../../pbr-pipeline';
import { worldRenderResources } from '../../publication/resource-scope';
import { MaterialFrame } from '../../scene/material-dispatch';
import { selectCpuLodRows } from '../cpu-lod';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import { getOrCreateFromChain } from '../mesh-ssbo';
import { recordShadowCasterDraws } from '../shadow-pass';
import { cpuSetupFixture } from './main-pass-cpu-setup-fixture';

export type PhysicalRangePass = 'forward' | 'deferred' | 'temporal' | 'shadow';

/** Two source meshes and one lower LOD share actual buffers, with independent index/base offsets. */
export function cpuPhysicalRangesFixture(device: RhiDevice, shader: ShaderModule) {
  const f = cpuSetupFixture(device, shader);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const skylightFallback = createSkylightFallback(device, device.queue);
  Object.assign(f.c, { world: worldRenderResources(world), skylightCount: 0 });
  Object.assign(f.c.frameState, { materialBgShared: new Map() });
  const first = f.add({ entity: 1, submeshes: 1 });
  const second = f.add({ entity: 2, submeshes: 1, claimed: [0] });
  for (const entry of [first, second])
    entry.source.material.adopt({
      ...entry.source.material.snapshot,
      materialHandle: undefined,
      materialParamSchema: [],
      passes: [
        {
          name: 'shadow',
          program: { module: 'fixture::shadow' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
    });
  Object.assign(f.c, {
    materialFrame: new MaterialFrame(undefined)
      .with(first.source.material)
      .with(second.source.material),
  });
  const secondClaim = [...f.selectedDraws];
  f.selectedDraws.clear();
  const positions = Float32Array.of(
    -0.9,
    -0.7,
    0,
    -0.2,
    -0.7,
    0,
    -0.55,
    0.1,
    0,
    0.15,
    -0.35,
    0,
    0.9,
    -0.35,
    0,
    0.7,
    0.6,
    0,
    -0.1,
    0.3,
    0,
    0.35,
    0.3,
    0,
    0.1,
    0.85,
    0,
  );
  // First + base must both be honored: the second range uses [1,2,3] + 2;
  // using first=0 or base=0 produces a different triangle, not equivalent bytes.
  const indices = Uint32Array.of(0, 1, 2, 1, 2, 3, 1, 2, 3);
  const vertex = device.createBuffer({ size: positions.byteLength, usage: 32 | 8 }).unwrap();
  const index = device.createBuffer({ size: indices.byteLength, usage: 16 | 8 }).unwrap();
  device.queue.writeBuffer(vertex, 0, positions).unwrap();
  device.queue.writeBuffer(index, 0, indices).unwrap();
  const shared = {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    vboBytes: positions.byteLength,
    iboBytes: indices.byteLength,
    indexCount: 3,
    vertexCount: 3,
    contentEpoch: 1,
    topology: 'triangle-list' as const,
  };
  const firstMesh: MeshGpuHandles = {
    ...first.mesh,
    ...shared,
    lodRanges: [[{ first: 0, count: 3, baseVertex: 0 }]],
  };
  const secondMesh: MeshGpuHandles = {
    ...second.mesh,
    ...shared,
    lodRanges: [[{ first: 3, count: 3, baseVertex: 2 }], [{ first: 6, count: 3, baseVertex: 5 }]],
  };
  Object.assign(first, { mesh: firstMesh });
  Object.assign(second, { mesh: secondMesh });
  for (const entry of f.entries)
    Object.assign(entry.source, {
      transform: { world: mat4.identity(mat4.create()) },
      localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
    });
  Object.assign(second.source, {
    lods: [{ mesh: '00000000-0000-7000-8000-000000000001', screenCoverage: 0.5 }],
    lodHysteresis: 0,
  });
  const sourceSubmeshes = secondMesh.submeshes;
  const sourceDraws = structuredClone(second.source.gpuDrivenDraws);
  const transmissionBackdrop = transmissionBackdropAvailable(
    device.limits.maxSampledTexturesPerShaderStage,
  );
  const shadowMaterialLayout = device
    .createBindGroupLayout(
      buildBindGroupLayoutDescriptor(
        {
          shader: { id: 'fixture::shadow', passKind: 'forward', variantSet: undefined },
          attachments: { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
          geometry: { topology: 'triangle-list', vertexLayout: {} },
          renderState: undefined,
        },
        {
          kind: 'pbr-material-merged',
          materialParamSchema: [],
          caps: { ...device.caps, transmissionBackdrop },
        },
      ),
    )
    .unwrap();
  const shadowPipeline = f.createPipeline(shader, undefined, true, shadowMaterialLayout);
  const oracleMaterialEntries = assembleMaterialWithSkylightEntries(
    [
      {
        binding: 0,
        resource: {
          kind: 'buffer',
          value: {
            buffer: f.c.pipelineState.materialUniformBuffer
              .buffer as import('@forgeax/engine-rhi').Buffer,
            size: 16,
          },
        },
      },
    ],
    skylightBindGroupResources(skylightFallback),
    transmissionBackdrop ? undefined : null,
  );
  oracleMaterialEntries.push({
    binding: 46,
    resource: { kind: 'buffer', value: { buffer: f.meshUniformBuffer } },
  });
  const oracleMaterialGroup = device
    .createBindGroup({ layout: shadowMaterialLayout, entries: oracleMaterialEntries })
    .unwrap();
  Object.assign(f.c.runtime, {
    getMaterialShaderPipeline: () => shadowPipeline,
    getMaterialBindGroupLayout: () => shadowMaterialLayout,
    getParamSchema: () => [],
  });
  const materialLayout = {};
  const sampler = {};
  const normal = {};
  const color = {};
  const shadowGroups = new WeakMap<object, unknown>();
  const materialBuffer = f.c.pipelineState.materialUniformBuffer.buffer;
  if (materialBuffer === null) throw new Error('Expected fixture material buffer');
  Object.assign(f.c.pipelineState, {
    skylightFallback,
    materialBindGroupLayout: materialLayout,
    defaultSampler: sampler,
    defaultNormalTextureView: normal,
    fallbackTextureView: color,
  });
  Object.assign(f.c.frameState, { shadowMaterialBindGroups: shadowGroups });
  getOrCreateFromChain(
    shadowGroups,
    [materialLayout, materialBuffer, sampler, normal, color, f.meshUniformBuffer],
    'shadow-material-singleton',
    () => f.materialGroup,
    f.c.bindGroupCounts,
  );
  const identityGroup = device
    .createBindGroup({
      layout: f.instancesLayout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: f.identity } } }],
    })
    .unwrap();
  return {
    ...f,
    first,
    second,
    firstMesh,
    secondMesh,
    sourceSubmeshes,
    sourceDraws,
    rows(level: 0 | 1) {
      return selectCpuLodRows(f.entries, {
        ...makeZeroCameraFallbackSnapshot(),
        position: vec3.create(0, 0, level ? 40 : 5),
      });
    },
    claimSecond(claimed: boolean) {
      f.selectedDraws.clear();
      if (claimed) for (const claim of secondClaim) f.selectedDraws.add(claim);
    },
    recordRange(
      pass: RhiRenderPassEncoder,
      kind: PhysicalRangePass,
      level: 0 | 1,
      profiled = false,
    ) {
      const rows = this.rows(level);
      Object.assign(f.c, {
        validatedOrdered: rows,
        shadowValidatedOrdered: rows,
        profilePhase: profiled ? (_phase: unknown, run: () => unknown) => run() : undefined,
      });
      if (kind === 'shadow') {
        pass.setPipeline(shadowPipeline);
        recordShadowCasterDraws(f.c, pass, shadowPipeline, f.meshGroup, undefined);
      } else f.record(pass, kind);
    },
    oracle(
      pass: RhiRenderPassEncoder,
      kind: PhysicalRangePass,
      level: 0 | 1,
      fault?: 'first' | 'base' | 'omit',
    ) {
      pass.setPipeline(kind === 'shadow' ? shadowPipeline : f.pipeline);
      pass.setBindGroup(1, kind === 'shadow' ? oracleMaterialGroup : f.materialGroup, [0]);
      pass.setBindGroup(2, f.meshGroup, [0]);
      pass.setBindGroup(3, identityGroup);
      pass.setVertexBuffer(0, vertex);
      pass.setIndexBuffer(index, 'uint32');
      pass.drawIndexed(3, 1, 0, 0, 0);
      if (fault !== 'omit')
        pass.drawIndexed(
          3,
          1,
          fault === 'first' ? 0 : level ? 6 : 3,
          fault === 'base' ? 0 : level ? 5 : 2,
          0,
        );
    },
    dispose() {
      f.dispose();
      assets.dispose();
      for (const texture of [
        skylightFallback.irradianceTexture,
        skylightFallback.prefilterTexture,
        skylightFallback.brdfLutTexture,
      ])
        device.destroyTexture(texture);
      device.destroyBuffer(skylightFallback.intensityBuffer);
      device.destroyBuffer(vertex).unwrap();
      device.destroyBuffer(index).unwrap();
    },
  };
}
