import { mat4 } from '@forgeax/engine-math';
import { type BindGroupLayoutEntry, err, ok, type Result, sha256 } from '@forgeax/engine-types';
import { WATER_SYSTEM_RESOURCE, waterBodyOwnerKey } from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../features/plan';
import type {
  RenderFeature,
  RenderFeatureExtractView,
  RenderFeatureSubmission,
} from '../features/types';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../gpu-texture-usage';
import { waterGpuOcclusionWgsl } from './gpu-mesh-occlusion';
import {
  waterGpuCountWgsl,
  waterGpuMergeWgsl,
  waterGpuMipWgsl,
  waterGpuPrefixWgsl,
  waterGpuScatterWgsl,
  waterGpuTraverseWgsl,
} from './gpu-mesh-shaders';
import {
  WATER_GPU_MESH_FEATURE,
  type WaterGpuMeshZone,
  waterGpuMeshBufferSizes,
  waterGpuMeshResource,
} from './gpu-mesh-source';
import {
  type WaterInfoFramePublication,
  waterGpuMeshPublicationReadiness,
  waterInfoFramePublicationForRenderer,
} from './water-info-feature';

type ZoneFrame = Readonly<{
  source: WaterGpuMeshZone;
  worldIdentity: string;
  staticDigest: string;
  rebuild: boolean;
  views: readonly Readonly<{
    view: RenderFeatureExtractView;
    publication: WaterInfoFramePublication;
  }>[];
}>;
type GpuMeshFrame = Readonly<{
  zones: readonly ZoneFrame[];
  inspection: readonly unknown[];
  sourceViews?: readonly string[];
}>;
const failure = (expected: string, cause?: unknown) =>
  new RenderFeatureStageFailedError(WATER_GPU_MESH_FEATURE, -1, 'plan', 'next-frame', {
    expected,
    cause,
  });
const storage = (binding: number, read = true): BindGroupLayoutEntry => ({
  binding,
  visibility: 4,
  buffer: { type: read ? 'read-only-storage' : 'storage' },
});
const compute = (
  name: string,
  wgsl: string,
  entries: readonly BindGroupLayoutEntry[],
  entryPoints: readonly string[],
): RenderFeatureResourceDeclaration => ({
  kind: 'compute-program',
  name,
  preparePipelines: true,
  program: { wgsl, entryPoints, bindings: [{ entries }] },
});
const submittedComputeCount = (
  pass: RenderFeatureSubmission['works'][number]['passes'][number] | undefined,
) => pass?.resolvedGpuCompute?.dispatches.length ?? pass?.resolvedGpuComputeDispatchCount ?? 0;

function staticDigest(source: WaterGpuMeshZone): string {
  return sha256(
    JSON.stringify([
      source.width,
      source.height,
      source.originXZ,
      source.extentXZ,
      source.yMin,
      source.yMax,
      source.zone.asset.gpuMesh?.supersampling,
      source.zone.asset.gpuMesh?.msaaSamples,
      source.bodies.map((body) => [
        body.guid,
        body.generation,
        body.type,
        body.rasterIndex,
        body.prioritySlot,
        body.yMin,
        body.yMax,
        body.surfaceY,
        body.maxWaveHeightM,
        Array.from(body.vertices),
      ]),
    ]),
  );
}

