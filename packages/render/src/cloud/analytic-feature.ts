import { err, ok } from '@forgeax/engine-types';
import { CloudLayerCapabilityMissingError, CloudLayerResourceFailureError } from '../errors/cloud';
import type {
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../features/plan';
import type { RenderFeature } from '../features/types';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';
import { CLOUD_LAYER_FEATURE_IDENTITY, CLOUD_REFERENCE_TEXTURE_ROLES } from './contracts';
import type {
  ExtractedAnalyticCloudLayer,
  ExtractedCookedCloudLayer,
  ExtractedProgramCloudLayer,
  ExtractedSampledCloudLayer,
} from './extract';
import { CLOUD_ATMOSPHERE_TARGETS } from './lighting/environment';
import { cloudShadowFilterWork } from './shadow-filter';
import { CLOUD_SAMPLED_MAX_STEPS, cookedCloudViewSampleBudget } from './tracing/policy';

export const ANALYTIC_CLOUD_PASS = SkyPass.cloudAnalyticTrace;
export const SAMPLED_CLOUD_PASS = SkyPass.cloudSampledTrace;
export const ANALYTIC_CLOUD_LT = 'cloud-analytic-radiance-transmittance';
export const ANALYTIC_CLOUD_DEPTH = 'cloud-analytic-depth-meters';
const SHADER_ID = 'forgeax::cloud-analytic-view';

function encode(layer: ExtractedAnalyticCloudLayer): Uint8Array {
  return new Uint8Array(
    new Float32Array([
      layer.bottomMeters,
      layer.thicknessMeters,
      layer.entryLimitMeters,
      layer.traceLimitMeters,
      ...layer.sample.albedo,
      layer.sample.extinctionPerMeter,
      ...layer.sample.emissivePerMeter,
      layer.sample.materialAO,
      0,
      0,
      0,
      0,
    ]).buffer,
  );
}

function encodeSampledShadowMap(map: ExtractedSampledCloudLayer['shadowMap']): number[] {
  return [
    ...(map?.origin ?? [0, 0, 0]),
    map?.extentMeters ?? 1,
    ...(map?.right ?? [1, 0, 0]),
    map?.depthMeters ?? 1,
    ...(map?.up ?? [0, 0, 1]),
    map?.biasMeters ?? 0,
    ...(map?.directionToLight ?? [0, 1, 0]),
    map?.strength ?? 1,
    map?.mode ?? 0,
    Number(map?.cast ?? false),
    map?.mapSamples ?? 64,
    map?.surfaceStrength ?? 1,
  ];
}

export function encodeSampled(layer: ExtractedSampledCloudLayer): Uint8Array {
  return new Uint8Array(
    new Float32Array([
      layer.bottomMeters,
      layer.thicknessMeters,
      layer.entryLimitMeters,
      layer.traceLimitMeters,
      layer.layoutScaleMeters,
      layer.coverageBias,
      layer.extinctionPerMeter,
      Number(layer.skipEmpty),
      ...layer.albedo,
      ...layer.weights.slice(0, 4),
      ...layer.windOffsetMeters,
      layer.weights[4],
      ...layer.diagnostic,
      0,
      cookedCloudViewSampleBudget(layer.viewSampleCountScale),
      CLOUD_SAMPLED_MAX_STEPS,
      layer.stopTransmittance,
      0,
      ...(layer.lighting?.phase ?? [0.15, -0.2, 0]),
      0,
      ...(layer.lighting?.multipleScattering ?? [0.5, 0.5, 0.5, 2]),
      ...(layer.lighting?.shadow ?? [1, 10, 15000]),
      0,
      0,
      0,
      1,
      1,
      ...encodeSampledShadowMap(layer.shadowMap),
      ...(layer.lightEnvironment?.skyLuminance ?? [0, 0, 0]),
      Number(layer.lightEnvironment?.atmosphereAvailable ?? false),
      layer.lighting?.atmosphereTransmittanceMode ?? 0,
      Number(layer.lighting?.enableDistantSkyLightSampling ?? true),
      0,
      0,
      ...(layer.lightEnvironment?.groundSolarTransmittance ?? [1, 1, 1]),
      0,
    ]).buffer,
  );
}

type CookedCloudViews = Readonly<Record<string, ExtractedCookedCloudLayer>>;

export function encodeProgram(layer: ExtractedProgramCloudLayer): Uint8Array {
  const map = layer.shadowMap;
  const material = layer.materialParameters;
  const data = new Float32Array(60 + material.length);
  data.set([
    layer.bottomMeters,
    layer.thicknessMeters,
    layer.entryLimitMeters,
    layer.traceLimitMeters,
  ]);
  data.set([...layer.windOffsetMeters, 0], 4);
  data.set(
    [
      cookedCloudViewSampleBudget(layer.viewSampleCountScale),
      768,
      layer.stopTransmittance,
      layer.extinctionOverridePerMeter ?? -1,
    ],
    8,
  );
  data.set([...(layer.lighting?.phase ?? [0.15, -0.2, 0]), 0], 12);
  data.set(layer.lighting?.multipleScattering ?? [0.5, 0.5, 0.5, 2], 16);
  data.set([...(layer.lighting?.shadow ?? [1, 10, 15000]), 0], 20);
  if (map) {
    data.set([...map.origin, map.extentMeters], 24);
    data.set([...map.right.map((value) => value * map.extentMeters * 0.5), 0], 28);
    data.set([...map.up.map((value) => value * map.extentMeters * 0.5), 0], 32);
    data.set([...map.directionToLight.map((value) => -value), map.depthMeters], 36);
    data.set([map.mapSamples, map.strength, map.biasMeters, map.mode], 40);
  }
  data.set([0, 0, 1, 1], 44);
  data.set(
    [
      ...(layer.lightEnvironment?.skyLuminance ?? [0, 0, 0]),
      Number(layer.lightEnvironment?.atmosphereAvailable ?? false),
    ],
    48,
  );
  data.set(
    [
      layer.lighting?.atmosphereTransmittanceMode ?? 0,
      Number(layer.lighting?.enableDistantSkyLightSampling ?? true),
      0,
      0,
    ],
    52,
  );
  data.set([...(layer.lightEnvironment?.groundSolarTransmittance ?? [1, 1, 1]), 0], 56);
  data.set(material, 60);
  return new Uint8Array(data.buffer);
}

function cloudShadowWork(
  viewId: string,
  programName: string,
  shader: string,
  params: Uint8Array,
  sampled: ExtractedSampledCloudLayer | undefined,
): RenderFeatureWork {
  const shadowShader = `${programName}-shadow`;
  const shadowResources: RenderFeatureResourceDeclaration[] = [
    {
      kind: 'fullscreen-program',
      name: shadowShader,
      source: shader,
      usesView: true,
      fragmentEntryPoint: 'fs_shadow',
      reads: [
        'unused-color',
        { key: 'unused-depth', sampleType: 'depth' },
        ...(sampled?.textures ?? []).map(({ role, dimension }) =>
          dimension === '3d' ? { key: role, sampleType: 'float-3d-repeat' as const } : role,
        ),
      ],
      params: { byteSize: params.byteLength, defaultValue: params },
    },
    {
      kind: 'graphics-program',
      name: 'cloud-bsm-pipeline',
      program: {
        shader: shadowShader,
        vertexLayout: 'none',
        sampleCount: 1,
        colorFormats: ['rgba32float'],
        renderState: { depthWriteEnabled: false, depthCompare: 'always' },
      },
    },
    {
      kind: 'graphics-bindings',
      name: 'cloud-bsm-view',
      program: 'cloud-bsm-pipeline',
      values: { group: 0, view: true },
    },
    {
      kind: 'graphics-bindings',
      name: 'cloud-bsm-inputs',
      program: 'cloud-bsm-pipeline',
      values: {
        group: 1,
        fullscreen: true,
        shader: shadowShader,
        input: false,
        depthFallback: true,
        assetTextures: (sampled?.textures ?? []).map(({ handle, guid, revision, dimension }) => ({
          handle,
          guid,
          revision,
          dimension,
        })),
      },
    },
  ];
  return {
    scope: { view: viewId },
    resources: shadowResources,
    passes: [
      {
        kind: 'raster',
        name: SkyPass.cloudShadow,
        colorAttachments: [{ target: 'cloud-shadow-raw', loadOp: 'clear', storeOp: 'store' }],
        draws: [
          {
            program: 'cloud-bsm-pipeline',
            bindings: ['cloud-bsm-view', 'cloud-bsm-inputs'],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

function invalidCloudTraceLayer(
  layer: ExtractedCookedCloudLayer,
  sampled: ExtractedSampledCloudLayer | undefined,
  generation: number,
): CloudLayerResourceFailureError | undefined {
  if (
    layer.lightEnvironment?.skySource === 'unavailable-image' &&
    layer.lighting?.enableDistantSkyLightSampling !== false
  )
    return new CloudLayerResourceFailureError({
      stage: 'view',
      generation: generation,
      cause:
        'Image Skylight spherical-average source is unavailable to the cloud consumer; publish the actual SH projection or disable distant sky sampling.',
    });
  if (
    sampled !== undefined &&
    (sampled.textures.length !== CLOUD_REFERENCE_TEXTURE_ROLES.length ||
      sampled.textures.some(
        ({ role, dimension }, index) =>
          CLOUD_REFERENCE_TEXTURE_ROLES[index]?.[0] !== role ||
          CLOUD_REFERENCE_TEXTURE_ROLES[index]?.[1] !== dimension,
      ))
  ) {
    return new CloudLayerResourceFailureError({
      stage: 'view',
      generation: generation,
      cause: 'The sampled frame must publish its exact four cooked texture roles.',
    });
  }
  return undefined;
}

function cloudTraceProgram(
  sampled: ExtractedSampledCloudLayer | undefined,
  custom: ExtractedProgramCloudLayer | undefined,
) {
  const identifier =
    custom !== undefined
      ? `cloud-program-${custom.programIdentity}`
      : sampled === undefined
        ? SHADER_ID
        : `forgeax::cloud-sampled-view-${sampled.kernelIdentity}-${sampled.useDetail ? 1 : 0}`;
  const passName =
    sampled === undefined && custom === undefined ? ANALYTIC_CLOUD_PASS : SAMPLED_CLOUD_PASS;
  const programName =
    custom !== undefined
      ? // Keep the entire digest, but omit the prefix's colon in plan-local names.
        `cloud-program-trace-${custom.programIdentity.replace(/^sha256:/, '')}`
      : sampled === undefined
        ? ANALYTIC_CLOUD_PASS
        : `${SAMPLED_CLOUD_PASS}-${sampled.kernelIdentity.slice(0, 12)}-${sampled.useDetail ? 1 : 0}-${sampled.programIdentity.slice(7, 19)}`;
  return { identifier, passName, programName };
}

function cloudTraceWork(
  viewId: string,
  outputFormat: 'rgba16float' | 'rgba32float',
  passName: string,
  programName: string,
  shader: string,
  params: Uint8Array,
  sampled: ExtractedSampledCloudLayer | undefined,
  materialLayer: ExtractedSampledCloudLayer | ExtractedProgramCloudLayer | undefined,
  cloudShadowTarget: 'cloud-shadow' | false,
  activeAtmosphere: boolean,
): RenderFeatureWork {
  const atmosphereNames = Object.values(CLOUD_ATMOSPHERE_TARGETS);
  const atmosphereReads = activeAtmosphere
    ? [...atmosphereNames]
    : ['unused-atmosphere-transmittance', 'unused-atmosphere-distant-sky'];
  const atmosphereBindings = activeAtmosphere ? [...atmosphereNames] : [false, false];
  return {
    scope: { view: viewId },
    resources: [
      {
        kind: 'fullscreen-program',
        name: programName,
        source: shader,
        usesView: true,
        reads: [
          'motion-input',
          { key: 'depth', sampleType: 'depth' },
          ...(sampled === undefined
            ? []
            : sampled.textures.map(({ role, dimension }) =>
                dimension === '3d' ? { key: role, sampleType: 'float-3d-repeat' as const } : role,
              )),
          ...(materialLayer === undefined
            ? []
            : [
                {
                  key: cloudShadowTarget === false ? 'unused-cloud-shadow' : cloudShadowTarget,
                  sampleType: 'unfilterable-float' as const,
                },
              ]),
          ...(materialLayer === undefined ? [] : atmosphereReads),
        ],
        params: { byteSize: params.byteLength, defaultValue: params },
      },
      {
        kind: 'graphics-program',
        name: 'analytic-cloud-pipeline',
        program: {
          shader: programName,
          vertexLayout: 'none',
          sampleCount: 1,
          colorFormats: [outputFormat, 'rgba16float', 'rgba32float'],
          renderState: { depthWriteEnabled: false, depthCompare: 'always' },
        },
      },
      {
        kind: 'graphics-bindings',
        name: 'analytic-cloud-view',
        program: 'analytic-cloud-pipeline',
        values: { group: 0, view: true },
      },
      {
        kind: 'graphics-bindings',
        name: 'analytic-cloud-inputs',
        program: 'analytic-cloud-pipeline',
        values: {
          group: 1,
          fullscreen: true,
          shader: programName,
          input: 'motion-input',
          depth: 'depth',
          ...(materialLayer === undefined
            ? {}
            : { additionalTextures: [cloudShadowTarget, ...atmosphereBindings] }),
          ...(sampled === undefined
            ? {}
            : {
                assetTextures: sampled.textures.map(({ handle, guid, revision, dimension }) => ({
                  handle,
                  guid,
                  revision,
                  dimension,
                })),
              }),
        },
        logicalTargets: { input: 'motion-input' },
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: passName,
        colorAttachments: ['motion-output', ANALYTIC_CLOUD_LT, ANALYTIC_CLOUD_DEPTH].map(
          (target) => ({ target, loadOp: 'clear' as const, storeOp: 'store' as const }),
        ),
        sampledTargets: [
          'motion-input',
          'depth',
          ...(cloudShadowTarget === false ? [] : [cloudShadowTarget]),
          ...(materialLayer !== undefined && activeAtmosphere ? atmosphereNames : []),
        ],
        draws: [
          {
            program: 'analytic-cloud-pipeline',
            bindings: ['analytic-cloud-view', 'analytic-cloud-inputs'],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

function cloudTraceOutputFormat(
  view: RenderFeaturePlanContext['views'][number],
  context: RenderFeaturePlanContext,
) {
  const output = view.targets.find((target) => target.name === 'motion-output');
  const depth = view.targets.find((target) => target.name === 'depth');
  const limit = context.limits?.maxColorAttachmentBytesPerSample ?? 32;
  if (
    (output?.format !== 'rgba16float' && output?.format !== 'rgba32float') ||
    depth?.sampleCount !== 1 ||
    context.caps.backendKind === 'wgpu-webgl2' ||
    context.caps.rgba16floatRenderable !== true ||
    limit < (output.format === 'rgba32float' ? 48 : 32) ||
    (context.limits?.maxColorAttachments ?? 3) < 3
  ) {
    return err(
      new CloudLayerCapabilityMissingError(
        'single-sample WebGPU Standard HDR with three cloud attachments',
      ),
    );
  }
  return ok(output.format);
}

/** Standard's cooked, post-opaque, full-resolution cloud producer. */
export function createAnalyticCloudFeature(): RenderFeature<CookedCloudViews> {
  return {
    identity: CLOUD_LAYER_FEATURE_IDENTITY,
    placement: 'scene',
    extract(context) {
      const views: Record<string, ExtractedCookedCloudLayer> = Object.create(null);
      for (const view of context.views) {
        const layer = view.frame?.cloudLayer;
        if (view.render && layer !== undefined) views[view.identity] = layer;
      }
      return ok(views);
    },
    requiresPreparation: (views) => Object.keys(views).length > 0,
    plan(views, context) {
      const works: RenderFeatureWork[] = [];
      for (const view of context.views) {
        const layer = views[view.identity];
        if (layer === undefined) continue;
        const output = cloudTraceOutputFormat(view, context);
        if (!output.ok) return output;
        const sampled = layer.status === 'sampled' ? layer : undefined;
        const custom = layer.status === 'program' ? layer : undefined;
        const materialLayer = sampled ?? custom;
        const cloudShadowTarget = materialLayer?.shadowMap === undefined ? false : 'cloud-shadow';
        const activeAtmosphere = layer.lightEnvironment?.atmosphereAvailable === true;
        const invalid = invalidCloudTraceLayer(layer, sampled, context.generation);
        if (invalid !== undefined) return err(invalid);
        const { identifier, passName, programName } = cloudTraceProgram(sampled, custom);
        const shader = custom?.rendererSource ?? context.getFeatureShaderSource?.(identifier);
        if (shader === undefined) {
          return err(
            new CloudLayerResourceFailureError({
              stage: 'view',
              generation: context.generation,
              cause: `Missing cooked shader '${identifier}'; rebuild the shader manifest`,
            }),
          );
        }
        const params =
          layer.status === 'analytic'
            ? encode(layer)
            : layer.status === 'program'
              ? encodeProgram(layer)
              : encodeSampled(layer);
        if (materialLayer?.shadowMap !== undefined) {
          const filterSource = context.getFeatureShaderSource?.('forgeax::cloud-shadow-filter');
          if (filterSource === undefined) {
            return err(
              new CloudLayerResourceFailureError({
                stage: 'view',
                generation: context.generation,
                cause: 'Missing cloud shadow filter shader; rebuild the shader manifest',
              }),
            );
          }
          works.push(cloudShadowWork(view.identity, programName, shader, params, sampled));
          works.push(cloudShadowFilterWork(view.identity, filterSource));
        }
        works.push(
          cloudTraceWork(
            view.identity,
            output.value,
            passName,
            programName,
            shader,
            params,
            sampled,
            materialLayer,
            cloudShadowTarget,
            activeAtmosphere,
          ),
        );
      }
      return ok({ work: works });
    },
  };
}
