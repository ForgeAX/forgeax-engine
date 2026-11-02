import type { World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { type RendererOperationCause, RendererOperationError } from '../errors/render';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
import { RenderRecord } from './render-world';

/*
 * RenderRecord is the only phase that owns the frame's command encoder:
 *
 *   render-encoder-open -> (view recording, shared work, composite) -> submit
 *
 * `render-encoder-open` opens the one {@link RenderFrameEncoder} of the
 * submission from the frame's {@link RenderRecordInput}. Every view, the
 * shared Feature work and the composite record into it; the submission
 * finishes and submits it once.
 */

/** RenderRecord system opening the submission's one command encoder. */
export const RENDER_ENCODER_OPEN_SYSTEM = 'render-encoder-open';

/** What the submission's frame entry writes before it runs RenderRecord. */
export interface RenderRecordInputState {
  /** The device every view of this submission records on. */
  readonly device: RhiDevice;
  /** Current frame identity consumed by World products and UI preparation. */
  readonly frameId: number;
  readonly generation?: number;
  readonly rendererInternals?: RenderSystemInternals | undefined;
  readonly timingCapture?: GpuTimingCapture | undefined;
  readonly isCurrent?: (() => boolean) | undefined;
  readonly composite?: boolean;
  readonly shared?: boolean;
}

/** World resource key of the submission's {@link RenderRecordInputState}. */
export const RenderRecordInput = Object.freeze({ name: 'RenderRecordInput' });

/**
 * The submission's command encoder. `open` is the one encoder every recording
 * of the submission writes into; `failed` carries the closed reason none
 * exists; `closed` means no submission is recording.
 */
export type RenderFrameEncoderState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly encoder: RhiCommandEncoder; readonly device: RhiDevice }
  | { readonly kind: 'failed'; readonly error: RendererOperationError<'device-operation-failed'> };

/** World resource key of the submission's {@link RenderFrameEncoderState}. */
export const RenderFrameEncoder = Object.freeze({ name: 'RenderFrameEncoder' });

const CLOSED: RenderFrameEncoderState = Object.freeze({ kind: 'closed' });

/** The submission's encoder state; `closed` before any submission opened one. */
export function renderFrameEncoder(world: World): RenderFrameEncoderState {
  return world.hasResource(RenderFrameEncoder)
    ? world.getResource<RenderFrameEncoderState>(RenderFrameEncoder)
    : CLOSED;
}

/**
 * The encoder a recording writes into. A view records only inside the
 * submission whose RenderRecord opened it.
 */
export function frameEncoder(world: World): RhiCommandEncoder {
  const state = renderFrameEncoder(world);
  if (state.kind !== 'open')
    throw new Error('A view records only into the encoder its submission RenderRecord opened');
  return state.encoder;
}

/** Close the submission's encoder once it was finished or abandoned. */
export function closeFrameEncoder(world: World): void {
  if (world.hasResource(RenderFrameEncoder))
    world.insertResource<RenderFrameEncoderState>(RenderFrameEncoder, CLOSED);
}

function encoderFailure(cause: unknown): RendererOperationError<'device-operation-failed'> {
  const structured = cause as Partial<RendererOperationCause> | undefined;
  const rendererCause: RendererOperationCause =
    typeof structured?.code === 'string' &&
    typeof structured.expected === 'string' &&
    typeof structured.hint === 'string'
      ? {
          code: structured.code,
          expected: structured.expected,
          hint: structured.hint,
          detail: cause,
        }
      : {
          code: 'command-encoder-unavailable',
          expected: 'the device creates the frame command encoder',
          hint: 'recover the device and retry the frame',
          detail: cause instanceof Error ? cause.message : String(cause),
        };
  return new RendererOperationError('device-operation-failed', {
    operation: 'draw',
    cause: rendererCause,
  });
}

/** Open the submission's encoder; a failure is stored as data, never thrown. */
function openFrameEncoder(input: RenderRecordInputState): RenderFrameEncoderState {
  try {
    // Native validation includes this label in its message. Keep the logical
    // owner stable so the same rejected submit is not a new warning each frame.
    const created = input.device.createCommandEncoder({ label: 'render-frame' });
    return created.ok
      ? { kind: 'open', encoder: created.value, device: input.device }
      : { kind: 'failed', error: encoderFailure(created.error) };
  } catch (cause) {
    return { kind: 'failed', error: encoderFailure(cause) };
  }
}

export function registerRecordSystems(world: World): void {
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_ENCODER_OPEN_SYSTEM,
      queries: [],
      fn: (world) => {
        const input = world.hasResource(RenderRecordInput)
          ? world.getResource<RenderRecordInputState>(RenderRecordInput)
          : undefined;
        world.insertResource<RenderFrameEncoderState>(
          RenderFrameEncoder,
          input === undefined
            ? {
                kind: 'failed',
                error: encoderFailure(new Error('RenderRecord ran without a RenderRecordInput')),
              }
            : openFrameEncoder(input),
        );
      },
    })
    .unwrap();
}