function makeWork(
  frame: ZoneFrame,
  context: RenderFeaturePlanContext,
): Result<readonly RenderFeatureWork[], RenderError> {
  const source = frame.source,
    saved = requireWaterValue(source.zone.asset.gpuMesh);
  const name = (kind: string) => waterGpuMeshResource(source.key, kind);
  let resources: RenderFeatureResourceDeclaration[] = [],
    passes: RenderFeatureWork['passes'][number][] = [];
  const viewCount = frame.views.length,
    rows = source.materials.length;
  const sizes = waterGpuMeshBufferSizes({
    viewCount: 1,
    materialCount: source.materials.length,
    tileCapacity: source.tileCapacity,
  });
  const maxBinding = Math.min(
    context.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024,
    context.limits?.maxBufferSize ?? 256 * 1024 * 1024,
  );
  const candidateBytes = source.nodeCount * viewCount * 32;
  const paramsBytes = (7 + source.mipOffsets.length) * 16;
  const maxWorkgroups = context.limits?.maxComputeWorkgroupsPerDimension ?? 65535;
  const counts = [viewCount, rows, source.nodeCount * viewCount, source.tileCapacity * viewCount];
  const validateGpuWaterMeshBudget = () => {
    if (
      !counts.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff) ||
      Math.max(
        sizes.totalBytes,
        candidateBytes,
        source.nodeCount * 16,
        paramsBytes,
        (source.bodies.length + 1) * viewCount * 48,
        viewCount * 256,
        sizes.argsBytes,
      ) > maxBinding
    )
      return err(
        failure('GPU Water tile and candidate storage within maxStorageBufferBindingSize', {
          zone: source.zone.guid,
          sizes,
          candidateBytes,
          maxBinding,
        }),
      );
    return undefined;
  };
  const budgetFailure = validateGpuWaterMeshBudget();
  if (budgetFailure !== undefined) return budgetFailure;
  const rasterWidth = source.width * saved.supersampling,
    rasterHeight = source.height * saved.supersampling;
  const validateGpuWaterMeshDispatch = () => {
    if (Math.max(rasterWidth, rasterHeight) > (context.limits?.maxTextureDimension2D ?? 8192))
      return err(failure('supersampled Water raster within maxTextureDimension2D'));
    if (
      Math.max(
        Math.ceil((source.nodeCount * viewCount) / 64),
        Math.ceil(source.width / 8),
        Math.ceil(source.height / 8),
        Math.ceil(rows / 64),
        Math.ceil(viewCount / 64),
      ) > maxWorkgroups
    )
      return err(
        failure('GPU Water dispatch dimensions within maxComputeWorkgroupsPerDimension', {
          maxWorkgroups,
        }),
      );
    return undefined;
  };
  const dispatchFailure = validateGpuWaterMeshDispatch();
  if (dispatchFailure !== undefined) return dispatchFailure;
  // Seven fixed vec4s precede the complete, variable-length mip descriptor tail.
  const params = new Uint32Array(paramsBytes / 4),
    floats = new Float32Array(params.buffer);
  params.set([source.width, source.height, source.nodeCount, source.bodies.length + 1], 0);
  params.set([source.materials.length, viewCount, source.quadsPerDraw, source.tileCapacity], 4);
  floats.set([0, 0, ...source.extentXZ], 8);
  floats.set(
    [source.yMin, source.yMax, source.zone.asset.lodScale * source.zone.asset.tileSizeM, 0],
    12,
  );
  params.set([saved.supersampling, saved.msaaSamples, 0xffffffff, source.mipOffsets.length], 16);
  params.set([source.quadsLod0, source.densityCount, 0, 0], 20);
  floats.set(source.originXZ, 24);
  for (let mip = 0; mip < source.mipOffsets.length; mip++)
    params.set(
      [
        requireWaterValue(source.mipOffsets[mip]),
        requireWaterValue(source.mipWidths[mip]),
        requireWaterValue(source.mipHeights[mip]),
        0,
      ],
      (7 + mip) * 4,
    );
  const bodyData = new Uint32Array((source.bodies.length + 1) * viewCount * 12),
    bodyFloats = new Float32Array(bodyData.buffer);
  const viewData = new Float32Array(viewCount * 64);
  const captureGpuMeshViewInputs = () => {
    for (let viewIndex = 0; viewIndex < viewCount; viewIndex++) {
      const { view, publication } = requireWaterValue(frame.views[viewIndex]);
      const selected = requireWaterValue(view.selectedView);
      const vp = new Float32Array(selected.viewProjection);
      for (let row = 0; row < 4; row++)
        vp[12 + row] =
          requireWaterValue(selected.viewProjection[12 + row]) +
          requireWaterValue(selected.viewProjection[row]) * source.originXZ[0] +
          requireWaterValue(selected.viewProjection[8 + row]) * source.originXZ[1];
      const base = viewIndex * 64;
      const observer = requireWaterValue(requireWaterValue(view.frame).view).cameraPosition;
      viewData.set(
        [observer[0] - source.originXZ[0], observer[1], observer[2] - source.originXZ[1], 1],
        base,
      );
      viewData.set(vp, base + 4);
      const planes = [
        [
          requireWaterValue(vp[3]) + requireWaterValue(vp[0]),
          requireWaterValue(vp[7]) + requireWaterValue(vp[4]),
          requireWaterValue(vp[11]) + requireWaterValue(vp[8]),
          requireWaterValue(vp[15]) + requireWaterValue(vp[12]),
        ],
        [
          requireWaterValue(vp[3]) - requireWaterValue(vp[0]),
          requireWaterValue(vp[7]) - requireWaterValue(vp[4]),
          requireWaterValue(vp[11]) - requireWaterValue(vp[8]),
          requireWaterValue(vp[15]) - requireWaterValue(vp[12]),
        ],
        [
          requireWaterValue(vp[3]) + requireWaterValue(vp[1]),
          requireWaterValue(vp[7]) + requireWaterValue(vp[5]),
          requireWaterValue(vp[11]) + requireWaterValue(vp[9]),
          requireWaterValue(vp[15]) + requireWaterValue(vp[13]),
        ],
        [
          requireWaterValue(vp[3]) - requireWaterValue(vp[1]),
          requireWaterValue(vp[7]) - requireWaterValue(vp[5]),
          requireWaterValue(vp[11]) - requireWaterValue(vp[9]),
          requireWaterValue(vp[15]) - requireWaterValue(vp[13]),
        ],
        [
          requireWaterValue(vp[2]),
          requireWaterValue(vp[6]),
          requireWaterValue(vp[10]),
          requireWaterValue(vp[14]),
        ],
        [
          requireWaterValue(vp[3]) - requireWaterValue(vp[2]),
          requireWaterValue(vp[7]) - requireWaterValue(vp[6]),
          requireWaterValue(vp[11]) - requireWaterValue(vp[10]),
          requireWaterValue(vp[15]) - requireWaterValue(vp[14]),
        ],
      ];
      planes.forEach((plane, index) => {
        viewData.set(plane, base + 20 + index * 4);
      });
      const inverse = mat4.create();
      mat4.invert(inverse, vp as never);
      viewData.set(inverse, base + 44);
      for (const body of source.bodies) {
        const key = waterBodyOwnerKey(
          frame.worldIdentity,
          body.guid,
          body.generation,
          source.zone.generation,
        );
        const index = publication.waveUploadPlan.bodyIndices.get(key);
        const row = index === undefined ? undefined : publication.waveUploadPlan.bodyData[index];
        if (row === undefined || row.bodyGeneration !== body.generation)
          return err(
            failure('the exact same-frame WaveParam row for every GPU raster body', {
              key,
              view: view.identity,
            }),
          );
        const offset = (viewIndex * (source.bodies.length + 1) + body.rasterIndex) * 12;
        bodyData.set(
          [
            requireWaterValue(index),
            body.materialBucket,
            body.lakeTransitionBucket + 1,
            body.oceanTransitionBucket + 1,
          ],
          offset,
        );
        bodyFloats.set(
          [
            body.surfaceY,
            body.yMin,
            body.yMax,
            body.type === 'lake' ? 1 : body.type === 'ocean' ? 2 : 0,
          ],
          offset + 4,
        );
        bodyFloats.set(
          [
            source.originXZ[0] - row.tileOriginHighXZ[0] - row.tileOriginLowXZ[0],
            source.originXZ[1] - row.tileOriginHighXZ[1] - row.tileOriginLowXZ[1],
            0,
            body.flatFarBoundaryMask,
          ],
          offset + 8,
        );
      }
    }
    return undefined;
  };
  const viewFailure = captureGpuMeshViewInputs();
  if (viewFailure !== undefined) return viewFailure;
  const buffer = (kind: string, size: number, data?: ArrayBufferView, indirect = false) =>
    resources.push({
      kind: 'buffer',
      name: name(kind),
      ...(kind === 'nodes' ? { allocationKey: frame.staticDigest } : {}),
      size: Math.max(4, size),
      usage: indirect ? ['storage', 'indirect', 'copy-src'] : ['storage', 'copy-src'],
      ...(data === undefined ? {} : { data }),
    });
  buffer('params', params.byteLength, params);
  buffer('bodies', bodyData.byteLength, bodyData);
  buffer('views', viewData.byteLength, viewData);
  buffer('nodes', source.nodeCount * 16);
  buffer('candidates', candidateBytes);
  buffer('visibility', source.nodeCount * viewCount * 4);
  const addCompute = (
    kind: string,
    wgsl: string,
    entries: readonly BindGroupLayoutEntry[],
    bindings: readonly string[],
    entry: string,
    workgroups: readonly [number, number?, number?],
  ) => {
    const program = name(`${kind}-program`),
      binding = name(`${kind}-bindings`);
    resources.push(compute(program, wgsl, entries, [entry]), {
      kind: 'compute-bindings',
      name: binding,
      program,
      entries: bindings.map((resource, index) => ({ binding: index, resource: name(resource) })),
    });
    passes.push({
      kind: 'compute',
      name: name(kind),
      program,
      bindings: binding,
      dispatches: [{ kind: 'direct', entryPoint: entry, workgroups }],
    });
  };
  const addRebuiltGpuRaster = () => {
    if (frame.rebuild) {
      const msaa = saved.msaaSamples === 4;
      for (const kind of ['raster-body', 'raster-height'])
        resources.push(
          {
            kind: 'graph-texture',
            name: name(kind),
            allocationKey: name(kind),
            descriptor: {
              format: 'rgb10a2unorm',
              size: { width: rasterWidth, height: rasterHeight, depthOrArrayLayers: 1 },
              sampleCount: saved.msaaSamples,
              dimension: '2d',
              usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            },
          },
          {
            kind: 'prepared-gpu-resource',
            name: name(`${kind}-view`),
            logicalTarget: name(kind),
            resource: { kind: 'texture-view', value: undefined },
          },
        );
      const captureGpuRasterVertices = () => {
        const vertices: number[] = [];
        const jitter = [
          [-0.375, -0.125],
          [0.125, -0.375],
          [-0.125, 0.375],
          [0.375, 0.125],
        ] as const;
        for (const body of source.bodies) {
          const packed = (body.rasterIndex | (body.prioritySlot << 7)) / 1023;
          for (const offset of jitter)
            for (let i = 0; i < body.vertices.length; i += 3) {
              const low =
                body.type === 'river'
                  ? requireWaterValue(body.vertices[i + 1]) - body.maxWaveHeightM
                  : body.yMin;
              const high =
                body.type === 'river'
                  ? requireWaterValue(body.vertices[i + 1]) + body.maxWaveHeightM
                  : body.yMax;
              vertices.push(
                (requireWaterValue(body.vertices[i]) / source.extentXZ[0]) * 2 -
                  1 +
                  (offset[0] * 3) / rasterWidth,
                1 -
                  (requireWaterValue(body.vertices[i + 2]) / source.extentXZ[1]) * 2 +
                  (offset[1] * 3) / rasterHeight,
                1 - (low - source.yMin) / (source.yMax - source.yMin),
                body.type === 'river' ? 0 : packed,
                body.type === 'river' ? packed : 0,
                (high - source.yMin) / (source.yMax - source.yMin),
              );
            }
        }
        return vertices;
      };
      const vertices = captureGpuRasterVertices();
      resources.push(
        {
          kind: 'vertex-data',
          name: name('vertices'),
          layout: 'water-info-position-flow',
          data: new Float32Array(vertices),
        },
        {
          kind: 'graphics-program',
          name: name('raster-program'),
          program: {
            shader: 'forgeax::water-mesh-raster',
            preparePipelines: true,
            vertexLayout: 'water-info-position-flow',
            colorFormats: ['rgb10a2unorm', 'rgb10a2unorm'],
            sampleCount: saved.msaaSamples,
            topology: 'triangle-list',
            renderState: {
              cullMode: 'none',
              depthWriteEnabled: false,
              blend: {
                color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
                alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
              },
            },
          },
        },
        {
          kind: 'graphics-bindings',
          name: name('raster-bindings'),
          program: name('raster-program'),
          values: {},
        },
      );
      passes.push({
        kind: 'raster',
        name: name('raster'),
        colorAttachments: ['raster-body', 'raster-height'].map((kind) => ({
          target: name(kind),
          loadOp: 'clear',
          storeOp: 'store',
        })),
        draws: [
          {
            program: name('raster-program'),
            bindings: [name('raster-bindings')],
            vertexData: [{ slot: 0, resource: name('vertices') }],
            draw: { kind: 'draw', vertexCount: vertices.length / 6, instanceCount: 1 },
          },
        ],
      });
      addCompute(
        'merge',
        waterGpuMergeWgsl(msaa),
        [
          storage(0),
          {
            binding: 1,
            visibility: 4,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: msaa },
          },
          {
            binding: 2,
            visibility: 4,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: msaa },
          },
          storage(3),
          storage(4, false),
        ],
        ['params', 'raster-body-view', 'raster-height-view', 'bodies', 'nodes'],
        'merge',
        [Math.ceil(source.width / 8), Math.ceil(source.height / 8)],
      );
      for (let mip = 1; mip < source.mipOffsets.length; mip++)
        addCompute(
          `mip-${mip}`,
          waterGpuMipWgsl(mip),
          [storage(0), storage(1, false)],
          ['params', 'nodes'],
          'mip',
          [
            Math.ceil(requireWaterValue(source.mipWidths[mip]) / 8),
            Math.ceil(requireWaterValue(source.mipHeights[mip]) / 8),
          ],
        );
    }
  };
  addRebuiltGpuRaster();
  const groups = Math.ceil((source.nodeCount * viewCount) / 64);
  resources.push(
    compute(
      name('traverse-program'),
      waterGpuTraverseWgsl(),
      [storage(0), storage(1), storage(2), storage(3, false), storage(4, false)],
      ['viewLod', 'traverse'],
    ),
    {
      kind: 'compute-bindings',
      name: name('traverse-bindings'),
      program: name('traverse-program'),
      entries: ['params', 'bodies', 'nodes', 'views', 'candidates'].map((resource, binding) => ({
        binding,
        resource: name(resource),
      })),
    },
  );
  passes.push({
    kind: 'compute',
    name: name('traverse'),
    program: name('traverse-program'),
    bindings: name('traverse-bindings'),
    dispatches: [
      { kind: 'direct', entryPoint: 'viewLod', workgroups: [Math.ceil(viewCount / 64)] },
      { kind: 'direct', entryPoint: 'traverse', workgroups: [groups] },
    ],
  });
  const work: RenderFeatureWork[] = [{ scope: 'frame', placement: 'scene', resources, passes }];
  for (let viewIndex = 0; viewIndex < viewCount; viewIndex++) {
    const view = requireWaterValue(frame.views[viewIndex]).view;
    resources = [];
    passes = [];
    const viewParams = params.slice();
    viewParams[5] = 1;
    viewParams[22] = viewIndex;
    buffer('view-params', viewParams.byteLength, viewParams);
    buffer('counts', rows * 4);
    buffer('offsets', rows * 4);
    buffer('blocks', Math.ceil(rows / 256) * 4);
    buffer('tiles', sizes.totalBytes);
    buffer('args', sizes.argsBytes, undefined, true);
    const addGpuMeshViewOcclusion = () => {
      if (saved.occlusion !== 'disabled') {
        const logicalDepth = context.views
          .find((candidate) => candidate.identity === view.identity)
          ?.targets.find((target) => target.name === 'opaque-depth');
        if (logicalDepth?.kind !== 'depth')
          return err(failure('the selected Standard view exposes its main opaque depth'));
        const depthTarget = logicalDepth;
        const depthMsaa = depthTarget.sampleCount === 4;
        const width = 2 ** Math.ceil(Math.log2(Math.max(1, view.frameSize?.width ?? 1)));
        const height = 2 ** Math.ceil(Math.log2(Math.max(1, view.frameSize?.height ?? 1)));
        if (
          ![width, height].every(
            (dimension) =>
              Number.isSafeInteger(dimension) && dimension > 0 && dimension <= 0xffffffff,
          )
        )
          return err(failure('positive finite u32 Water HZB dimensions'));
        const descriptors: { offset: number; width: number; height: number }[] = [];
        let nodeCount = 0;
        for (let w = width, h = height; ; w = Math.max(1, w / 2), h = Math.max(1, h / 2)) {
          descriptors.push({ offset: nodeCount, width: w, height: h });
          nodeCount += w * h;
          if (w === 1 && h === 1) break;
        }
        if (
          !Number.isSafeInteger(nodeCount) ||
          nodeCount > 0xffffffff ||
          nodeCount * 4 > maxBinding ||
          Math.max(Math.ceil(width / 8), Math.ceil(height / 8)) > maxWorkgroups
        )
          return err(failure('the selected-view Water HZB fits storage and dispatch limits'));
        const occlusion = new Uint32Array((1 + descriptors.length) * 4);
        occlusion.set([
          viewIndex,
          saved.occlusion === 'hzb' ? 1 : saved.occlusion === 'precise' ? 2 : 3,
          descriptors.length,
          0,
        ]);
        descriptors.forEach((descriptor, mip) => {
          occlusion.set([descriptor.offset, descriptor.width, descriptor.height, 0], (mip + 1) * 4);
        });
        const suffix = `occlusion-${viewIndex}`;
        buffer(`${suffix}-params`, occlusion.byteLength, occlusion);
        buffer(`${suffix}-hzb`, nodeCount * 4);
        resources.push({
          kind: 'prepared-gpu-resource',
          name: name(`${suffix}-depth`),
          logicalTarget: logicalDepth.name,
          resource: { kind: 'texture-view', value: undefined },
        });
        const program = name(`${suffix}-program`),
          binding = name(`${suffix}-bindings`);
        resources.push(
          compute(
            program,
            waterGpuOcclusionWgsl(descriptors.length, depthMsaa),
            [
              storage(0),
              storage(1),
              storage(2),
              storage(3, false),
              {
                binding: 4,
                visibility: 4,
                texture: { sampleType: 'depth', viewDimension: '2d', multisampled: depthMsaa },
              },
              storage(5, false),
              storage(6),
              storage(7, false),
            ],
            [
              'depthBase',
              ...descriptors.slice(1).map((_, index) => `depthMip${index + 1}`),
              'occlude',
              'applyVisibility',
            ],
          ),
          {
            kind: 'compute-bindings',
            name: binding,
            program,
            entries: [
              'params',
              'nodes',
              'views',
              'candidates',
              `${suffix}-depth`,
              `${suffix}-hzb`,
              `${suffix}-params`,
              'visibility',
            ].map((resource, index) => ({ binding: index, resource: name(resource) })),
          },
        );
        if (saved.occlusion !== 'precise') {
          passes.push({
            kind: 'compute',
            name: name(`${suffix}-base`),
            program,
            bindings: binding,
            dispatches: [
              {
                kind: 'direct',
                entryPoint: 'depthBase',
                workgroups: [Math.ceil(width / 8), Math.ceil(height / 8)],
              },
            ],
          });
          descriptors.slice(1).forEach((descriptor, mip) => {
            passes.push({
              kind: 'compute',
              name: name(`${suffix}-mip-${mip + 1}`),
              program,
              bindings: binding,
              dispatches: [
                {
                  kind: 'direct',
                  entryPoint: `depthMip${mip + 1}`,
                  workgroups: [Math.ceil(descriptor.width / 8), Math.ceil(descriptor.height / 8)],
                },
              ],
            });
          });
        }
        passes.push({
          kind: 'compute',
          name: name(`${suffix}-visibility`),
          program,
          bindings: binding,
          dispatches: [
            {
              kind: 'direct',
              entryPoint: 'occlude',
              workgroups: [Math.ceil(source.nodeCount / 64)],
            },
          ],
        });
        if (saved.occlusion !== 'hzb') {
          const cubeIndices = [
            0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6,
            2, 1, 3, 7, 1, 7, 5,
          ];
          const cube = new Float32Array(
            cubeIndices.flatMap((index) => [
              (index >> 2) & 1,
              (index >> 1) & 1,
              index & 1,
              0,
              0,
              0,
            ]),
          );
          const precise = name(`${suffix}-precise-program`),
            bindings = name(`${suffix}-precise-bindings`);
          buffer(`${suffix}-precise-args`, 16, new Uint32Array([36, source.nodeCount, 0, 0]), true);
          resources.push(
            {
              kind: 'vertex-data',
              name: name(`${suffix}-cube`),
              layout: 'water-info-position-flow',
              data: cube,
            },
            {
              kind: 'graphics-program',
              name: precise,
              program: {
                shader: depthMsaa
                  ? 'forgeax::water-mesh-precise-msaa'
                  : 'forgeax::water-mesh-precise',
                preparePipelines: true,
                vertexLayout: 'water-info-position-flow',
                colorFormats: [],
                depthFormat: depthTarget.format,
                sampleCount: depthTarget.sampleCount,
                topology: 'triangle-list',
                renderState: {
                  cullMode: 'back',
                  frontFace: 'cw',
                  depthCompare: 'less-equal',
                  depthWriteEnabled: false,
                },
              },
            },
            {
              kind: 'graphics-bindings',
              name: bindings,
              program: precise,
              logicalTargets: { sceneDepth: logicalDepth.name },
              values: {
                group: 0,
                sceneDepthBinding: 6,
                bufferBindings: [
                  'params',
                  'nodes',
                  'views',
                  'candidates',
                  'visibility',
                  `${suffix}-params`,
                ].map((resource, binding) => ({
                  binding,
                  resource: name(resource),
                  access: binding === 4 ? 'read-write' : 'read',
                })),
              },
            },
          );
          passes.push({
            kind: 'raster',
            name: name(`${suffix}-precise`),
            colorAttachments: [],
            depthStencilAttachment: {
              target: logicalDepth.name,
              depthLoadOp: 'load',
              depthStoreOp: 'store',
            },
            sampledTargets: [logicalDepth.name],
            draws: [
              {
                program: precise,
                bindings: [bindings],
                vertexData: [{ slot: 0, resource: name(`${suffix}-cube`) }],
                draw: { kind: 'draw-indirect', resource: name(`${suffix}-precise-args`) },
              },
            ],
          });
          passes.push({
            kind: 'compute',
            name: name(`${suffix}-apply`),
            program,
            bindings: binding,
            dispatches: [
              {
                kind: 'direct',
                entryPoint: 'applyVisibility',
                workgroups: [Math.ceil(source.nodeCount / 64)],
              },
            ],
          });
        }
      }
      addCompute(
        'reset',
        waterGpuCountWgsl(),
        [storage(0), storage(1), storage(2, false)],
        ['view-params', 'candidates', 'counts'],
        'reset',
        [Math.ceil(rows / 64)],
      );
      return undefined;
    };
    const occlusionFailure = addGpuMeshViewOcclusion();
    if (occlusionFailure !== undefined) return occlusionFailure;
    addCompute(
      'count',
      waterGpuCountWgsl(),
      [storage(0), storage(1), storage(2, false)],
      ['view-params', 'candidates', 'counts'],
      'count',
      [Math.ceil(source.nodeCount / 64)],
    );
    const prefixProgram = name('prefix-program'),
      prefixBindings = name('prefix-bindings');
    resources.push(
      compute(
        prefixProgram,
        waterGpuPrefixWgsl(),
        [
          storage(0),
          storage(1),
          storage(2, false),
          storage(3, false),
          storage(4, false),
          storage(5, false),
        ],
        ['prefixLocal', 'prefixBlocks', 'prefixFinalize'],
      ),
      {
        kind: 'compute-bindings',
        name: prefixBindings,
        program: prefixProgram,
        entries: ['view-params', 'counts', 'offsets', 'blocks', 'tiles', 'args'].map(
          (resource, binding) => ({ binding, resource: name(resource) }),
        ),
      },
    );
    passes.push({
      kind: 'compute',
      name: name('prefix'),
      program: prefixProgram,
      bindings: prefixBindings,
      dispatches: [
        { kind: 'direct', entryPoint: 'prefixLocal', workgroups: [Math.ceil(rows / 256)] },
        { kind: 'direct', entryPoint: 'prefixBlocks', workgroups: [1] },
        { kind: 'direct', entryPoint: 'prefixFinalize', workgroups: [Math.ceil(rows / 64)] },
      ],
    });
    addCompute(
      'scatter',
      waterGpuScatterWgsl(),
      [
        storage(0),
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        storage(5),
        storage(6, false),
        storage(7, false),
      ],
      ['view-params', 'bodies', 'nodes', 'views', 'candidates', 'offsets', 'tiles', 'args'],
      'scatter',
      [Math.ceil(source.nodeCount / 64)],
    );
    work.push({ scope: { view: view.identity }, placement: 'after-depth', resources, passes });
  }
  return ok(work);
}

