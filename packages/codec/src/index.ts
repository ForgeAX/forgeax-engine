/**
 * @forgeax/engine-codec
 *
 * Runtime-safe zstd decode + KTX2 container parse for the forgeax asset pipeline.
 * Build-time zstd encode lives in the `./encode` subpath.
 */

export type {
  BasisSourceInspection,
  BasisSourceMeta,
  TranscodedBasisTexture,
  TranscodedMip,
  TranscodedTexture,
} from './basis-transcoder.js';
export {
  initBasisTranscoder,
  inspectBasisSource,
  transcodeBasis,
  transcodeKtx2,
} from './basis-transcoder.js';
export type { CodecError, CodecErrorCode, CodecOk, CodecResult } from './errors.js';
export { codecError } from './errors.js';
export { KTX2_IDENTIFIER, ktx2ColorSpace, ktx2LevelsToRGBA, parseKtx2 } from './ktx2.js';
export type {
  TranscodeCaps,
  TranscodeChannels,
  TranscodeModel,
  TranscodeSource,
} from './transcode.js';
export { selectTranscodeTarget } from './transcode.js';
export type { BasisWasmHost } from './wasm/basis-types.js';
export { decompressZstd } from './zstd.js';
