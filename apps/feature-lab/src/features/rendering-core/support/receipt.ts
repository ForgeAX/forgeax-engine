import type { App } from '@forgeax/engine/app';
import type { FrameReceipt } from '@forgeax/engine/render';

export function nextReceipt(app: App): Promise<FrameReceipt> {
  return new Promise((resolve) => {
    const stop = app.renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted') return;
      stop();
      resolve(event.receipt);
    });
  });
}
