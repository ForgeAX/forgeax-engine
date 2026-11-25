import { isMultisampleAntialias } from '../components/camera';
import { materialShadersSamplePointShadows } from '../point-shadow-inspection';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchEntry } from '../render-system-extract';
import { type MaterialDispatchPass, someCapturedMaterialPass } from '../scene/material-dispatch';
import { ssaoUsesLighting } from '../ssao-config';
import type { ViewPassPlan } from '../world/pass-plan-systems';
import type { ViewLights } from '../world/render-lights';
import { recordContext } from '../world/view-record-context';
import {
  type ForwardProjectedLight,
  forwardPunctualShadowPlan,
} from './forward-punctual-shadow-plan';
import { renderInternalCopySize } from './render-extent';
import type { StandardTopologyInputValue } from './standard-lighting/topology';

export const FORWARD_SHADOW_COLOR_ENTRY = 'fs_forward_sun_shadow';

export function isForwardShadowColorEntry(entry: string | null | undefined): boolean {
  return entry === FORWARD_SHADOW_COLOR_ENTRY;
}

export type ForwardShadowAdmission =
  | {
      readonly mode: 'screen';
      readonly format: 'r8unorm' | 'rgba8unorm';
      /** Omitted when the primary directional light owns R. */
      readonly directional?: false;
      readonly contact?: true;
      /** A is reserved for AO. Shadow projections use RGB. */
      readonly ambientOcclusion?: true;
      readonly viewFade?: true;
      readonly gatherSpot?: true;
      readonly width: number;
      readonly height: number;
      readonly punctual?: {
        readonly point: boolean;
        readonly spot: false | 'uniform' | 'compact';
      };
    }
  | {
      readonly mode: 'raw';
      readonly reason:
        | 'view'
        | 'capability'
        | 'coverage'
        | 'shadow-family'
        | 'screen-inputs'
        | 'channel-overflow'
        | 'no-shadow-lights';
    };

type ProjectedForwardShadow = Extract<ForwardShadowAdmission, { mode: 'screen' }>;

/** Physical display Passes keep their attachments across changes to the actual receiver policy.
 * Declared graphs carry the receiver selected with that graph. */
export function currentForwardShadowReceiver(
  frame: RenderFrameState,
): ForwardShadowAdmission | undefined {
  const installed = frame.compiledFrameGraph;
  return installed?.displayPorts === undefined
    ? installed?.forwardDirectionalShadow
    : frame.forwardDisplayReceiver;
}

export type ForwardShadowInspection =
  | Extract<ForwardShadowAdmission, { mode: 'raw' }>
  | (ProjectedForwardShadow & {
      readonly projectedLights: number;
      readonly punctual?: NonNullable<ProjectedForwardShadow['punctual']> & {
        readonly channelCount: number;
        readonly lights: readonly ForwardProjectedLight[];
      };
    });

/** Counts describe the submitted light roster. They do not affect graph topology. */
export function inspectForwardShadow(
  admission: ForwardShadowAdmission,
  lighting: StandardTopologyInputValue,
): ForwardShadowInspection {
  if (admission.mode === 'raw') return admission;
  const { punctual, ...mask } = admission;
  const directional = admission.directional !== false;
  if (punctual === undefined) return { ...mask, projectedLights: Number(directional) };
  const plan = forwardPunctualShadowPlan(lighting.prepared, directional, admission);
  if (plan.kind === 'raw') return { mode: 'raw', reason: plan.reason };
  return {
    ...mask,
    projectedLights: Number(directional) + plan.lights.length,
    punctual: { ...punctual, channelCount: plan.channelCount, lights: plan.lights },
  };
}

