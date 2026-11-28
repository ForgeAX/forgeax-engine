import type { TextureFormat } from '@forgeax/engine-rhi';
import { ANALYTIC_CLOUD_DEPTH, ANALYTIC_CLOUD_LT } from '../cloud/analytic-feature';
import { CLOUD_DEPTH_RANGE_QUARTER } from '../cloud/contracts';
import { CLOUD_ATMOSPHERE_TARGETS } from '../cloud/lighting/environment';
import type { CloudShadowFormat } from '../cloud/lighting/shadow-format';
import {
  CLOUD_SHADOW_FINAL_TARGET,
  CLOUD_SHADOW_INTERMEDIATE_TARGETS,
  CLOUD_SHADOW_RAW_TARGET,
} from '../cloud/lighting/shadow-spatial-layout';
import type { CloudTransportFormat } from '../cloud/reconstruction/history';
import { isMultisampleAntialias } from '../components/camera';
import type { RenderFeatureLogicalTarget } from './plan';

/** Render-owned logical targets exposed to producer-owned RenderFeatures. */

export type RenderFeatureTargetKind = 'scene-color' | 'scene-depth' | 'graph-texture';

/**
 * A logical attachment supplied by the active RenderPipeline.
 *
 * The semantic kind plus attachment facts identify the target. The active
 * pipeline supplies the graph resource, so feature authors never name an
 * internal graph key.
 */
export interface RenderFeatureTargetHandle {
  /** Stable alias used when a pipeline exposes more than one color role. */
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly allocationKey?: string;
  readonly materialSource?: boolean;
  readonly producerIdentity?: string;
  /** @internal Stable owner identity for host-created graph texture targets. */
  readonly allocationScope?: string;
  readonly descriptor?: import('@forgeax/engine-render-graph').GraphTextureDescriptor & {
    readonly size: {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
    };
  };
  readonly view?: import('@forgeax/engine-render-graph').GraphTextureViewDescriptor;
  readonly __renderFeatureTarget: unique symbol;
}

