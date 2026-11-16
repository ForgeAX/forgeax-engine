/**
 * @forgeax/engine-codec
 *
 * Runtime-safe zstd decode + KTX2 container parse for the forgeax asset pipeline.
 * Build-time zstd encode lives in the `./encode` subpath.
 */

export type {
  BasisSourceInspection,
  BasisSourceMeta,
  PackedTextureLevel,
  PackedTranscodedTexture,
  TranscodeCheckpoint,
  TranscodedMip,
  TranscodedTexture,
} from './basis-transcoder.js';
export {
  compileBasisTranscoderWasm,
  compiledBasisHost,
  initBasisTranscoder,
  inspectBasisSource,
  packTranscodedTexture,
  transcodeBasis,
  transcodeKtx2,
  transcodeKtx2Packed,
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
export type { TextureTranscodeRequest } from './texture-transcode-task.js';
export { textureTranscodeTask, transcodeTexturePacked } from './texture-transcode-task.js';
export type {
  TranscodeCaps,
  TranscodeChannels,
  TranscodeModel,
  TranscodeSource,
  TranscodeTargetFormat,
} from './transcode.js';
export { selectTranscodeTarget } from './transcode.js';
export type { BasisWasmHost } from './wasm/basis-types.js';
export type { RetainedZstdBytes } from './zstd.js';
export {
  copyRetainedZstdBytes,
  decodeDocumentText,
  decompressRetainedZstd,
  decompressZstd,
  retainedZstdBytes,
} from './zstd.js';
