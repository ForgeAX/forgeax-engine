import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { RhiCaps, RhiLimits } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { Antialias } from './components/camera';
import type { StandardProfile } from './pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTarget } from './render-pipeline';

/** Closed list of supported viewport output modes. */
export const VIEWPORT_OUTPUT_MODES = [
  'lit',
  'base-color',
  'world-normal',
  'geometric-normal',
  'metallic',
  'roughness',
  'material-ao',
  'screen-ao',
  'emissive',
  'depth',
  'lighting-only',
  'overview',
] as const;

export type ViewportOutputMode = (typeof VIEWPORT_OUTPUT_MODES)[number];

/** Distinct RenderGraph topology buckets used by non-lit viewport modes. */
export type ViewportOutputTopologyBucket =
  | 'surface-only'
  | 'surface-with-ao'
  | 'lighting-only'
  | 'overview';

export type ViewportOutputCaveat =
  | 'forward-only-omitted'
  | 'msaa-suspended-for-gbuffer'
  | 'roughness-includes-specular-aa'
  | 'screen-ao-disabled'
  | 'geometric-normal-unavailable-in-compact-gbuffer';

export type ViewportOutputUnavailableReason =
  | 'extension-not-installed'
  | 'device-lacks-gbuffer'
  | 'mode-unsupported';

/** Detached inspection snapshot for `Renderer.inspect().viewportOutput`. */
export interface ViewportOutputInspection {
  readonly enabled: boolean;
  readonly requestedMode: ViewportOutputMode;
  readonly effectiveMode: ViewportOutputMode;
  readonly activePath: 'native' | 'gbuffer-visualizer' | 'unavailable';
  readonly unavailableReason?: ViewportOutputUnavailableReason | undefined;
  readonly caveats: readonly ViewportOutputCaveat[];
}

/** Per-view resolution emitted by an installed viewport output extension. */
export interface ViewportOutputResolution extends ViewportOutputInspection {
  readonly topologyBucket?: ViewportOutputTopologyBucket | undefined;
  readonly suspendMsaa: boolean;
  readonly suspendTemporalAa: boolean;
}

export interface ViewportOutputResolveInput {
  readonly deviceCaps: Pick<RhiCaps, 'storageBuffer' | 'maxColorAttachments' | 'backendKind'>;
  readonly deviceLimits: Pick<RhiLimits, 'maxColorAttachmentBytesPerSample'>;
  readonly antialias?: Antialias | undefined;
  readonly profile: StandardProfile | undefined;
  readonly ambientOcclusionEnabled: boolean;
  readonly compactGbuffer: boolean;
  readonly hasReceiverGeometry: boolean;
}

export interface ViewportOutputLightingOnlyInput {
  readonly compact: boolean;
  readonly normalRoughness: RenderPipelineTarget;
  readonly albedoMetallic: RenderPipelineTarget;
  readonly dielectricSpecular: RenderPipelineTarget;
  readonly scene: RenderPipelineTarget;
  readonly outAlbedoMetallic: RenderPipelineTarget;
  readonly outDielectricSpecular: RenderPipelineTarget;
  readonly outScene: RenderPipelineTarget;
}

export interface ViewportOutputVisualizerInput {
  readonly compact: boolean;
  readonly hasScreenAo: boolean;
  readonly hasReceiverGeometry: boolean;
  readonly hasLitColor: boolean;
  readonly normalRoughness: RenderPipelineTarget;
  readonly albedoMetallic: RenderPipelineTarget;
  readonly dielectricSpecular: RenderPipelineTarget;
  readonly sceneColor: RenderPipelineTarget;
  readonly emissiveCopy?: RenderPipelineTarget | undefined;
  readonly receiverGeometry?: RenderPipelineTarget | undefined;
  readonly depth: import('@forgeax/engine-render-graph').GraphTextureView;
  readonly screenAo?: RenderPipelineTarget | undefined;
  readonly output: RenderPipelineTarget;
}

/**
 * Optional, tree-shakeable viewport debug-visualization extension.
 * Core render code holds only this interface; WGSL and GPU passes live in
 * `@forgeax/engine-render/debug-view` so default builds eliminate them entirely.
 */
export interface ViewportOutputExtension {
  readonly kind: 'viewport-output-extension/1';
  getMode(): ViewportOutputMode;
  setMode(mode: ViewportOutputMode): void;
  resolveView(input: ViewportOutputResolveInput): ViewportOutputResolution;
  addLightingOnlyOverridePass(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    input: ViewportOutputLightingOnlyInput,
  ): Result<void, RenderGraphError>;
  addVisualizerPass(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    input: ViewportOutputVisualizerInput,
  ): Result<void, RenderGraphError>;
}

const VIEWPORT_OUTPUT_MODE_SET: ReadonlySet<string> = new Set(VIEWPORT_OUTPUT_MODES);

export function isViewportOutputMode(value: unknown): value is ViewportOutputMode {
  return typeof value === 'string' && VIEWPORT_OUTPUT_MODE_SET.has(value);
}

const DISABLED_INSPECTION: ViewportOutputInspection = Object.freeze({
  enabled: false,
  requestedMode: 'lit',
  effectiveMode: 'lit',
  activePath: 'native',
  caveats: Object.freeze([]),
});

const ENABLED_LIT_INSPECTION: ViewportOutputInspection = Object.freeze({
  enabled: true,
  requestedMode: 'lit',
  effectiveMode: 'lit',
  activePath: 'native',
  caveats: Object.freeze([]),
});

export function defaultViewportOutputInspection(enabled = false): ViewportOutputInspection {
  return enabled ? ENABLED_LIT_INSPECTION : DISABLED_INSPECTION;
}
