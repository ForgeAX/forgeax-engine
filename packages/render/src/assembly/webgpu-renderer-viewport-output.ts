import { err, ok } from '@forgeax/engine-rhi';
import {
  type RenderError,
  RendererContractFailureError,
  RendererOperationError,
} from '../errors/render';
import {
  isOutputColorSpace,
  OUTPUT_COLOR_SPACES,
  type OutputColorSpace,
} from '../output-color-space';
import type { createRenderProfileSelection } from '../pipeline/render-profile-selection';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { PipelineState } from '../record/render-context';
import type { RenderProfile, RenderResult } from '../render-contract';
import {
  defaultViewportOutputInspection,
  isViewportOutputMode,
  VIEWPORT_OUTPUT_MODES,
  type ViewportOutputExtension,
  type ViewportOutputInspection,
  type ViewportOutputMode,
  type ViewportOutputResolution,
} from '../viewport-output-contract';
import type { createCameraViews } from './camera-views';
import { freezeRenderProfile, structuredRendererCause } from './renderer-facade';
import type { WebGPURendererInternals } from './webgpu-renderer-bootstrap';

type CameraViewsHandle = ReturnType<typeof createCameraViews>;
type ProfileSelector = ReturnType<typeof createRenderProfileSelection>;

function freezeViewportOutputResolution(
  resolved: Pick<
    ViewportOutputResolution,
    'enabled' | 'requestedMode' | 'effectiveMode' | 'activePath' | 'unavailableReason' | 'caveats'
  >,
): ViewportOutputInspection {
  return Object.freeze({
    enabled: resolved.enabled,
    requestedMode: resolved.requestedMode,
    effectiveMode: resolved.effectiveMode,
    activePath: resolved.activePath,
    ...(resolved.unavailableReason === undefined
      ? {}
      : { unavailableReason: resolved.unavailableReason }),
    caveats: Object.freeze([...resolved.caveats]),
  });
}

function viewportExtensionOf(
  internals: Pick<WebGPURendererInternals, 'viewportOutput' | 'options'>,
): ViewportOutputExtension | undefined {
  return internals.viewportOutput ?? internals.options?.viewportOutput;
}

/** Validate and apply an updated RenderProfile with rollback on configuration failure. */
export function setRendererProfile(
  internals: WebGPURendererInternals,
  cameraViews: CameraViewsHandle,
  selectProfile: ProfileSelector,
  getActiveProfile: () => RenderProfile,
  setActiveProfile: (profile: RenderProfile) => void,
  profile: RenderProfile,
): RenderResult<void, RenderError> {
  const activeProfile = getActiveProfile();
  if (
    activeProfile.configurationRevision !== undefined &&
    profile?.configurationRevision === undefined
  ) {
    return err(
      new RendererOperationError('frame-input-invalid', {
        operation: 'set-profile',
        cause: new RendererContractFailureError(
          'draw',
          'Use App.configuration for a managed Renderer; constructor policy cannot bypass its revision',
        ),
      }),
    );
  }
  const invalid = selectProfile.validate(profile, internals.device);
  if (invalid !== undefined) {
    return err(
      new RendererOperationError('frame-input-invalid', {
        operation: 'set-profile',
        cause: new RendererContractFailureError('draw', invalid),
      }),
    );
  }
  const previous = activeProfile;
  setActiveProfile(freezeRenderProfile(profile));
  try {
    cameraViews.configureStandard(undefined);
    return ok(undefined);
  } catch (cause) {
    setActiveProfile(previous);
    try {
      cameraViews.configureStandard(undefined);
    } catch {
      // The original structured profile failure remains authoritative.
    }
    return err(
      new RendererOperationError('graph-build-failed', {
        operation: 'set-profile',
        cause: structuredRendererCause(cause, 'set-profile'),
      }),
    );
  }
}

