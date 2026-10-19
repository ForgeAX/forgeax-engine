import type { RawCommandEncoderLike, RawComputePassLike } from '../command-encoder';
import type { RawRenderCommandsLike, RawRenderPassLike } from '../render-pass-encoder';

function unexpected(): never {
  throw new Error('Unexpected native command in this fixture');
}

const renderCommands: RawRenderCommandsLike = {
  setPipeline: unexpected,
  setVertexBuffer: unexpected,
  setIndexBuffer: unexpected,
  setBindGroup: unexpected,
  draw: unexpected,
  drawIndexed: unexpected,
  drawIndirect: unexpected,
  drawIndexedIndirect: unexpected,
  pushDebugGroup: unexpected,
  popDebugGroup: unexpected,
  insertDebugMarker: unexpected,
};

export function rawRenderPass(overrides: Partial<RawRenderPassLike> = {}): RawRenderPassLike {
  return {
    ...renderCommands,
    end: unexpected,
    setViewport: unexpected,
    setScissorRect: unexpected,
    setBlendConstant: unexpected,
    setStencilReference: unexpected,
    executeBundles: unexpected,
    beginOcclusionQuery: unexpected,
    endOcclusionQuery: unexpected,
    ...overrides,
  };
}

export function rawComputePass(overrides: Partial<RawComputePassLike>): RawComputePassLike {
  return {
    setPipeline: unexpected,
    setBindGroup: unexpected,
    dispatchWorkgroups: unexpected,
    dispatchWorkgroupsIndirect: unexpected,
    end: unexpected,
    ...overrides,
  };
}

export function rawCommandEncoder(
  overrides: Partial<RawCommandEncoderLike> = {},
): RawCommandEncoderLike {
  return {
    beginRenderPass: unexpected,
    beginComputePass: unexpected,
    copyBufferToBuffer: unexpected,
    copyBufferToTexture: unexpected,
    copyTextureToBuffer: unexpected,
    copyTextureToTexture: unexpected,
    clearBuffer: unexpected,
    resolveQuerySet: unexpected,
    pushDebugGroup: unexpected,
    popDebugGroup: unexpected,
    insertDebugMarker: unexpected,
    finish: unexpected,
    ...overrides,
  };
}