export function hasForwardShadowCoverage(
  dispatch: Iterable<DispatchEntry>,
  retainEmpty = false,
): boolean {
  let opaque = retainEmpty;
  const incompatible = (draw: MaterialDispatchPass | DispatchEntry): boolean => {
    if (
      draw.tags.LightMode !== 'Forward' ||
      draw.queue >= 3000 ||
      draw.renderState?.blend !== undefined
    )
      return false;
    const state = draw.renderState;
    const depthCompare = state?.depthCompare ?? 'less';
    if (
      draw.materialShaderId !== 'forgeax::default-standard-pbr' ||
      (draw.vertexEntry !== undefined && draw.vertexEntry !== 'vs_main') ||
      (draw.fragmentEntry !== undefined && draw.fragmentEntry !== 'fs_main') ||
      state?.depthWriteEnabled === false ||
      (depthCompare !== 'less' && depthCompare !== 'less-equal') ||
      state?.stencil !== undefined ||
      state?.alphaToCoverageEnabled === true ||
      state?.outputs?.some((output) => output.blend !== undefined) === true
    )
      return true;
    opaque = true;
    return false;
  };
  const rejected = someCapturedMaterialPass(dispatch, incompatible);
  if (rejected !== undefined) return !rejected && opaque;
  for (const draw of dispatch) if (incompatible(draw)) return false;
  return opaque;
}

export function withForwardShadowAdmission(
  topology: RenderPipelineTopology,
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  passPlan: ViewPassPlan,
  camera: CameraSnapshot,
  lighting: StandardTopologyInputValue | undefined,
  directionalConfig: ViewLights['directionalCsmConfig'],
): RenderPipelineTopology {
  if (topology.standardProfile?.renderPath !== 'forward') return topology;
  const { directional, pointCount, spotCount } = topology.shadow;
  // An unshadowed view has the same graph during target observation.
  // View fade may still need a neutral projection for previously shadowed lights.
  if (
    directional === 'disabled' &&
    pointCount === 0 &&
    spotCount === 0 &&
    !topology.forwardContactShadows &&
    !topology.standardProfile.forwardShadowViewFade
  ) {
    return {
      ...topology,
      forwardDirectionalShadow: { mode: 'raw', reason: 'no-shadow-lights' },
    };
  }
  return {
    ...topology,
    forwardDirectionalShadow: resolveForwardShadowAdmission(topology, {
      coverage:
        passPlan.forwardShadowCoverage === true &&
        passPlan.materialSceneDepth !== true &&
        camera.clipping === undefined,
      display:
        frameState.graphTargetCapture === undefined &&
        recordContext(internals).captureView === undefined,
      program: internals.standardSceneShaders?.forwardDirectionalShadow !== undefined,
      aoAvailable: frameState.gtaoExecutionOverride !== 'compute',
      lighting,
      directionalConfig,
      shadows: () => hasPointShadowProgram(internals),
    }),
  };
}

function resolveForwardShadowAdmission(
  topology: RenderPipelineTopology,
  inputs: {
    readonly coverage: boolean;
    readonly display: boolean;
    readonly program: boolean;
    readonly aoAvailable: boolean;
    readonly lighting: StandardTopologyInputValue | undefined;
    readonly directionalConfig: ViewLights['directionalCsmConfig'];
    readonly shadows: () => boolean;
  },
): ForwardShadowAdmission {
  const { directional } = topology.shadow;
  if (!inputs.display || topology.clearOnly || topology.opaque?.lane !== 'forward')
    return { mode: 'raw', reason: 'view' };
  if (
    !topology.lane.storageBuffer ||
    isMultisampleAntialias(topology.camera.antialias) ||
    !inputs.program
  )
    return { mode: 'raw', reason: 'capability' };
  if (
    !inputs.coverage ||
    topology.materialSceneDepth ||
    topology.unfoggedOpaque ||
    topology.water ||
    topology.transmissionDemand?.activeCount
  )
    return { mode: 'raw', reason: 'coverage' };
  if (
    directional !== 'disabled' &&
    (inputs.directionalConfig?.shadowViewProjection !== undefined ||
      inputs.directionalConfig?.shadowBiasMode === 1 ||
      (directional.terrainReceivers?.length ?? 0) > 0)
  )
    return { mode: 'raw', reason: 'shadow-family' };
  if (hasOtherForwardScreenInput(topology)) return { mode: 'raw', reason: 'screen-inputs' };
  return projectForwardShadowInputs(topology, inputs);
}

