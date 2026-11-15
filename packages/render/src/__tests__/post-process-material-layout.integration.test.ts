import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  PipelineLayout,
  PipelineLayoutDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
} from '@forgeax/engine-rhi';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createMaterialProgramArtifactReceipt } from '@forgeax/engine-shader';
import { ok, type WaterBodyAsset, type WaterZoneAsset } from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  WaterSystem,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, Camera, MeshFilter, MeshRenderer } from '../components';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { POST_PROCESS_VIEW_UNIFORM_OFFSET } from '../record/view-ubo';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each([
  { copyShader: 'supporting-copy' },
  { copyShader: 'fullscreen-material-layout' },
  { copyShader: 'supporting-copy', antialias: 'taa' as const },
  { copyShader: 'supporting-copy', waterInfoFormat: 'rgba16float' as const },
  { copyShader: 'supporting-copy', waterInfoFormat: 'rgba32float' as const },
])('records planned copy $copyShader and fullscreen scene inputs with WaterInfo $waterInfoFormat', async ({
  copyShader,
  waterInfoFormat,
  antialias,
}) => {
  const shader = 'test::fullscreen-material';
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const observeFullscreenMaterialRecording = () => {
    const bindGroups = new Map<BindGroupLayout, BindGroupLayoutDescriptor>();
    const layouts = new Map<PipelineLayout, PipelineLayoutDescriptor>();
    const pipelines: RenderPipelineDescriptor[] = [];
    const pipelineDescriptors = new Map<RenderPipeline, RenderPipelineDescriptor>();
    const createdBindGroups = new Map<BindGroup, BindGroupDescriptor>();
    const recorded = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setPipeline');
    const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'draw');
    const bindings = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setBindGroup');
    const createBindGroup = device.createBindGroup.bind(device);
    device.createBindGroup = (descriptor) => {
      const result = createBindGroup(descriptor);
      if (result.ok) createdBindGroups.set(result.value, descriptor);
      return result;
    };
    const createBindGroupLayout = device.createBindGroupLayout.bind(device);
    device.createBindGroupLayout = (descriptor) => {
      const result = createBindGroupLayout(descriptor);
      if (result.ok) bindGroups.set(result.value, descriptor);
      return result;
    };
    const createPipelineLayout = device.createPipelineLayout.bind(device);
    device.createPipelineLayout = (descriptor) => {
      const result = createPipelineLayout(descriptor);
      if (result.ok) layouts.set(result.value, descriptor);
      return result;
    };
    const createRenderPipeline = device.createRenderPipeline.bind(device);
    device.createRenderPipeline = (descriptor) => {
      pipelines.push(descriptor);
      const result = createRenderPipeline(descriptor);
      if (result.ok) pipelineDescriptors.set(result.value, descriptor);
      return result;
    };
    return {
      bindGroups,
      layouts,
      pipelines,
      pipelineDescriptors,
      createdBindGroups,
      recorded,
      draws,
      bindings,
    };
  };
  const {
    bindGroups,
    layouts,
    pipelines,
    pipelineDescriptors,
    createdBindGroups,
    recorded,
    draws,
    bindings,
  } = observeFullscreenMaterialRecording();
  const copySource =
    '@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(i), 0, 0, 1); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1); }';
  let featureFrame = 0;
  let waterSource:
    | { readonly bodyKey: string; readonly bodyGeneration: number; readonly zoneGeneration: number }
    | undefined;
  const waterEntryPoints = [
    { name: 'fs_main', stage: 'fragment' as const, bindings: [{ group: 2, binding: 18 }] },
  ];
  const feature: RenderFeature<number> = {
    identity: 'fullscreen-material-layout',
    placement: 'after-tonemap',
    requiredFullscreenPostProcesses: [{ identity: copyShader, source: copySource }],
    extract: () => ok(++featureFrame),
    plan: (data, context) =>
      ok({
        work: context.views.map((view) => ({
          scope: { view: view.identity },
          resources: [
            {
              kind: 'graph-texture',
              name: 'material-input',
              allocationKey: 'material-input',
              descriptor: {
                format: 'rgba16float',
                size: { width: 64, height: 64, depthOrArrayLayers: 1 },
                sampleCount: 1,
              },
            },
            { kind: 'fullscreen-program', name: copyShader, source: copySource },
            {
              kind: 'buffer',
              name: 'pass-inputs',
              size: 16,
              usage: ['uniform'],
              data: new Float32Array([0, 1, 1, data]),
            },
            {
              kind: 'graphics-program',
              name: 'copy',
              program: {
                shader: copyShader,
                preparePipelines: true,
                vertexLayout: 'none',
                colorFormats: ['rgba16float'],
                sampleCount: 1,
              },
            },
            {
              kind: 'graphics-program',
              name: 'material',
              program: {
                shader,
                preparePipelines: true,
                vertexLayout: 'none',
                colorFormats: ['rgba16float'],
                sampleCount: 1,
              },
            },
            {
              kind: 'graphics-bindings',
              name: 'scene-inputs',
              program: 'material',
              values: {
                group: 0,
                postProcess: true,
                sceneColor: 'material-input',
                sceneDepth: 'depth',
                passInputBuffer: 'pass-inputs',
                uniformBuffers: ['pass-inputs'],
              },
              logicalTargets: { sceneColor: 'material-input', sceneDepth: 'depth' },
            },
            ...(waterSource === undefined
              ? []
              : [
                  {
                    kind: 'graphics-bindings' as const,
                    name: 'water-inputs',
                    program: 'material',
                    values: {
                      group: 2,
                      waterMaterial: {
                        ...waterSource,
                        viewIdentity: view.identity,
                        programInputs: {
                          entryPoints: waterEntryPoints,
                          systemInputs: { water: 'water-frame/3' as const },
                        },
                      },
                    },
                  },
                ]),
          ],
          passes: [
            {
              kind: 'raster',
              name: 'copy',
              colorAttachments: [{ target: 'material-input', loadOp: 'clear', storeOp: 'store' }],
              sampledTargets: ['color'],
              draws: [
                {
                  program: 'copy',
                  vertexLayout: 'none',
                  vertexData: [],
                  bindings: [],
                  draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
            {
              kind: 'raster',
              name: 'material',
              sceneDepth: 'before-pass',
              colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
              sampledTargets: ['material-input', 'depth'],
              draws: [
                {
                  program: 'material',
                  vertexLayout: 'none',
                  vertexData: [],
                  bindings: [
                    'scene-inputs',
                    ...(waterSource === undefined ? [] : ['water-inputs']),
                  ],
                  draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
          ],
        })),
      }),
  };
  const base = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(base.slice(base.indexOf(',') + 1)));
  const schema = [{ name: 'tint', type: 'color' as const }];
  manifest.materialShaders.push({
    identifier: shader,
    sourcePath: shader,
    hash: 'fullscreen',
    composedWgsl:
      waterInfoFormat === undefined
        ? copySource
        : '@group(2) @binding(18) var waterInfo: texture_2d_array<f32>;\n@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(i), 0, 0, 1); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return textureLoad(waterInfo, vec2<i32>(0), 0, 0); }',
    paramSchema: JSON.stringify(schema),
    variants: [],
    receipt: {
      ...createMaterialProgramArtifactReceipt({ schema, directEntry: 'vs_main', vertexInputs: [] }),
      bindings: 'post-process',
      ...(waterInfoFormat === undefined
        ? {}
        : {
            systemInputs: { water: 'water-frame/3' },
            entryPoints: waterEntryPoints,
          }),
      sceneDepth: 'before-pass',
      postProcess: {
        placement: 'after-tonemap',
        input: 'current-output',
        output: 'current-output',
      },
    },
  });
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    {
      features: [feature],
      rhi: {
        ...rhi,
        requestAdapter: async () =>
          ok({ features: new Set(), limits: {}, requestDevice: async () => ok(device) }),
      },
    },
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
  );
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    const initialized = await renderer.initialization;
    if (!initialized.ok) throw initialized.error;
    const world = new World({ assets: renderer.assetRegistry });
    registerPropagateTransforms(world);
    if (waterInfoFormat !== undefined) {
      const packageId = definePackageId('019a0000-0000-7000-8000-000000000497');
      const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
      const zoneGuid = guid('zone');
      const zone: WaterZoneAsset = {
        kind: 'water-zone',
        extentM: { spanXM: 16, spanZM: 16 },
        tileSizeM: 8,
        tessellationFactor: 1,
        lodScale: 1,
        waterInfo: {
          resolution: { widthPx: 16, heightPx: 16 },
          format: waterInfoFormat === 'rgba16float' ? 'rgba16f' : 'rgba32f',
          blurRadius: 0,
          localTessellation: false,
        },
      };
      const point = (inputKey: number, x: number, z: number) => ({
        inputKey,
        positionM: [x, 0, z] as const,
        arriveTangentM: [0, 0, 0] as const,
        leaveTangentM: [0, 0, 0] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 1,
        depthM: 2,
        velocityMPerSec: 0,
        audioIntensity: 0,
        interpolationMode: 'linear' as const,
        rotationQuat: [0, 0, 0, 1] as const,
      });
      const packed = (
        await buildWaterPackOutputs(
          {
            body: {
              kind: 'water-body',
              type: 'lake',
              zoneGuid,
              spline: {
                closed: true,
                points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
              },
              baseHeightM: 0,
              overlapPriority: 0,
              maxWaveHeightM: 0,
              surfaceMaterialGuid: guid('material'),
              flags: { affectsWaterInfo: true, affectsWaterMesh: false, affectsLandscape: false },
              collision: { type: 'none', enabled: false },
              queryFootprint: [
                [-2, -2],
                [2, -2],
                [2, 2],
                [-2, 2],
              ],
            },
          },
          { packageId },
        )
      ).unwrap();
      const outputs = new Map(Object.entries(packed).map(([key, asset]) => [guid(key), asset]));
      const water = new WaterSystem(
        (candidate) => (candidate === zoneGuid ? { generation: 1, asset: zone } : undefined),
        (asset) =>
          (['waterInfoMeshGuid', 'dilatedWaterInfoMeshGuid', 'visibleMeshGuid'] as const).flatMap(
            (field) => {
              const dependencyGuid = asset[field];
              const payload =
                dependencyGuid === undefined ? undefined : outputs.get(dependencyGuid);
              return dependencyGuid === undefined || payload === undefined
                ? []
                : [
                    {
                      guid: dependencyGuid,
                      field,
                      kind: 'mesh',
                      status: 'valid' as const,
                      payload,
                    },
                  ];
            },
          ),
        () => [{ guid: zoneGuid, generation: 1, asset: zone }],
      );
      const body = water.mountBody('lake', '1', packed.body as WaterBodyAsset).unwrap();
      water
        .acceptOutput('lake', 'geometry', body.outputGenerations.geometry, {
          generation: 1,
          digest: 'fullscreen-water-geometry',
        })
        .unwrap();
      world.insertResource(WATER_SYSTEM_RESOURCE, water);
      waterSource = {
        bodyKey: waterBodyOwnerKey(world.identity, 'lake', body.sceneGeneration, 1),
        bodyGeneration: body.sceneGeneration,
        zoneGeneration: 1,
      };
    }
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: antialias === 'taa' ? ANTIALIAS_TAA : ANTIALIAS_NONE,
          },
        },
      )
      .unwrap();
    const mesh = renderer.assetRegistry.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const material = renderer.assetRegistry.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update(0).unwrap();
    let submission: ReturnType<typeof renderer.draw> | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      recorded.mockClear();
      draws.mockClear();
      bindings.mockClear();
      submission = renderer.draw({ source: lease });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (
        recorded.mock.calls.some(([pipeline]) =>
          pipelineDescriptors.get(pipeline)?.label?.includes(shader),
        )
      )
        break;
    }
    expect(
      submission?.ok,
      JSON.stringify({ submission, errors }, (_key, value) =>
        value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value,
      ),
    ).toBe(true);
    expect(
      recorded.mock.calls
        .map(([pipeline]) => pipelineDescriptors.get(pipeline)?.label)
        .filter((label) => label?.includes(copyShader) || label?.includes(shader)),
    ).toEqual([expect.stringContaining(copyShader), expect.stringContaining(shader)]);
    const featureDraws = () =>
      draws.mock.calls.filter((_, drawIndex) => {
        const drawOrder = draws.mock.invocationCallOrder[drawIndex];
        if (drawOrder === undefined) return false;
        const pipelineIndex = recorded.mock.invocationCallOrder.reduce(
          (last, order, index) => (order < drawOrder ? index : last),
          -1,
        );
        const pipeline = recorded.mock.calls[pipelineIndex]?.[0];
        const label = pipeline === undefined ? undefined : pipelineDescriptors.get(pipeline)?.label;
        return label?.includes(copyShader) || label?.includes(shader);
      });
    expect(featureDraws()).toHaveLength(2);
    const materialGroups = () =>
      bindings.mock.calls.filter((_, bindingIndex) => {
        const bindingOrder = bindings.mock.invocationCallOrder[bindingIndex];
        if (bindingOrder === undefined) return false;
        const pipelineIndex = recorded.mock.invocationCallOrder.reduce(
          (last, order, index) => (order < bindingOrder ? index : last),
          -1,
        );
        const pipeline = recorded.mock.calls[pipelineIndex]?.[0];
        return pipeline !== undefined && pipelineDescriptors.get(pipeline)?.label?.includes(shader);
      });
    const expectWaterGroups = () => {
      expect(
        [...createdBindGroups.values()].filter(
          (group) => group.label === 'standard-surface-lighting',
        ),
      ).toEqual([]);
      const waterGroups = materialGroups().filter(([group]) => group === 2);
      expect(waterGroups).toHaveLength(waterInfoFormat === undefined ? 0 : 1);
      for (const [, handle] of waterGroups) {
        const descriptor = createdBindGroups.get(handle);
        expect(Array.from(descriptor?.entries ?? [], (entry) => entry.binding)).toEqual([18]);
      }
    };
    const assertFullscreenMaterialInputLayouts = () => {
      const pipeline = pipelines.find((descriptor) => descriptor.label?.includes(shader));
      expect(pipeline).toBeDefined();
      const layout =
        pipeline?.layout === undefined || pipeline.layout === 'auto'
          ? undefined
          : layouts.get(pipeline.layout);
      const groupLayouts = Array.from(layout?.bindGroupLayouts ?? []);
      const sceneInputs = materialGroups().find(([group]) => group === 0)?.[1];
      const view =
        sceneInputs === undefined
          ? undefined
          : Array.from(createdBindGroups.get(sceneInputs)?.entries ?? []).find(
              (entry) => entry.binding === 0,
            )?.resource;
      expect(view).toMatchObject({
        kind: 'buffer',
        value: { offset: antialias === 'taa' ? POST_PROCESS_VIEW_UNIFORM_OFFSET : 0 },
      });
      expectWaterGroups();
      const scene = groupLayouts[0];
      expect(scene === undefined ? undefined : bindGroups.get(scene)?.entries).toEqual([
        expect.objectContaining({ binding: 0, buffer: { type: 'uniform' } }),
        expect.objectContaining({
          binding: 1,
          texture: { sampleType: 'float', viewDimension: '2d' },
        }),
        expect.objectContaining({
          binding: 2,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        }),
        expect.objectContaining({ binding: 3, buffer: { type: 'uniform', minBindingSize: 16 } }),
      ]);
      expect(groupLayouts).toHaveLength(waterInfoFormat === undefined ? 2 : 3);
      if (waterInfoFormat !== undefined) {
        const waterLayout = groupLayouts[2];
        expect(
          waterLayout === undefined ? undefined : bindGroups.get(waterLayout)?.entries,
        ).toEqual([
          {
            binding: 18,
            visibility: 2,
            texture: {
              sampleType: waterInfoFormat === 'rgba16float' ? 'float' : 'unfilterable-float',
              viewDimension: '2d-array',
            },
          },
        ]);
      }
      expect(pipeline?.vertex.buffers).toEqual([]);
    };
    assertFullscreenMaterialInputLayouts();
    for (let frame = 0; frame < 3; frame++) {
      recorded.mockClear();
      draws.mockClear();
      bindings.mockClear();
      const submitted = renderer.draw({ source: lease });
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
      expect(featureDraws()).toHaveLength(2);
      expectWaterGroups();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    await renderer.dispose();
    recorded.mockRestore();
    draws.mockRestore();
    bindings.mockRestore();
  }
});