export interface RenderFeatureTargetInput {
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderFeatureGraphTextureTargetInput {
  readonly name: string;
  readonly kind: 'graph-texture';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly allocationKey: string;
  readonly materialSource?: boolean;
  readonly producerIdentity?: string;
  /** @internal Overrides execution-scope allocation for shared feature resources. */
  readonly allocationScope?: string;
  readonly descriptor: import('@forgeax/engine-render-graph').GraphTextureDescriptor & {
    readonly size: {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
    };
  };
  readonly view?: import('@forgeax/engine-render-graph').GraphTextureViewDescriptor;
}

const LOGICAL_TARGET = Symbol('render-feature-logical-target');
type OwnedTarget = RenderFeatureTargetHandle & {
  readonly [LOGICAL_TARGET]: {
    readonly owner: RenderFeatureTargetInput | RenderFeatureGraphTextureTargetInput;
    readonly value: RenderFeatureLogicalTarget;
  };
};

function projectLogicalTarget(
  target: RenderFeatureTargetInput | RenderFeatureGraphTextureTargetInput,
): RenderFeatureLogicalTarget {
  return {
    name: target.name ?? (target.kind === 'scene-depth' ? 'depth' : 'color'),
    kind:
      target.kind === 'scene-depth' ? 'depth' : target.name === 'swapchain' ? 'swapchain' : 'color',
    format: target.format,
    sampleCount: target.sampleCount,
  };
}

export function createRenderFeatureTarget(
  input: RenderFeatureTargetInput | RenderFeatureGraphTextureTargetInput,
): RenderFeatureTargetHandle {
  const target = { ...input };
  // Both the value and its projection belong to this immutable target.
  // A replacement target computes its own projection at creation.
  Object.defineProperty(target, LOGICAL_TARGET, {
    value: Object.freeze({ owner: target, value: Object.freeze(projectLogicalTarget(target)) }),
  });
  return Object.freeze(target) as OwnedTarget;
}

export function isRenderFeatureTargetHandle(value: unknown): value is RenderFeatureTargetHandle {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<
    RenderFeatureTargetInput | RenderFeatureGraphTextureTargetInput
  >;
  return (
    (candidate.kind === 'scene-color' ||
      candidate.kind === 'scene-depth' ||
      candidate.kind === 'graph-texture') &&
    typeof candidate.format === 'string' &&
    (candidate.sampleCount === 1 || candidate.sampleCount === 4) &&
    (candidate.kind !== 'graph-texture' ||
      typeof (candidate as Partial<RenderFeatureGraphTextureTargetInput>).allocationKey ===
        'string')
  );
}

export function createRenderFeatureGraphTextureTarget(
  input: RenderFeatureGraphTextureTargetInput,
): RenderFeatureTargetHandle {
  return createRenderFeatureTarget(input);
}

export function isRenderFeatureGraphTextureTarget(
  value: unknown,
): value is RenderFeatureTargetHandle & RenderFeatureGraphTextureTargetInput {
  return isRenderFeatureTargetHandle(value) && value.kind === 'graph-texture';
}

export function resolveStandardRenderFeatureTargets(input: {
  readonly tonemap: string;
  readonly antialias: string;
  readonly storageBuffer: boolean;
  readonly multisample: boolean;
  readonly colorAttachmentFormat: TextureFormat;
  /** Water's SLW stage exposes its matched single-sample surface before features. */
  readonly singleLayerWater?: boolean;
  /** Expose cloud history aliases only while a CloudLayer is authored. */
  readonly cloudHistory?: boolean;
  readonly analyticCloud?: boolean;
  readonly cloudTransportFormat?: CloudTransportFormat;
  readonly cloudDepthFormat?: CloudTransportFormat;
  readonly cloudShadowFormat?: CloudShadowFormat;
}): readonly RenderFeatureTargetHandle[] {
  const targets = resolveStandardColorFeatureTargets(input);
  if (input.antialias !== 'taa' && input.antialias !== 'tsr') return targets;
  let temporal = temporalTargets.get(targets);
  if (temporal === undefined) {
    temporal = Object.freeze([
      ...targets.slice(0, -1),
      TEMPORAL_REACTIVITY_TARGET,
      targets[targets.length - 1] as RenderFeatureTargetHandle,
    ]);
    temporalTargets.set(targets, temporal);
    temporalLogicalTargets.set(temporal, projectLogicalTargets(temporal));
  }
  return temporal;
}

const TEMPORAL_REACTIVITY_TARGET = createRenderFeatureTarget({
  name: 'temporal-reactivity',
  kind: 'scene-color',
  format: 'rgba16float',
  sampleCount: 1,
});
const temporalTargets = new WeakMap<
  readonly RenderFeatureTargetHandle[],
  readonly RenderFeatureTargetHandle[]
>();
const temporalLogicalTargets = new WeakMap<
  readonly RenderFeatureTargetHandle[],
  readonly RenderFeatureLogicalTarget[]
>();

function resolveStandardColorFeatureTargets(
  input: Parameters<typeof resolveStandardRenderFeatureTargets>[0],
): readonly RenderFeatureTargetHandle[] {
  const opaqueSampleCount = isMultisampleAntialias(input.antialias) && input.multisample ? 4 : 1;
  const sampleCount: 1 | 4 =
    isMultisampleAntialias(input.antialias) && input.multisample && input.singleLayerWater !== true
      ? 4
      : 1;
  // Standard always exposes the scene to features as a linear float target;
  // the shared Output Transform owns the eventual RGBA8 write for every
  // antialias mode, including no-AA/WebGL2.
  const linearLdr =
    input.tonemap === 'none' ||
    input.antialias === 'fxaa' ||
    (isMultisampleAntialias(input.antialias) && input.multisample);
  const colorFormat =
    input.tonemap !== 'none' || linearLdr ? 'rgba16float' : input.colorAttachmentFormat;
  const cloudHistory = input.cloudHistory === true;
  const targets =
    input.analyticCloud === true && sampleCount === 1 && colorFormat === 'rgba16float'
      ? mode0Targets(opaqueSampleCount, input.cloudTransportFormat, input.cloudDepthFormat)
      : colorFormat === 'rgba16float'
        ? linearSurfaceTargets(sampleCount, opaqueSampleCount, cloudHistory)
        : standardTargets(sampleCount, cloudHistory, colorFormat, opaqueSampleCount);
  const format = input.cloudShadowFormat;
  return format === undefined || format === 'rgba32float'
    ? targets
    : cloudShadowTargets(targets, format);
}

const CLOUD_SHADOW_TARGETS = [
  CLOUD_SHADOW_FINAL_TARGET,
  CLOUD_SHADOW_RAW_TARGET,
  ...CLOUD_SHADOW_INTERMEDIATE_TARGETS,
] as const;

const shadowTargetVariants = new WeakMap<
  readonly RenderFeatureTargetHandle[],
  Map<CloudShadowFormat, readonly RenderFeatureTargetHandle[]>
>();

function cloudShadowTargets(
  targets: readonly RenderFeatureTargetHandle[],
  format: CloudShadowFormat,
): readonly RenderFeatureTargetHandle[] {
  let variants = shadowTargetVariants.get(targets);
  if (variants === undefined) {
    variants = new Map();
    shadowTargetVariants.set(targets, variants);
  }
  const cached = variants.get(format);
  if (cached !== undefined) return cached;
  const projected = Object.freeze(
    targets.map((target) => {
      const { name } = target;
      return name !== undefined && CLOUD_SHADOW_TARGETS.some((candidate) => candidate === name)
        ? createRenderFeatureTarget({ name, kind: 'scene-color', format, sampleCount: 1 })
        : target;
    }),
  );
  variants.set(format, projected);
  return projected;
}

/** Standard draws the output lattice only for consumers that sample this port. */
export const POST_PROCESS_OUTPUT_DEPTH = 'output-depth';

const presentationTargetProjections = new WeakMap<
  readonly RenderFeatureTargetHandle[],
  readonly RenderFeatureLogicalTarget[]
>();
const presentationTargets = new WeakMap<
  readonly RenderFeatureTargetHandle[],
  Map<TextureFormat, readonly RenderFeatureTargetHandle[]>
>();

/** The Standard after-tonemap overlay can choose the actual encoded attachment format. */
export function withStandardPresentationTarget(
  targets: readonly RenderFeatureTargetHandle[],
  format: TextureFormat,
): readonly RenderFeatureTargetHandle[] {
  let formats = presentationTargets.get(targets);
  if (formats === undefined) {
    formats = new Map();
    presentationTargets.set(targets, formats);
  }
  const existing = formats.get(format);
  if (existing !== undefined) return existing;
  const result = Object.freeze([
    ...targets,
    createRenderFeatureTarget({ name: 'swapchain', kind: 'scene-color', format, sampleCount: 1 }),
    createRenderFeatureTarget({
      name: POST_PROCESS_OUTPUT_DEPTH,
      kind: 'scene-depth',
      format: 'depth32float-stencil8',
      sampleCount: 1,
    }),
  ]);
  formats.set(format, result);
  presentationTargetProjections.set(result, projectLogicalTargets(result));
  return result;
}

function mode0Targets(
  opaqueSampleCount: 1 | 4,
  format: CloudTransportFormat | undefined,
  depthFormat: CloudTransportFormat | undefined,
) {
  if (depthFormat === 'rgba16float')
    return opaqueSampleCount === 4 ? WATER_MSAA_MODE0_UE5_TARGETS : MODE0_UE5_TARGETS;
  const fp32 = format === 'rgba32float';
  if (opaqueSampleCount === 4)
    return fp32 ? WATER_MSAA_MODE0_FP32_TARGETS : WATER_MSAA_MODE0_TARGETS;
  return fp32 ? MODE0_FP32_TARGETS : MODE0_TARGETS;
}

function linearSurfaceTargets(sampleCount: 1 | 4, opaqueSampleCount: 1 | 4, cloudHistory: boolean) {
  if (sampleCount === 1 && opaqueSampleCount === 4)
    return cloudHistory ? WATER_MSAA_CLOUD_TARGETS : WATER_MSAA_TARGETS;
  if (sampleCount === 4) return cloudHistory ? MSAA_CLOUD_TARGETS : MSAA_TARGETS;
  return cloudHistory ? CLOUD_TARGETS : TARGETS;
}

function standardTargets(
  sampleCount: 1 | 4,
  cloudHistory: boolean,
  colorFormat: TextureFormat,
  opaqueSampleCount: 1 | 4 = sampleCount,
  analyticCloud = false,
  cloudTransportFormat: CloudTransportFormat = 'rgba16float',
  cloudDepthFormat: CloudTransportFormat = 'rgba32float',
): readonly RenderFeatureTargetHandle[] {
  const targets = Object.freeze([
    createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'depth',
      kind: 'scene-depth',
      format: 'depth32float-stencil8',
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-input',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-output',
      kind: 'scene-color',
      format: analyticCloud ? cloudTransportFormat : colorFormat,
      sampleCount: 1,
    }),
    ...(analyticCloud
      ? [
          ...Object.values(CLOUD_ATMOSPHERE_TARGETS).map((name) =>
            createRenderFeatureTarget({
              name,
              kind: 'scene-color',
              format: 'rgba16float',
              sampleCount: 1,
            }),
          ),
          createRenderFeatureTarget({
            name: CLOUD_DEPTH_RANGE_QUARTER,
            kind: 'scene-color',
            format: 'rg16float',
            sampleCount: 1,
          }),
          ...[
            'cloud-mode0-trace-far',
            'cloud-mode0-trace-near',
            'cloud-mode0-trace-depth',
            'cloud-mode0-probe-color',
            'cloud-mode0-probe-data',
            'cloud-mode0-probe-depth',
          ].map((name) =>
            createRenderFeatureTarget({
              name,
              kind: 'scene-color',
              format:
                name === 'cloud-mode0-trace-depth'
                  ? cloudDepthFormat
                  : name.endsWith('depth')
                    ? 'rgba32float'
                    : name.startsWith('cloud-mode0-trace-')
                      ? cloudTransportFormat
                      : 'rgba16float',
              sampleCount: 1,
            }),
          ),
          createRenderFeatureTarget({
            name: ANALYTIC_CLOUD_LT,
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: ANALYTIC_CLOUD_DEPTH,
            kind: 'scene-color',
            format: 'rgba32float',
            sampleCount: 1,
          }),
        ]
      : []),
    // A graph-owned, single-sample map produced before direct-solar lighting.
    // The logical handle lets the feature plan validate its producer before
    // the Standard pipeline allocates the concrete texture.
    ...CLOUD_SHADOW_TARGETS.map((name) =>
      createRenderFeatureTarget({
        name,
        kind: 'scene-color',
        format: 'rgba32float',
        sampleCount: 1,
      }),
    ),
    // These are declarative aliases only. Standard allocates the actual
    // linear-LDR ping-pong target at the ordered post stage and resolves these
    // names through `contributeFeatures` when that stage is reached.
    createRenderFeatureTarget({
      name: 'barrel-input',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      name: 'barrel-output',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      name: 'editor-input',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      name: 'editor-output',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      name: 'editor-depth',
      kind: 'scene-depth',
      format: 'depth32float-stencil8',
      sampleCount,
    }),
    ...(cloudHistory
      ? [
          createRenderFeatureTarget({
            name: 'cloud-history-radiance-previous',
            kind: 'scene-color',
            format: cloudTransportFormat,
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-radiance-current',
            kind: 'scene-color',
            format: cloudTransportFormat,
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-transmittance-previous',
            kind: 'scene-color',
            format: cloudTransportFormat,
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-transmittance-current',
            kind: 'scene-color',
            format: cloudTransportFormat,
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-depth-previous',
            kind: 'scene-color',
            format: cloudDepthFormat,
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-depth-current',
            kind: 'scene-color',
            format: cloudDepthFormat,
            sampleCount: 1,
          }),
        ]
      : []),
    createRenderFeatureTarget({
      name: 'opaque-depth',
      kind: 'scene-depth',
      format: 'depth32float-stencil8',
      sampleCount: opaqueSampleCount,
    }),
  ]);
  return targets;
}

