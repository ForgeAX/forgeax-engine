import type {
  GraphAccess,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  RhiError,
  type RenderPipeline as RhiPipeline,
} from '@forgeax/engine-rhi';
import {
  buildCapsuleShadowFrame,
  capsuleTileTableWords,
  MAX_FRAME_CAPSULES,
} from '../capsule-shadow/frame';
import { WORLD_CAPSULE_STRIDE } from '../capsule-shadow/world-capsules';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import type { GraphEnvironment } from '../environment/ibl';
import { atmosphereTextures } from '../environment/luts';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { buildPerFrameBindGroups } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from '../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { StandardClusterGraphBuffers } from './standard-lighting/graph';

/** Two vec4 lanes shared by the graph allocation and uniform binding layout. */
export const DEFERRED_LIGHTING_PARAMS_BYTES = 2 * 4 * Float32Array.BYTES_PER_ELEMENT;

export interface StandardDeferredShaderSources {
  readonly decalProject?: string;
  readonly decalApply?: string;
  readonly subsurface?: string;
  readonly clustered: string;
  readonly unclustered: string;
  readonly clusteredLut?: string;
  readonly unclusteredLut?: string;
}

/** Geometry initializes emissive; this pass adds deferred lighting radiance. */
export function addStandardDeferredLighting(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly color: RenderPipelineTarget;
    readonly gbuffer: readonly RenderPipelineTarget[];
    readonly receiverGeometry: RenderPipelineTarget;
    readonly depth: GraphTextureView;
    readonly reflectionFallback?: RenderPipelineTarget;
    readonly response?: RenderPipelineTarget;
    readonly diffuse?: RenderPipelineTarget;
    readonly ssao?: RenderPipelineTarget;
    readonly directionalShadow?: RenderPipelineTarget;
    readonly spotShadow: RenderPipelineTarget;
    readonly pointShadow?: RenderPipelineTarget;
    readonly cloudShadow?: RenderPipelineTarget;
    readonly environment?: GraphEnvironment;
    readonly cluster: StandardClusterGraphBuffers | null;
    readonly extraAccesses: readonly GraphAccess[];
    /** Lighting target extent; sizes the capsule shadow tile table. */
    readonly size: { readonly width: number; readonly height: number };
  },
) {
  const params = graph.createBuffer('deferred-lighting-params', {
    size: DEFERRED_LIGHTING_PARAMS_BYTES,
  });
  if (!params.ok) return params;
  const capsuleBytes = MAX_FRAME_CAPSULES * WORLD_CAPSULE_STRIDE * 4;
  const tileBytes = capsuleTileTableWords(input.size.width, input.size.height) * 4;
  const capsules = graph.createBuffer('capsule-shadow-capsules', { size: capsuleBytes });
  if (!capsules.ok) return capsules;
  const capsuleTiles = graph.createBuffer('capsule-shadow-tiles', {
    size: tileBytes,
  });
  if (!capsuleTiles.ok) return capsuleTiles;
  const probe = graph.importBuffer(
    'deferred-probe-records',
    { size: 256, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => {
      const buffer = (frame as _InternalRenderPipelineContext).frameState.probeBlendRecordBuffer;
      if (buffer === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'prepared Standard probe records',
          hint: 'prepare the deferred frame before recording lighting',
        });
      return buffer.handle;
    },
  );
  if (!probe.ok) return probe;
  const upload = graph.addCopyPass('deferred-lighting-prepare', {
    accesses: [
      { resource: params.value, usage: 'copy-dst' },
      { resource: capsules.value, usage: 'copy-dst' },
      { resource: capsuleTiles.value, usage: 'copy-dst' },
    ],
    encode: ({ frame, resources, encoder }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const settings = internal.frameState.installedPipelineConfig?.ssao;
      const queue = frame.runtime.device.queue;
      // Lane y rotates the contact-shadow noise only under temporal
      // accumulation; without it a static pattern avoids visible crawl.
      const noiseFrame = (frame.camera.temporal?.temporalFrameIndex ?? 0) % 64;
      const light = internal.capsuleShadowLight;
      // Capsule storage has its own budget; scene sources survive release of
      // unused legacy geometry slots in the GPU-driven Shadow lane.
      const capsuleFrame =
        light === undefined
          ? undefined
          : buildCapsuleShadowFrame(
              light.renderables,
              frame.camera,
              light.direction,
              light.coneHalfAngle,
              input.size.width,
              input.size.height,
            );
      if (capsuleFrame !== undefined) {
        // Auxiliary capture views shade their own tiles; inspection reports the display view.
        if (frame.camera.captureProjection === undefined)
          internal.frameState.capsuleShadowSubmission = capsuleFrame.submission;
        if (capsuleFrame.capsules.length > 0) {
          queue
            .writeBuffer(resources.buffer(capsules.value).unwrap(), 0, capsuleFrame.capsules)
            .unwrap();
          queue
            .writeBuffer(resources.buffer(capsuleTiles.value).unwrap(), 0, capsuleFrame.tiles)
            .unwrap();
        }
      }
      // The graph declares full storage reads. Define the unused tails too,
      // including the disabled case, so captured frames need no previous contents.
      // Queue uploads precede encoder submission: clear only beyond their prefixes.
      const populated = (capsuleFrame?.capsules.length ?? 0) > 0;
      for (const [ref, capacity, used] of [
        [capsules.value, capsuleBytes, populated ? (capsuleFrame?.capsules.byteLength ?? 0) : 0],
        [capsuleTiles.value, tileBytes, populated ? (capsuleFrame?.tiles.byteLength ?? 0) : 0],
      ] as const) {
        if (used < capacity)
          encoder.clearBuffer(resources.buffer(ref).unwrap(), used, capacity - used);
      }
      queue
        .writeBuffer(
          resources.buffer(params.value).unwrap(),
          0,
          new Float32Array([
            input.ssao === undefined ? 0 : (settings?.intensity ?? 1),
            noiseFrame,
            // Lane z gates the capsule evaluation; lane w is the light cone half-angle.
            capsuleFrame?.submission.capsuleCount ?? 0,
            capsuleFrame?.coneHalfAngle ?? 0,
            input.ssao === undefined ? 0 : (settings?.directLightingStrength ?? 0),
            0,
            0,
            0,
          ]),
        )
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const colors = [
    input.color,
    ...(input.reflectionFallback === undefined ? [] : [input.reflectionFallback]),
    ...(input.response === undefined ? [] : [input.response]),
    ...(input.diffuse === undefined ? [] : [input.diffuse]),
  ];
  const sampled = [
    ...input.gbuffer.map((target) => target.view),
    input.receiverGeometry.view,
    input.depth,
    ...[
      input.ssao,
      input.directionalShadow,
      input.spotShadow,
      input.pointShadow,
      input.cloudShadow,
    ].flatMap((target) => (target === undefined ? [] : [target.view])),
    ...(input.environment === undefined
      ? []
      : [
          input.environment.irradiance,
          input.environment.prefilter,
          ...(input.environment.atmosphere === undefined
            ? []
            : atmosphereTextures(input.environment.atmosphere)),
        ]),
  ];
  const states = new Map<
    boolean,
    {
      pipeline: RhiPipeline;
      material: BindGroupLayout;
      cluster: BindGroupLayout;
      probe: BindGroupLayout;
      groups: WeakMap<object, unknown>;
    }
  >();
  return graph.addRasterPass('lighting', {
    accesses: [
      ...sampled.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      ...colors.map((target) => ({ resource: target.view, usage: 'color-attachment' as const })),
      { resource: params.value, usage: 'uniform-read' },
      { resource: probe.value, usage: 'storage-read' },
      { resource: capsules.value, usage: 'storage-read' },
      { resource: capsuleTiles.value, usage: 'storage-read' },
      ...input.extraAccesses,
    ],
    colorAttachments: colors.map((target, index) => ({
      view: target.view,
      loadOp: index === 0 ? ('load' as const) : ('clear' as const),
      storeOp: 'store' as const,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const device = frame.runtime.device;
      const usesLut = (internal.validatedOrdered ?? []).some((entry) =>
        entry.source.materials.some((material) =>
          materialUsesDirectDfgLut(material.materialParamSchema),
        ),
      );
      const source =
        input.cluster === null
          ? usesLut
            ? internal.runtime.standardDeferredShaders?.unclusteredLut
            : internal.runtime.standardDeferredShaders?.unclustered
          : usesLut
            ? internal.runtime.standardDeferredShaders?.clusteredLut
            : internal.runtime.standardDeferredShaders?.clustered;
      if (source === undefined)
        throw new RhiError({
          code: 'shader-compile-failed',
          expected: 'cooked Standard deferred lighting program',
          hint: 'rebuild the Engine shader manifest and reinitialize the Renderer',
        });
      let state = states.get(usesLut);
      if (state === undefined) {
        const module = frame.runtime.shaderModuleFactory
          ?.createShaderModule({
            code: source,
            label: `standard_deferred_${input.cluster !== null}_${usesLut}`,
          })
          .unwrap();
        if (module === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'deferred shader module factory',
            hint: 'initialize the Renderer backend',
          });
        const material = device
          .createBindGroupLayout({
            label: 'deferred-surface-environment',
            entries: [
              ...Array.from({ length: 6 }, (_, binding) => ({
                binding,
                visibility: 2,
                texture: {
                  sampleType:
                    binding < 4
                      ? ('uint' as const)
                      : binding === 4
                        ? ('depth' as const)
                        : ('float' as const),
                  viewDimension: '2d' as const,
                },
              })),
              { binding: 6, visibility: 2, sampler: { type: 'filtering' } },
              {
                binding: 7,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: DEFERRED_LIGHTING_PARAMS_BYTES },
              },
              ...[8, 9, 10, 11].map((binding) => ({
                binding,
                visibility: 2,
                texture: {
                  sampleType: 'float' as const,
                  viewDimension: binding === 10 ? ('2d' as const) : ('cube' as const),
                },
              })),
              { binding: 12, visibility: 2, buffer: { type: 'uniform', minBindingSize: 64 } },
              { binding: 13, visibility: 2, buffer: { type: 'read-only-storage' } },
              { binding: 14, visibility: 2, buffer: { type: 'read-only-storage' } },
              { binding: 15, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
              ...(usesLut
                ? [
                    {
                      binding: 16,
                      visibility: 2,
                      texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                    },
                  ]
                : []),
            ],
          })
          .unwrap();
        const cluster = device
          .createBindGroupLayout({
            entries:
              input.cluster === null
                ? []
                : [3, 4, 5, 6].map((binding) => ({
                    binding,
                    visibility: 2,
                    buffer: {
                      type: binding === 6 ? ('uniform' as const) : ('read-only-storage' as const),
                    },
                  })),
          })
          .unwrap();
        const probeLayout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 2,
                buffer: { type: 'read-only-storage', minBindingSize: 256 },
              },
            ],
          })
          .unwrap();
        const layout = device
          .createPipelineLayout({
            bindGroupLayouts: [
              internal.pipelineState.viewBindGroupLayout,
              material,
              cluster,
              probeLayout,
            ],
          })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'standard-deferred-lighting',
            layout,
            vertex: { module, entryPoint: 'vs_standard_deferred', buffers: [] },
            fragment: {
              module,
              entryPoint:
                input.diffuse !== undefined && input.reflectionFallback === undefined
                  ? 'fs_standard_deferred_subsurface'
                  : colors.length === 1
                    ? 'fs_standard_deferred'
                    : 'fs_standard_deferred_reflections',
              targets: colors.map((target, index) => ({
                format: target.format,
                ...(index === 0
                  ? {
                      blend: {
                        color: {
                          operation: 'add' as const,
                          srcFactor: 'one' as const,
                          dstFactor: 'one' as const,
                        },
                        alpha: {
                          operation: 'add' as const,
                          srcFactor: 'zero' as const,
                          dstFactor: 'one' as const,
                        },
                      },
                    }
                  : {}),
              })),
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
          })
          .unwrap();
        state = { pipeline, material, cluster, probe: probeLayout, groups: new WeakMap() };
        states.set(usesLut, state);
      }
      const current = state;
      const directDfgLut = usesLut
        ? getOrCreateDirectDfgLut(device, internal.runtime.deviceScope).unwrap()
        : undefined;
      const view = (target: RenderPipelineTarget | undefined) =>
        target === undefined ? undefined : resources.textureView(target.view).unwrap();
      const bindings = buildPerFrameBindGroups(
        internal.runtime as RenderSystemInternals,
        internal.frameState,
        internal.pipelineState,
        true,
        internal.bindGroupCounts,
        {
          atmosphere:
            input.environment?.atmosphere === undefined
              ? undefined
              : {
                  transmittance: resources
                    .textureView(input.environment.atmosphere.transmittance)
                    .unwrap(),
                  distantSkyLight: resources
                    .textureView(input.environment.atmosphere.distantSkyLight)
                    .unwrap(),
                  multipleScattering: resources
                    .textureView(input.environment.atmosphere.multipleScattering)
                    .unwrap(),
                  aerialPerspective: resources
                    .textureView(input.environment.atmosphere.aerialPerspective)
                    .unwrap(),
                  aerialTransmittance: resources
                    .textureView(input.environment.atmosphere.aerialTransmittance)
                    .unwrap(),
                },
          directionalShadow: view(input.directionalShadow),
          spotShadow: view(input.spotShadow),
          cloudShadow: view(input.cloudShadow),
          projector: internal.spotLightProjector?.view,
          projectorSampler: internal.spotLightProjector?.sampler,
        },
        true,
        internal.standardLighting,
      );
      if (bindings.viewBindGroup === null)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'Standard view/shadow resources',
          hint: 'repair the frame lighting resources',
        });
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, bindings.viewBindGroup, [0, 0]);
      if (input.cluster?.kind === 'texture')
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'Deferred lighting requires storage-buffer capabilities',
          hint: 'use the Standard Forward path on this device',
        });
      const clusterBuffers =
        input.cluster === null
          ? []
          : [
              input.cluster.lightData,
              input.cluster.clusterGrid,
              input.cluster.lightIndexList,
              input.cluster.clusterUniform,
            ].map((ref) => resources.buffer(ref).unwrap());
      const clusterGroup = getOrCreateFromChain(
        state.groups,
        [state.cluster, ...clusterBuffers],
        'deferred-cluster',
        () =>
          device
            .createBindGroup({
              layout: current.cluster,
              entries: clusterBuffers.map((buffer, index) => ({
                binding: index + 3,
                resource: { kind: 'buffer' as const, value: { buffer } },
              })),
            })
            .unwrap(),
        internal.bindGroupCounts,
      );
      pass.setBindGroup(2, clusterGroup);
      const probeBuffer = resources.buffer(probe.value).unwrap();
      const probeGroup = getOrCreateFromChain(
        state.groups,
        [state.probe, probeBuffer],
        'deferred-probe',
        () =>
          device
            .createBindGroup({
              layout: current.probe,
              entries: [
                {
                  binding: 0,
                  resource: { kind: 'buffer' as const, value: { buffer: probeBuffer } },
                },
              ],
            })
            .unwrap(),
        internal.bindGroupCounts,
      );
      pass.setBindGroup(3, probeGroup);
      const environment =
        input.environment === undefined
          ? internal
          : {
              ...internal,
              environmentIbl: {
                irradiance: resources.textureView(input.environment.irradiance).unwrap(),
                prefilter: resources.textureView(input.environment.prefilter).unwrap(),
              },
            };
      const sky = prepareMaterialSkylight(environment).skylightResources;
      const environments: SkylightBindGroupResources[] = [sky];
      for (const row of internal.reflectionProbes?.table.rows ?? []) {
        if (
          row.filteredView === undefined ||
          row.sampler === undefined ||
          row.uniformBuffer === undefined
        )
          continue;
        if (row.index >= 255)
          throw new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'at most 255 deferred reflection environments',
            hint: 'reduce the resident reflection-probe roster',
          });
        environments.push({
          ...sky,
          prefilterView: row.filteredView,
          prefilterSampler: row.sampler,
          skylightPrefilterView: sky.prefilterView,
          intensityBuffer: row.uniformBuffer,
        });
      }
      const surfaces = [
        ...input.gbuffer.map((target) => resources.textureView(target.view).unwrap()),
        resources.textureView(input.depth).unwrap(),
        view(input.ssao) ?? internal.pipelineState.defaultWhiteTextureView,
      ];
      const paramsBuffer = resources.buffer(params.value).unwrap();
      const receiverView = resources.textureView(input.receiverGeometry.view).unwrap();
      const capsuleBuffers = [capsules.value, capsuleTiles.value].map((ref) =>
        resources.buffer(ref).unwrap(),
      );
      for (const env of environments) {
        const keys = [
          ...surfaces,
          receiverView,
          env.irradianceSampler,
          paramsBuffer,
          ...capsuleBuffers,
          env.irradianceView,
          env.prefilterView,
          env.brdfLutView,
          env.skylightPrefilterView ?? env.prefilterView,
          env.intensityBuffer,
          ...(directDfgLut === undefined ? [] : [directDfgLut.view]),
        ];
        const group = getOrCreateFromChain(
          state.groups,
          keys,
          'deferred-environment',
          () =>
            device
              .createBindGroup({
                layout: current.material,
                entries: [
                  {
                    binding: 15,
                    resource: {
                      kind: 'textureView' as const,
                      value: receiverView,
                    },
                  },
                  ...surfaces.map((resource, binding) => ({
                    binding,
                    resource: { kind: 'textureView' as const, value: resource },
                  })),
                  {
                    binding: 6,
                    resource: { kind: 'sampler' as const, value: env.irradianceSampler },
                  },
                  {
                    binding: 7,
                    resource: { kind: 'buffer' as const, value: { buffer: paramsBuffer } },
                  },
                  {
                    binding: 8,
                    resource: { kind: 'textureView' as const, value: env.irradianceView },
                  },
                  {
                    binding: 9,
                    resource: { kind: 'textureView' as const, value: env.prefilterView },
                  },
                  {
                    binding: 10,
                    resource: { kind: 'textureView' as const, value: env.brdfLutView },
                  },
                  {
                    binding: 11,
                    resource: {
                      kind: 'textureView' as const,
                      value: env.skylightPrefilterView ?? env.prefilterView,
                    },
                  },
                  {
                    binding: 12,
                    resource: { kind: 'buffer' as const, value: { buffer: env.intensityBuffer } },
                  },
                  ...capsuleBuffers.map((buffer, index) => ({
                    binding: 13 + index,
                    resource: { kind: 'buffer' as const, value: { buffer } },
                  })),
                  ...(directDfgLut === undefined
                    ? []
                    : [
                        {
                          binding: 16,
                          resource: { kind: 'textureView' as const, value: directDfgLut.view },
                        },
                      ]),
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        );
        pass.setBindGroup(1, group);
        pass.draw(3);
      }
    },
  });
}
