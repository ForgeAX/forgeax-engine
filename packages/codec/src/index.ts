/**
 * @forgeax/engine-codec
 *
 * Runtime-safe zstd decode + KTX2 container parse for the forgeax asset pipeline.
 * Build-time zstd encode lives in the `./encode` subpath.
 */

export type {
  BasisSourceInspection,
  BasisSourceMeta,
  TranscodedMip,
  TranscodedTexture,
} from './basis-transcoder.js';
export {
  initBasisTranscoder,
  inspectBasisSource,
  transcodeBasis,
  transcodeKtx2,
} from './basis-transcoder.js';
export type {
  CodecError,
  CodecErrorCode,
  CodecOk,
  CodecResult,
  Ktx2NativeRejection,
} from './errors.js';
export { codecError } from './errors.js';
export type {
  Ktx2NativeFormat,
  Ktx2NativeInspection,
  Ktx2Parsed,
} from './ktx2.js';
export {
  decodeBc5ToRg8,
  inspectKtx2Native,
  KTX2_IDENTIFIER,
  ktx2Bc5SourceMismatch,
  ktx2ChannelLanes,
  ktx2ColorSpace,
  ktx2IsNative,
  ktx2LevelsToRGBA,
  ktx2NativeFormat,
  ktx2NativeTexture,
  parseKtx2,
} from './ktx2.js';
export type {
  TranscodeCaps,
  TranscodeChannels,
  TranscodeModel,
  TranscodeSource,
  TranscodeTargetFormat,
} from './transcode.js';
export { selectTranscodeTarget } from './transcode.js';
export type { BasisWasmHost } from './wasm/basis-types.js';
export { decodeDocumentText, decompressZstd } from './zstd.js';
