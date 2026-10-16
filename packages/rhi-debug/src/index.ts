// @forgeax/engine-rhi-debug/src/index.ts -- v7 public contract.
//
// AI cold-start path: one .rhitape ArtifactRef, one FrameModel workIndex, and one
// fresh ReplaySession. Consumers should use structured Result errors and keep
// browser, Node, and backend ownership at their host boundaries.

export type { BindingAccess } from './binding-access';
export {
  type BufferFieldType,
  type BufferRecordLayout,
  type BufferRecords,
  type BufferScalar,
  decodeBufferRecords,
  inspectBufferRecords,
} from './buffer-records';
export {
  createRhiDebugError,
  type RhiDebugError,
  type RhiDebugErrorCode,
  type RhiDebugErrorDetail,
  type RhiDebugErrorFor,
} from './errors';
export type {
  CommandEntry,
  FrameModel,
  FramePass,
  JsonValue,
  ResourceConsumer,
  ResourceEntry,
  WorkAccelerationStructure,
  WorkBinding,
  WorkEntry,
  WorkPipeline,
} from './frame-model';
export {
  buildFrameModel,
  buildResourceLifecycle,
  type ResourceByteEstimate,
  type ResourceKind,
  type ResourceLifecycleEntry,
  type ResourceLifecycleSummary,
} from './frame-model';
export { type FrameSummary, summarizeFrame } from './frame-summary';
export {
  type AtlasTile,
  type DepthProjection,
  type DisplayOptions,
  decodeImage,
  depthImage,
  encodePng,
  extractTile,
  type FloatImage,
  type ImageLayout,
  type ImageStats,
  imageStats,
  readbackImage,
  toRgba8,
} from './image';
export type { UnseededResource } from './initial-contents';
export type { TapeBlobEntry, TapeContainerIndex } from './protocol/codec';
export {
  decodeTape,
  decodeTapeContainerIndex,
  digestBytes as tapeDigest,
  encodeTape,
  readTapePreamble,
  TAPE_PREAMBLE_BYTES,
} from './protocol/codec';
export type { EventCategory, EventSemantics } from './protocol/event-semantics';
export {
  EVENT_SEMANTICS,
  eventKinds,
  isWorkEvent,
  resourceKindForEvent,
  workEventKinds,
} from './protocol/event-semantics';
export type {
  TapeIndex,
  TapePassEntry,
  TapeResourceEntry,
  TapeWorkEntry,
} from './protocol/tape-index';
export { buildTapeIndex } from './protocol/tape-index';
export type {
  BootstrapResource,
  InitialDataSlice,
  RhiCallEvent as V7RhiCallEvent,
  RhiCapsRecorded as V7RhiCapsRecorded,
  RhiDebugResult,
  Tape as V7Tape,
  TapeBlob as V7TapeBlob,
  TapeBlobCompression,
  TapeEncodeOptions,
} from './protocol/types';
export {
  TAPE_FORMAT_VERSION as V7_TAPE_FORMAT_VERSION,
  TAPE_MAGIC,
} from './protocol/types';
export { readbackTexturePixels } from './readback';
export {
  attachRecorder,
  type CaptureFrameOptions,
  type CreateShaderModuleFn,
  type CreateShaderModuleImmediateFn,
  type EncodedTape,
  type RecordableBackend,
  type RecorderAttachment,
  type RecorderBackend,
  type RecorderOptions,
  type TapeArtifact,
  tapeArtifact,
} from './recorder/session';
export { replayDeviceRequest, usesAccelerationStructures } from './replay/device-request';
export {
  type BatchReadRequest,
  type BatchReadResults,
  bindingReadRequest,
  type FrameTiming,
  type InspectField,
  openReplay,
  type PassTiming,
  type ReadbackSubresource,
  type ReplayBackend,
  type ReplayReadbackResult,
  type ReplaySession,
  type TextureSubresource,
  type WorkInspection,
  type WorkOutput,
  type WorkOutputRead,
  workOutputs,
} from './replay/session';
export { decodeTexelRaw, decodeToRgba8, halfToFloat } from './texel-decode';
export {
  bytesPerTexel,
  type ChannelType,
  type FormatInfo,
  formatInfo,
} from './texel-layout';
