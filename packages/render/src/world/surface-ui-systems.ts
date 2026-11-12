import type { World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { RendererContractFailureError } from '../errors/render';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import type { RenderSystemInternals } from '../record/render-context';
import {
  RENDER_ENCODER_OPEN_SYSTEM,
  RenderRecordInput,
  type RenderRecordInputState,
} from './record-systems';
import { RenderPrepare, RenderRecord, renderSubmission } from './render-world';
import { RenderSurfaceUiInput, type SurfaceUiInput, surfaceUi } from './surface-ui';

export const RENDER_SURFACE_UI_ENCODE_SYSTEM = 'render-surface-ui-encode';

export const RENDER_SURFACE_UI_PREPARE_SYSTEM = 'render-surface-ui-prepare';
export const RENDER_SURFACE_UI_PRESENT_PREPARE_SYSTEM = 'render-surface-ui-present-prepare';

function prepareSurfaceUi(world: World): void {
  const ui = surfaceUi(world);
  if (ui === undefined || !world.hasResource(RenderSurfaceUiInput)) return;
  const input = world.getResource<SurfaceUiInput>(RenderSurfaceUiInput);
  try {
    ui.outcome = ui.owner.prepare(
      input.frame,
      input.sampleTimeMs,
      input.width,
      input.height,
      input.colorSpace,
      input.captureEncodedOutput,
    );
  } catch (cause) {
    ui.outcome = {
      kind: 'failed',
      frame: input.frame,
      code: 'ui-device-operation-failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Reject stale or failed preparation as data at the frame entry or Record encoder boundary. */
export function requirePreparedSurfaceUi(world: World, frame: number): void {
  const ui = surfaceUi(world);
  if (ui === undefined) return;
  if (ui.outcome?.frame !== frame)
    throw new RendererContractFailureError(
      'draw',
      'the UI prepare system did not prepare this frame',
    );
  if (ui.outcome.kind === 'failed')
    throw new RendererContractFailureError('draw', ui.outcome.detail);
}

export function registerSurfaceUiSystems(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_SURFACE_UI_PREPARE_SYSTEM,
      before: ['render-view-outputs'],
      queries: [],
      fn: (world) => prepareSurfaceUi(world),
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_SURFACE_UI_PRESENT_PREPARE_SYSTEM,
      before: [RENDER_ENCODER_OPEN_SYSTEM],
      queries: [],
      fn: (world) => {
        // Scene frames require their Prepare product; this is solely the scene-free UI route.
        if (renderSubmission(world).open || !world.hasResource(RenderRecordInput)) return;
        const input = world.getResource<RenderRecordInputState>(RenderRecordInput);
        if (surfaceUi(world) !== undefined && input.rendererInternals !== undefined)
          prepareSurfaceUi(world);
      },
    })
    .unwrap();
}

/** Encode the World-owned screen UI and final-display observation in the shared encoder. */
export function encodeSurfaceUi(
  world: World,
  internals: RenderSystemInternals | undefined,
  frame: number,
  encoder: RhiCommandEncoder,
  sceneOutputEncoded: boolean,
): void {
  const ui = surfaceUi(world);
  if (ui === undefined || internals === undefined) return;
  ui.encodedFrame = undefined;
  requirePreparedSurfaceUi(world, frame);
  const output = internals.context?.getCurrentTexture();
  if (output === undefined)
    throw new RendererContractFailureError('draw', 'screen UI needs a surface');
  if (!output.ok) throw output.error;
  const encoded = ui.owner.encode(frame, encoder, output.value, !sceneOutputEncoded);
  if (encoded.kind === 'failed') throw new RendererContractFailureError('draw', encoded.detail);
  internals.framePassNames?.push('screen-ui-composite');
  if (ui.owner.output !== undefined) internals.framePassNames?.push('screen-ui-present');
  encodeFrameObservationCapture(
    {
      device: internals.device,
      deviceGeneration: internals.deviceScope.generation,
      outputColorSpace: internals.outputColorSpace,
      observationCaptureOwner: internals.observationCaptureOwner,
      observationCaptureDomains: internals.observationCaptureDomains,
      observationFrameId: internals.observationFrameId,
      observationGraphGeneration: internals.observationGraphGeneration,
    },
    encoder,
    {
      texture: ui.owner.output ?? output.value,
      format: ui.format,
      domain: 'final-display',
      width: internals.canvas.width,
      height: internals.canvas.height,
      frameNumber: frame,
      graphGeneration: ui.owner.generation,
    },
  );
  internals.observationGraphGeneration = ui.owner.generation;
  ui.encodedFrame = frame;
}
