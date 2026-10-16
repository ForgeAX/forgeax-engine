import { previewShouldCapture } from '@forgeax/view-workspace-core/preview-camera';

export {
  cameraPoseForRestore,
  cameraPoseWithPivot,
  commitPreviewCameraPivot,
  meshAabbCenter,
  previewCameraKey,
  previewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '@forgeax/view-workspace-core/preview-camera';

export function materialPreviewShouldCapture(event: Event, surface: HTMLElement | null | undefined, pageType = 'material') {
  return previewShouldCapture(event, surface, pageType);
}