/** Validate and apply a swap-chain output color space selection. */
export function setRendererOutputColorSpace(
  internals: WebGPURendererInternals,
  pipelineState: PipelineState | null,
  colorSpace: OutputColorSpace,
): RenderResult<void, RenderError> {
  if (!isOutputColorSpace(colorSpace)) {
    return err(
      new RendererOperationError('frame-input-invalid', {
        operation: 'set-output-color-space',
        cause: {
          code: 'output-color-space-invalid',
          expected: `one of ${OUTPUT_COLOR_SPACES.join(' | ')}`,
          hint: "pass 'srgb' or 'display-p3'",
          detail: { received: String(colorSpace) },
        },
      }),
    );
  }
  const state = internals.outputColorSpace;
  if (state === undefined || state.requested === colorSpace) return ok(undefined);
  state.requested = colorSpace;
  if (pipelineState !== null) pipelineState.perPassResources.configured = false;
  return ok(undefined);
}

/** Update the optional viewport output visualization mode and return its resolved snapshot. */
export function setRendererViewportOutput(
  internals: WebGPURendererInternals,
  cameraViews: CameraViewsHandle,
  selectedProfile: () => StandardProfile,
  mode: ViewportOutputMode,
): RenderResult<ViewportOutputInspection, RenderError> {
  if (!isViewportOutputMode(mode)) {
    return err(
      new RendererOperationError('frame-input-invalid', {
        operation: 'set-viewport-output',
        cause: {
          code: 'viewport-output-mode-invalid',
          expected: `one of ${VIEWPORT_OUTPUT_MODES.join(' | ')}`,
          hint: "pass a supported ViewportOutputMode such as 'lit' or 'base-color'",
          detail: { received: String(mode) },
        },
      }),
    );
  }
  const ext = viewportExtensionOf(internals);
  if (ext === undefined) {
    if (mode === 'lit') return ok(defaultViewportOutputInspection(false));
    return err(
      new RendererOperationError('frame-input-invalid', {
        operation: 'set-viewport-output',
        cause: {
          code: 'viewport-output-unavailable',
          expected: 'a renderer created with the optional debug-view extension',
          hint: 'enable viewportDebugView or pass viewportOutput: createViewportOutputExtension()',
          detail: { requestedMode: mode },
        },
      }),
    );
  }
  ext.setMode(mode);
  const inspected = cameraViews.currentOwner;
  const profile = selectedProfile();
  const resolved = ext.resolveView({
    deviceCaps: internals.device.caps,
    deviceLimits: internals.device.limits,
    antialias: inspected.frameState.lastSuccessfulCameraAntialias,
    profile,
    ambientOcclusionEnabled: profile.ambientOcclusion?.enabled ?? false,
    compactGbuffer: profile.gbufferFormat === 'default',
    hasReceiverGeometry: profile.gbufferFormat !== 'default',
  });
  return ok(freezeViewportOutputResolution(resolved));
}

/** Read the current viewport output visualization state without mutating active settings. */
export function getRendererViewportOutput(
  internals: WebGPURendererInternals,
  cameraViews: CameraViewsHandle,
  selectedProfile: () => StandardProfile,
): ViewportOutputInspection {
  const ext = viewportExtensionOf(internals);
  if (ext === undefined) return defaultViewportOutputInspection(false);
  const inspected = cameraViews.currentOwner;
  const last = inspected.frameState.viewportOutputResolution;
  const mode = ext.getMode();
  if (last !== undefined && last.requestedMode === mode) {
    return freezeViewportOutputResolution(last);
  }
  const profile = selectedProfile();
  const resolved = ext.resolveView({
    deviceCaps: internals.device.caps,
    deviceLimits: internals.device.limits,
    antialias: inspected.frameState.lastSuccessfulCameraAntialias,
    profile,
    ambientOcclusionEnabled: profile.ambientOcclusion?.enabled ?? false,
    compactGbuffer: profile.gbufferFormat === 'default',
    hasReceiverGeometry: profile.gbufferFormat !== 'default',
  });
  return freezeViewportOutputResolution(resolved);
}

/** Project optional `viewportOutput` inspection fields when requested or installed. */
export function projectViewportOutputInspectionField(
  internals: WebGPURendererInternals,
  cameraViews: CameraViewsHandle,
  selectedProfile: () => StandardProfile,
  wantViewportOutput: boolean,
  explicitlyRequested: boolean,
): { readonly viewportOutput?: ViewportOutputInspection } {
  if (!wantViewportOutput) return {};
  if (viewportExtensionOf(internals) === undefined && !explicitlyRequested) return {};
  return { viewportOutput: getRendererViewportOutput(internals, cameraViews, selectedProfile) };
}
