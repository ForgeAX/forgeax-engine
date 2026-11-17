import { validateChannelMask } from './components/lighting-channels';
import type { CameraSnapshot } from './render-contract';
import type { RenderableSnapshot } from './render-system-extract';

/** Camera-only geometry admission. Shadow participation remains independent. */
export function cameraAdmitsLayers(
  camera: Pick<CameraSnapshot, 'cullMask'> | undefined,
  source: Pick<RenderableSnapshot, 'renderLayers'>,
): boolean {
  const cameraMask = camera?.cullMask ?? 0xffffffff,
    layers = source.renderLayers ?? 1;
  const invalid =
    validateChannelMask(cameraMask, 'cullMask') ?? validateChannelMask(layers, 'renderLayers');
  if (invalid) throw invalid;
  return ((cameraMask >>> 0) & (layers >>> 0)) !== 0;
}
