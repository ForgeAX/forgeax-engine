import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf/node-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
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
  createUiImporter(),
];
