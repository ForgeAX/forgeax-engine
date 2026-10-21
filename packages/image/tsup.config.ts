import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/parse-image.ts',
    'src/hdr-decoder.ts',
    'src/decode-image-from-file.ts',
    'src/image-importer.ts',
    'src/ktx2-encode.ts',
    'src/png-encoder.ts',
  ],
  // Node-only decode and encode dependencies stay outside the browser-safe root entry.
  external: [
    '@forgeax/engine-codec',
    '@forgeax/engine-codec/encode',
    '@forgeax/engine-pack',
    '@forgeax/engine-types',
    'upng-js',
    'jpeg-js',
  ],
});
