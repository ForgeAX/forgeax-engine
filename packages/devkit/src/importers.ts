import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf/node-importer';
import { videoImporter } from '@forgeax/engine-graphics-extras/video-importer';
import { createNodeImageEncoderPool } from '@forgeax/engine-image/encode-pool';
import { createImageImporter, imageImporter } from '@forgeax/engine-image/image-importer';
import { iesImporter } from '@forgeax/engine-import';
import { objImporter, stlImporter, svgImporter } from '@forgeax/engine-mesh-io';
import type { Importer } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';

export const DEFAULT_IMPORTERS: readonly Importer[] = [
  audioImporter,
  imageImporter,
  fbxImporter,
  gltfImporter,
  objImporter,
  stlImporter,
  svgImporter,
  fontImporter,
  iesImporter,
  videoImporter,
  createUiImporter(),
];

/** Own native encoder workers for one build/dev session, preserving custom importer isolation. */
export function createSessionImporters(importers: readonly Importer[] = DEFAULT_IMPORTERS): {
  readonly importers: readonly Importer[];
  dispose(): Promise<void>;
} {
  if (!importers.includes(imageImporter)) return { importers, async dispose() {} };
  let pool: ReturnType<typeof createNodeImageEncoderPool>;
  try {
    pool = createNodeImageEncoderPool();
  } catch (error) {
    // Default admission may be too small for one worker. Serial encoding is still native.
    if (
      error instanceof RangeError &&
      error.message === 'Image encoder requires one GiB worker reserve and bounded source memory'
    )
      return { importers, async dispose() {} };
    throw error;
  }
  const image = createImageImporter({
    encode: pool.encode.bind(pool),
    maxInFlight: pool.maxWorkers,
  });
  return {
    importers: importers.map((row) => (row === imageImporter ? image : row)),
    dispose: () => pool.dispose(),
  };
}
