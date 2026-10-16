/**
 * @forgeax/engine-codec/encode
 *
 * Build-time encoding subpath: zstd compression + Basis KTX2 texture encode.
 * Gated from runtime import by `check-image-pipeline-isolation.mjs` path d.
 */

export {
  _setZstdEncoderImporter,
  compressZstd,
} from '../encode-impl.js';
export type { BasisEncodeMode, BasisEncodeOptions } from './basis-encode.js';
export {
  _setBasisEncoderImporter,
  basisEncode,
  initBasisEncoder,
} from './basis-encode.js';
