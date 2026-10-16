// Negative fixture (w27 case e): runtime regrows a static @forgeax/engine-image
// import after the M3 strip. The Path (a) gate must FAIL with the
// decoder-strip-requirement marker (a.2-anti): a runtime engine-image edge
// re-bundles the decoder and regresses the AC-16 bundle delta.

import { decodeImageInBrowser } from '@forgeax/engine-image';

export async function loadTextureAsset(bytes: Uint8Array): Promise<unknown> {
  return decodeImageInBrowser(bytes, 'image/png', { colorSpace: 'srgb' });
}
