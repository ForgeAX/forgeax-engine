// @forgeax/engine-rhi-debug/src/recorder -- split recorder public seam.

export type {
  CreateShaderModuleFn,
  CreateShaderModuleImmediateFn,
  DebugRhiInstance,
} from './recorder/core';
export { PER_EVENT_OVERHEAD, TAPE_FORMAT_VERSION } from './recorder/core';
export type {
  CaptureFrameOptions,
  EncodedTape,
  RecordableBackend,
  RecorderAttachment,
  RecorderBackend,
  RecorderOptions,
} from './recorder/session';
export { attachRecorder } from './recorder/session';
export { wrapCreateShaderModule, wrapCreateShaderModuleImmediate } from './recorder/shader';
export { wrap } from './recorder/wrap';