const TARGETS = standardTargets(1, false, 'rgba16float');
const ANALYTIC_TARGETS = standardTargets(1, false, 'rgba16float', 1, true);
const MODE0_UE5_TARGETS = standardTargets(
  1,
  true,
  'rgba16float',
  1,
  true,
  'rgba16float',
  'rgba16float',
);
const WATER_MSAA_MODE0_UE5_TARGETS = standardTargets(
  1,
  true,
  'rgba16float',
  4,
  true,
  'rgba16float',
  'rgba16float',
);
const MODE0_TARGETS = standardTargets(1, true, 'rgba16float', 1, true);
const MODE0_FP32_TARGETS = standardTargets(1, true, 'rgba16float', 1, true, 'rgba32float');
const CLOUD_TARGETS = standardTargets(1, true, 'rgba16float');
const MSAA_TARGETS = standardTargets(4, false, 'rgba16float');
const MSAA_CLOUD_TARGETS = standardTargets(4, true, 'rgba16float');
const WATER_MSAA_TARGETS = standardTargets(1, false, 'rgba16float', 4);
const WATER_MSAA_CLOUD_TARGETS = standardTargets(1, true, 'rgba16float', 4);
const WATER_MSAA_MODE0_TARGETS = standardTargets(1, true, 'rgba16float', 4, true);
const WATER_MSAA_MODE0_FP32_TARGETS = standardTargets(
  1,
  true,
  'rgba16float',
  4,
  true,
  'rgba32float',
);
const LOGICAL_TARGETS = projectLogicalTargets(TARGETS);
const LOGICAL_ANALYTIC_TARGETS = projectLogicalTargets(ANALYTIC_TARGETS);
const LOGICAL_CLOUD_TARGETS = projectLogicalTargets(CLOUD_TARGETS);
const LOGICAL_MSAA_TARGETS = projectLogicalTargets(MSAA_TARGETS);
const LOGICAL_MSAA_CLOUD_TARGETS = projectLogicalTargets(MSAA_CLOUD_TARGETS);
const LOGICAL_WATER_MSAA_TARGETS = projectLogicalTargets(WATER_MSAA_TARGETS);
const LOGICAL_WATER_MSAA_CLOUD_TARGETS = projectLogicalTargets(WATER_MSAA_CLOUD_TARGETS);

