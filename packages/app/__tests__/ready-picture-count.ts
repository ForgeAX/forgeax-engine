import { type BrowserFrameCompleted, FORGEAX_FRAME_COMPLETED_EVENT } from '@forgeax/engine-app';

export function observeReadyPictures(canvas: HTMLCanvasElement) {
  const frames = new Set<number>();
  const onCompleted = (event: Event) => {
    const picture = (event as CustomEvent<BrowserFrameCompleted>).detail;
    if (picture.presentation === 'ready') frames.add(picture.frameId);
  };
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
  return {
    get count() {
      return frames.size;
    },
    dispose() {
      canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
    },
  };
}