function projectForwardShadowInputs(
  topology: RenderPipelineTopology,
  inputs: {
    readonly aoAvailable: boolean;
    readonly lighting: StandardTopologyInputValue | undefined;
    readonly directionalConfig: ViewLights['directionalCsmConfig'];
    readonly shadows: () => boolean;
  },
): ForwardShadowAdmission {
  const ambientOcclusion = ssaoUsesLighting(topology.config?.ambientOcclusion);
  if (ambientOcclusion && !inputs.aoAvailable) return { mode: 'raw', reason: 'capability' };
  return projectForwardShadowTopology(topology, inputs.lighting, inputs.shadows, ambientOcclusion);
}

function forwardProjectionView(topology: RenderPipelineTopology, ambientOcclusion: boolean) {
  return {
    ...renderInternalCopySize(topology),
    ...(topology.forwardContactShadows ? { contact: true as const } : {}),
    ...(ambientOcclusion ? { ambientOcclusion: true as const } : {}),
    ...(topology.standardProfile?.forwardShadowSpotFilter === 'gather'
      ? { gatherSpot: true as const }
      : {}),
    ...(topology.standardProfile?.forwardShadowViewFade ? { viewFade: true as const } : {}),
  };
}

function projectEmptyShadowTopology(
  lighting: StandardTopologyInputValue | undefined,
  directional: boolean,
  size: ReturnType<typeof forwardProjectionView>,
): ForwardShadowAdmission {
  if (directional)
    return { mode: 'screen', format: size.ambientOcclusion ? 'rgba8unorm' : 'r8unorm', ...size };
  // Keep the projected receiver neutral when view fade has removed every
  // shadow. Returning to raw sampling would make the faded shadow reappear.
  if (
    size.viewFade &&
    lighting?.kind === 'clustered' &&
    lighting.transport.kind !== 'cpu-texture' &&
    lighting.prepared.local.some((light) => light.shadowed)
  )
    return { mode: 'screen', format: 'rgba8unorm', directional: false, ...size };
  return { mode: 'raw', reason: 'no-shadow-lights' };
}

function projectForwardShadowTopology(
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue | undefined,
  shadows: () => boolean,
  ambientOcclusion: boolean,
): ForwardShadowAdmission {
  const directional =
    topology.shadow.directional !== 'disabled' || topology.forwardContactShadows === true;
  const size = forwardProjectionView(topology, ambientOcclusion);
  const plan =
    lighting === undefined
      ? undefined
      : forwardPunctualShadowPlan(lighting.prepared, directional, size);
  if (plan?.kind === 'raw') return { mode: 'raw', reason: plan.reason };
  if (plan === undefined || plan.lights.length === 0)
    return projectEmptyShadowTopology(lighting, directional, size);
  if (lighting?.kind !== 'clustered' || lighting.transport.kind === 'cpu-texture')
    return { mode: 'raw', reason: 'capability' };
  if (
    (plan.point && topology.shadow.pointCount === 0) ||
    (plan.spot && topology.shadow.spotCount === 0)
  )
    return { mode: 'raw', reason: 'shadow-family' };
  const hasUniformShadowParams = shadows();
  if (plan.point && !hasUniformShadowParams) return { mode: 'raw', reason: 'shadow-family' };
  const { point } = plan;
  const spot = plan.spot && (hasUniformShadowParams ? 'uniform' : 'compact');
  return {
    mode: 'screen',
    format: 'rgba8unorm',
    ...(!directional ? { directional: false as const } : {}),
    ...size,
    punctual: { point, spot },
  };
}

/** The projected receiver reserves the existing Forward screen texture carrier. */
function hasOtherForwardScreenInput(topology: RenderPipelineTopology): boolean {
  return (
    (topology.forwardCapsuleShadows ||
      (topology.projectedDecals?.length ?? 0) > 0 ||
      topology.ssr?.status === 'admitted' ||
      (topology.sceneDataBindings?.length ?? 0) > 0) === true
  );
}

function hasPointShadowProgram(internals: RenderSystemInternals): boolean {
  const registry = internals.shaderRegistry ?? internals.assets.shaderRegistry;
  const identifier = 'forgeax::default-standard-pbr';
  const template = registry?.programTemplate(identifier);
  if (template !== undefined) return template.engine?.pointShadows === true;
  const entry = registry?.materialShaderManifestEntry(identifier);
  return entry !== undefined && materialShadersSamplePointShadows([entry]);
}