export function createWaterGpuMeshFeature(waterInfo: object): RenderFeature<GpuMeshFrame> {
  const inactiveSourceData: GpuMeshFrame = Object.freeze({
    zones: Object.freeze([]),
    inspection: Object.freeze([]),
  });
  const committed = new Map<string, Readonly<{ digest: string; device: number }>>();
  const activeFrames = new WeakSet<GpuMeshFrame>();
  const plannedFrames = new WeakMap<GpuMeshFrame, GpuMeshFrame>();
  return {
    identity: WATER_GPU_MESH_FEATURE,
    inactiveSourceData,
    placement: 'scene',
    shaderModuleMode: 'immediate',
    requiredCapabilities: ['compute', 'storageBuffer', 'indirectDrawing'],
    extract(context) {
      const zones: ZoneFrame[] = [];
      for (const view of context.views) {
        if (!view.render || !view.selectedView || !view.frame?.view) continue;
        const publication = waterInfoFramePublicationForRenderer(
          waterInfo,
          view.identity,
          context.frameNumber,
          view.frame.view.deviceGeneration,
        );
        if (publication?.frameGeneration !== context.frameNumber) continue;
        for (const source of publication.gpuMeshes ?? []) {
          const digest = staticDigest(source),
            previous = committed.get(source.key);
          zones.push({
            source,
            staticDigest: digest,
            rebuild:
              previous?.digest !== digest || previous.device !== view.frame.view.deviceGeneration,
            worldIdentity: source.worldIdentity,
            views: [{ view, publication }],
          });
        }
      }
      if (
        zones.length === 0 &&
        !context.world.hasResource(WATER_SYSTEM_RESOURCE) &&
        !context.views.some((view) => view.frame?.view !== undefined)
      )
        return ok(inactiveSourceData);
      const frame: GpuMeshFrame = {
        zones,
        sourceViews: context.views.filter((view) => view.render).map((view) => view.identity),
        inspection: zones.map(({ source, views }) => ({
          zone: source.zone.guid,
          resolution: [source.width, source.height],
          bodies: source.bodies.length,
          materials: source.materials,
          views: views.map(({ view }) => view.identity),
          tileCapacity: source.tileCapacity,
          path: 'gpu-raster-mips-traverse-prefix-scatter-indirect',
        })),
      };
      activeFrames.add(frame);
      return ok(frame);
    },
    requiresPreparation: (data) => data.zones.length !== 0,
    plan(data, context) {
      const sourceData = data;
      const captureSourceViewZones = () => {
        if (data.zones.length === 0 && data.sourceViews !== undefined) {
          const zones: ZoneFrame[] = [];
          for (const view of context.views) {
            if (!view.render || !view.selectedView || !data.sourceViews.includes(view.identity))
              continue;
            const deviceGeneration = view.sceneData.deviceGeneration;
            const publication = waterInfoFramePublicationForRenderer(
              waterInfo,
              view.identity,
              context.frame.frameNumber,
              deviceGeneration,
            );
            if (publication?.frameGeneration !== context.frame.frameNumber) continue;
            for (const source of publication.gpuMeshes ?? []) {
              const digest = staticDigest(source);
              const previous = committed.get(source.key);
              zones.push({
                source,
                worldIdentity: source.worldIdentity,
                staticDigest: digest,
                rebuild: previous?.digest !== digest || previous.device !== deviceGeneration,
                views: [
                  {
                    publication,
                    view: {
                      identity: view.identity,
                      render: true,
                      selectedView: view.selectedView,
                      frame: {
                        view: {
                          identity: view.identity,
                          width: view.frame.width ?? 1,
                          height: view.frame.height ?? 1,
                          cameraRevision: 0,
                          deviceGeneration,
                          cameraPosition: [
                            view.selectedView.position[0] ?? 0,
                            view.selectedView.position[1] ?? 0,
                            view.selectedView.position[2] ?? 0,
                          ],
                        },
                      },
                    },
                  },
                ],
              });
            }
          }
          data = { zones, inspection: data.inspection };
        }
      };
      captureSourceViewZones();
      plannedFrames.set(sourceData, data);
      activeFrames.add(sourceData);
      let pendingSource: RenderFeaturePlan['pendingSource'];
      for (const zone of data.zones)
        for (const { publication, view } of zone.views) {
          if (
            publication.frameGeneration !== context.frame.frameNumber ||
            publication.deviceGeneration !== view.frame?.view?.deviceGeneration
          )
            return err(
              failure('the exact current frame and device WaterInfo publication', {
                frame: context.frame.frameNumber,
                publicationFrame: publication.frameGeneration,
                device: publication.deviceGeneration,
              }),
            );
          const readiness = waterGpuMeshPublicationReadiness(zone.source, publication);
          if (!readiness.ok) return readiness;
          pendingSource ??= readiness.value;
        }
      if (pendingSource !== undefined) return ok({ pendingSource, work: [] as const });
      const buildGpuMeshWork = () => {
        const work: RenderFeatureWork[] = [];
        for (const zone of data.zones) {
          const built = makeWork(zone, context);
          if (!built.ok) return built;
          work.push(...built.value);
        }
        const scopes = new Map<string, RenderFeatureWork[]>();
        for (const row of work) {
          const key = row.scope === 'frame' ? 'frame' : row.scope.view;
          const rows = scopes.get(key);
          if (rows) rows.push(row);
          else scopes.set(key, [row]);
        }
        return ok({
          work: [...scopes.values()].map((rows) => ({
            scope: requireWaterValue(rows[0]).scope,
            placement: requireWaterValue(requireWaterValue(rows[0]).placement),
            resources: rows.flatMap((row) => row.resources),
            passes: rows.flatMap((row) => row.passes),
          })),
        });
      };
      return buildGpuMeshWork();
    },
    onFrameSubmitted(data, submission) {
      if (!activeFrames.has(data)) return;
      const sourceData = data;
      data = plannedFrames.get(data) ?? data;
      plannedFrames.delete(sourceData);
      const live = new Set(data.zones.map(({ source }) => source.key));
      for (const key of committed.keys()) if (!live.has(key)) committed.delete(key);
      for (const zone of data.zones) {
        if (!zone.rebuild) continue;
        const submitted = new Map(
          submission?.works.flatMap((work) =>
            work.passes.map((pass) => [pass.name, pass] as const),
          ) ?? [],
        );
        const name = (kind: string) => waterGpuMeshResource(zone.source.key, kind);
        if (
          !submitted.get(name('raster'))?.graphics?.draws.length ||
          !submittedComputeCount(submitted.get(name('merge'))) ||
          zone.source.mipOffsets
            .slice(1)
            .some((_, index) => !submittedComputeCount(submitted.get(name(`mip-${index + 1}`))))
        )
          continue;
        committed.set(zone.source.key, {
          digest: zone.staticDigest,
          device: requireWaterValue(
            requireWaterValue(requireWaterValue(zone.views[0]).view.frame).view,
          ).deviceGeneration,
        });
      }
    },
    onFrameAborted(data) {
      activeFrames.delete(data);
      plannedFrames.delete(data);
    },
  };
}
