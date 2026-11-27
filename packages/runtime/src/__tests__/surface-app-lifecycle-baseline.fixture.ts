import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';

/** Complete the first ready picture, recycling observation from pending pictures. */
export async function completeSurfaceAppBaseline({
  renderer,
  receipts,
  submit,
}: {
  readonly renderer: Renderer;
  readonly receipts: readonly FrameReceipt[];
  readonly submit: () => Promise<FrameReceipt>;
}): Promise<FrameReceipt> {
  try {
    return await completeReadyFrame(submit, {
      timeoutMs: 30_000,
      async onCompleted(receipt) {
        if (
          receipt.presentation !== 'ready' &&
          receipt.observationDomains?.includes('linear-hdr')
        ) {
          const observed = await renderer.observe(receipt, { include: ['linear-hdr'] });
          if (!observed.ok) throw observed.error;
        }
      },
    });
  } catch (cause) {
    // The ready-frame driver waits on the whole receipt. Inspect its native
    // queue and reflection continuations before App cleanup settles them.
    const { state, frame } = renderer.inspect({ fields: ['state', 'frame'] });
    const receipt = receipts.at(-1);
    console.error(
      'surface-app-lifecycle baseline failed',
      JSON.stringify({
        state,
        frame,
        lastReceipt: receipt && {
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          presentation: receipt.presentation,
          pendingReason: receipt.presentationPendingReason,
          backend: receipt.backendId,
        },
      }),
    );
    throw cause;
  }
}