/** Owned handles carry immutable logical rows; borrowed handles are read on every call. */
export function logicalRenderFeatureTargets(
  targets: readonly RenderFeatureTargetHandle[],
): readonly RenderFeatureLogicalTarget[] {
  // Exact static owner identity avoids reading private properties or array
  // contents through borrowed proxies. Custom rosters retain their live map.
  switch (targets) {
    case TARGETS:
      return LOGICAL_TARGETS;
    case ANALYTIC_TARGETS:
      return LOGICAL_ANALYTIC_TARGETS;
    case CLOUD_TARGETS:
      return LOGICAL_CLOUD_TARGETS;
    case MSAA_TARGETS:
      return LOGICAL_MSAA_TARGETS;
    case MSAA_CLOUD_TARGETS:
      return LOGICAL_MSAA_CLOUD_TARGETS;
    case WATER_MSAA_TARGETS:
      return LOGICAL_WATER_MSAA_TARGETS;
    case WATER_MSAA_CLOUD_TARGETS:
      return LOGICAL_WATER_MSAA_CLOUD_TARGETS;
    default:
      return (
        temporalLogicalTargets.get(targets) ??
        presentationTargetProjections.get(targets) ??
        projectLogicalTargets(targets)
      );
  }
}

function projectLogicalTargets(
  targets: readonly RenderFeatureTargetHandle[],
): readonly RenderFeatureLogicalTarget[] {
  return Object.freeze(
    targets.map((target) => {
      const projection = (target as Partial<OwnedTarget>)[LOGICAL_TARGET];
      // A borrowed proxy may forward private properties without owning them.
      return projection?.owner === target
        ? projection.value
        : projectLogicalTarget(target as RenderFeatureTargetInput);
    }),
  );
}
