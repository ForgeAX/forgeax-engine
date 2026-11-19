import { err } from '@forgeax/engine-types';
import { CUBE_CAMERA_FACE_ORDER } from '../components/cube-camera';
import { type RenderError, RenderTargetOperationFailedError } from '../errors/render';
import type {
  FrameReceipt,
  Renderer,
  RenderResult,
  RenderTargetEnvironmentCapture,
} from '../render-contract';
import type { RenderTarget } from './contracts';
import type { RenderTargetEnvironmentLease } from './environment';

const FACE_PREPARATION_TIMEOUT_MS = 20_000;

export async function captureTargetEnvironment(
  target: RenderTarget,
  options: RenderTargetEnvironmentCapture,
  renderer: {
    readonly draw: Renderer['draw'];
    readonly filter: (
      faces: readonly FrameReceipt[],
    ) => ReturnType<Renderer['prepareRenderTargetEnvironment']>;
  },
): Promise<RenderResult<RenderTargetEnvironmentLease, RenderError>> {
  const faces: FrameReceipt[] = [];
  for (let layer = 0; layer < CUBE_CAMERA_FACE_ORDER.length; layer++) {
    const { clearColor, clearDepth, clearStencil, ...frame } = await options.prepareFace(layer);
    const deadline = Date.now() + FACE_PREPARATION_TIMEOUT_MS;
    for (;;) {
      const submitted = renderer.draw({
        ...frame,
        targetWrite: { target, layer, clearColor, clearDepth, clearStencil },
      });
      if (!submitted.ok) return submitted;
      const receipt = submitted.value;
      if (receipt.presentation === 'ready') {
        faces.push(receipt);
        options.onFaceSubmitted?.(layer, receipt);
        break;
      }
      const prepared = await waitForFacePreparation(receipt, deadline);
      if (!prepared.ok) return prepared;
    }
  }
  return renderer.filter(faces);
}

async function waitForFacePreparation(
  receipt: FrameReceipt,
  deadline: number,
): Promise<RenderResult<void, RenderError>> {
  const timeout = () =>
    err(
      new RenderTargetOperationFailedError({
        operation: 'source',
        stage: 'submit',
        generation: receipt.deviceGeneration,
        cause: receipt.presentationPendingReason ?? 'cube-face-preparation-timeout',
        recovery: 'retry',
      }),
    );
  const remaining = deadline - Date.now();
  if (remaining <= 0) return timeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = receipt.preparationCompleted ?? receipt.completed;
    const result = await Promise.race([
      pending,
      new Promise<ReturnType<typeof timeout>>((resolve) => {
        timer = setTimeout(() => resolve(timeout()), remaining);
      }),
    ]);
    // Offer a task boundary when no producer identified its own preparation barrier.
    if (result.ok && receipt.preparationCompleted === undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    clearTimeout(timer);
  }
}
