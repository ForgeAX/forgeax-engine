import { mat4, vec3 } from '@forgeax/engine-math';
import { RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { MaterialResource } from '../material-resource';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
} from '../record/shadow-pass';
import { MaterialDispatch } from '../scene/material-dispatch';

function frontDoors(paged = false, orderedSlots?: readonly number[]) {
  const resource = {};
  const material = new MaterialResource({
    materialHandle: 0,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [
      {
        name: 'shadow',
        program: { module: 'forgeax::default-standard-pbr', vertexEntry: 'vs_main' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: { shadow: 'forgeax::default-standard-pbr' },
  });
  const c = {
    dispatch: [],
    materialFrame: new MaterialDispatch().materials().with(material),
    materialSlots: [material.snapshot],
    materialSlotIndices: paged ? Array.from({ length: 26 }, () => [0]) : [[0]],
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    store: { materialResourceEpoch: 0 },
    world: { identity: 'shadow-front-door' },
    validatedOrdered: [
      {
        renderableIndex: 4,
        meshSlot: paged ? 25 : 0,
        source: {
          worldId: 0,
          entityKey: 1,
          transform: { world: mat4.identity(mat4.create()) },
          material,
          materials: [material],
        },
        mesh: {
          vertexBuffer: { handle: resource },
          layoutProjection: { attributes: [] },
          indexed: false,
          indexBuffer: null,
          submeshes: [
            {
              topology: 'triangle-list',
              materialSlot: 0,
              vertexCount: 3,
              indexCount: 0,
              indexOffset: 0,
            },
          ],
        },
      },
    ],
    runtime: {
      device: {
        caps: { storageBuffer: false },
        limits: { maxSampledTexturesPerShaderStage: 16 },
        createBindGroup: (descriptor: unknown) => ({ ok: true, value: descriptor }),
        queue: { writeBuffer: () => ({ ok: true, value: undefined }) },
      },
      getMaterialShaderPipelineEntry: () => ({ pipeline: {}, group2Contract: 'mesh' }),
      getParamSchema: () => [],
      errorRegistry: {
        fire: () => {
          throw Error('Unexpected RHI error');
        },
      },
    },
    pipelineState: {
      perPassResources: { shadowSampler: resource },
      identityInstanceBuffer: resource,
      instancesBindGroupLayout: resource,
      viewUniformBuffer: resource,
      shadowArrayFallbackTextureView: resource,
      shadowAtlasFallbackTextureView: resource,
      shadowParamsBuffer: resource,
      shadowCasterCascadeBuffer: resource,
      defaultWhiteTextureView: resource,
      defaultSampler: resource,
      viewBindGroupLayout: resource,
      materialBindGroupLayout: resource,
      materialUniformBuffer: { buffer: resource },
      meshStorageBuffer: { buffer: resource },
      meshBindGroupLayout: resource,
      defaultNormalTextureView: resource,
      fallbackTextureView: resource,
      skylightFallback: {
        sampler: resource,
        intensityBuffer: resource,
        irradianceView: resource,
        prefilterView: resource,
        brdfLutView: resource,
      },
    },
    frameState: {
      materialBgShared: new Map(),
      instancesBgShared: new WeakMap(),
      meshBindGroupCache: new WeakMap(),
      viewBindGroupCache: new WeakMap(),
      shadowMaterialBindGroups: new WeakMap(),
      pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
      spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
    },
    meshBindGroup: resource,
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  const secondPage = {};
  if (paged) {
    Object.assign(c, { shadowMaterialRowBase: 25 });
    Object.assign(c.pipelineState.meshStorageBuffer, {
      buffer: null,
      pages: { byteStride: 6400, byteSize: 16384, buffers: [resource, secondPage] },
    });
  }
  if (orderedSlots !== undefined) {
    const first = c.validatedOrdered[0];
    if (first === undefined) throw new Error('expected the fixture caster');
    Object.assign(c, {
      validatedOrdered: orderedSlots.map((meshSlot, index) => ({
        ...first,
        meshSlot,
        source: { ...first.source, entityKey: index + 1, shadowCaster: index !== 1 },
      })),
      materialSlotIndices: Array.from({ length: 28 }, () => [0]),
    });
  }
  const trace: unknown[] = [];
  const meshGroups: unknown[] = [];
  const pass = {
    setBindGroup: (...args: unknown[]) => {
      trace.push(['bg', args[0], args[2]]);
      if (args[0] === 2) meshGroups.push(args[1]);
    },
    setPipeline: () => trace.push(['pipeline']),
    setVertexBuffer: (...args: unknown[]) => trace.push(['vertex', args[0]]),
    draw: (...args: unknown[]) => trace.push(['draw', ...args]),
  } as unknown as RhiRenderPassEncoder;
  for (let cascade = 0; cascade < 3; cascade++) encodeDirectionalShadowPass(c, pass, cascade);
  for (let face = 0; face < 6; face++) encodePointShadowPass(c, pass, 0, face);
  encodeSpotShadowPass(c, pass, 0);
  return { trace, meshGroups, secondPage };
}
it('records an accepted caster for three directional cascades, six point faces and a spot', () => {
  const f = frontDoors();
  expect(f.trace.filter((entry) => (entry as unknown[])[0] === 'draw')).toEqual(
    Array.from({ length: 10 }, () => ['draw', 3, 1, 0, 0]),
  );
  expect(f.trace.filter((entry) => (entry as unknown[])[0] === 'vertex')).toHaveLength(10);
});

it('fails before recording when directional, point or spot bindings are unavailable', () => {
  const c = {
    validatedOrdered: [{}],
    runtime: { device: { caps: { storageBuffer: false } }, getMaterialShaderPipeline: () => ({}) },
    pipelineState: { perPassResources: { shadowSampler: null } },
    frameState: {
      pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
      spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
    },
  } as unknown as _InternalRenderPipelineContext;
  const pass = {} as RhiRenderPassEncoder;
  for (const encode of [
    () => encodeDirectionalShadowPass(c, pass, 0),
    () => encodePointShadowPass(c, pass, 0, 0),
    () => encodeSpotShadowPass(c, pass, 0),
  ])
    expect(encode).toThrowError(RhiError);
});

it('keeps directional, point and spot residuals on the same physical mesh page', () => {
  const f = frontDoors(true);
  expect(f.meshGroups).toHaveLength(10);
  for (const group of f.meshGroups) {
    expect(group).toMatchObject({
      label: 'pbr-mesh-bg',
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: f.secondPage, offset: 0, size: 12288 } },
        },
      ],
    });
  }
  expect(
    f.trace.filter((row) => (row as unknown[])[0] === 'bg' && (row as unknown[])[1] === 2),
  ).toEqual(Array.from({ length: 10 }, () => ['bg', 2, [0]]));
});

it('uses each prepared physical mesh row after caster filtering and reordering for every light', () => {
  const f = frontDoors(true, [26, 25, 27]);
  expect(f.trace.filter((row) => (row as unknown[])[0] === 'draw')).toHaveLength(20);
  expect(
    f.trace.filter((row) => (row as unknown[])[0] === 'bg' && (row as unknown[])[1] === 2),
  ).toEqual(
    Array.from({ length: 10 }, () => [
      ['bg', 2, [256]],
      ['bg', 2, [512]],
    ]).flat(),
  );
  for (const group of f.meshGroups)
    expect(group).toMatchObject({
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: f.secondPage, offset: 0 } } },
      ],
    });
});
