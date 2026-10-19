// @forgeax/engine-rhi-debug/src/types — RhiCallEvent closed union, Tape, work inspection types, RhiCapsRecorded.
//
// Shape:
// - RhiCallEvent: closed union (~40 kind incl. initialData + frameMark), each kind name 1:1 with RHI method name.
//   Query-set lifecycle, occlusion resolve and BLAS/TLAS calls are ordinary events;
//   timestamp writes and render-bundle execution remain deferred.
//   Includes: core RHI + copyExternalImageToTexture + clearBuffer (per IS-11).
// - Tape: header with formatVersion, rhiCapsRecorded, events array, blobPool map.
// - InspectReport: frameIdx, workIndex, bindings, drawCall, rt (path string, not inline base64).
// - RhiCapsRecorded: subset of RhiCaps relevant to cross-device replay.
//
// Related: requirements IS-3 / IS-5 / IS-11; plan-strategy §3.1 types.ts module + §8 naming conv.

/// <reference types="@webgpu/types" />

import type { recordReplayCapabilities } from './capabilities';

/**
 * Unique identifier for a recorded RHI handle within a tape.
 *
 * Encodes the type tag and raw numeric handle value into a single string
 * (e.g. "buffer:3", "texture:7"). forgeax Handle<T> brand types do not
 * collide across kinds (research F-1), so a single-level string key suffices.
 */
export type HandleId = string;

/** Closed set of canvas presentation color spaces a tape can record. */
export type RecordedCanvasColorSpace = 'srgb' | 'display-p3';

/**
 * Subset of RhiCaps recorded alongside each tape for cross-device replay
 * capability matching. Only the caps that affect rendering output are
 * included (not backendKind, compute, indirectDrawing, etc. — those do
 * not change the pixel output of a given RHI call sequence).
 *
 * Canvas format is included because it determines swap-chain format,
 * which affects color-attachment pixel encoding.
 */
export interface RhiCapsRecorded extends ReturnType<typeof recordReplayCapabilities> {
  readonly canvasFormat: GPUTextureFormat;
  /**
   * Presentation color space of the configured canvas, as reported by the
   * context after configure (absent report or no configure: `'srgb'`). The
   * surface bytes are encoded for this space; replay writes offscreen bytes.
   */
  readonly canvasColorSpace: RecordedCanvasColorSpace;
}

// ============================================================================
// RhiCallEvent — closed union (compound RHI operations use existing events)
// ============================================================================

/**
 * Marker event inserted at frame boundaries. Appears after all RHI calls
 * within frame N, before calls in frame N+1.
 *
 * Bootstrap-period calls (before the first frameMark) are assigned to frameIdx=0,
 * appearing before the `frameMark { frameIdx: 0 }` event (per AC-08 / Q&A q14).
 */
export interface RhiCallEventFrameMark {
  readonly kind: 'frameMark';
  readonly frameIdx: number;
}

// -- RhiDevice create* calls (each creates a resource, producing a HandleId) --

export interface RhiCallEventCreateBuffer {
  readonly kind: 'createBuffer';
  readonly handleId: HandleId;
  readonly desc: {
    readonly size: GPUSize64;
    readonly usage: GPUBufferUsageFlags;
    readonly mappedAtCreation?: boolean | undefined;
  };
}

export interface RhiCallEventCreateTexture {
  readonly kind: 'createTexture';
  readonly handleId: HandleId;
  /** Present only for a canvas swapchain texture synthesized from getCurrentTexture. */
  readonly origin?: 'swapchain' | undefined;
  readonly desc: {
    readonly size: GPUExtent3DStrict;
    readonly mipLevelCount?: number | undefined;
    readonly sampleCount?: number | undefined;
    readonly dimension?: GPUTextureDimension | undefined;
    readonly format: GPUTextureFormat;
    readonly usage: GPUTextureUsageFlags;
    readonly viewFormats?: Iterable<GPUTextureFormat> | undefined;
    readonly textureBindingViewDimension?: GPUTextureViewDimension | undefined;
  };
}

/** A successful GPUBuffer.destroy call observed while recording. */
export interface RhiCallEventDestroyBuffer {
  readonly kind: 'destroyBuffer';
  readonly handleId: HandleId;
}

/** A successful GPUTexture.destroy call observed while recording. */
export interface RhiCallEventDestroyTexture {
  readonly kind: 'destroyTexture';
  readonly handleId: HandleId;
}

export interface RhiCallEventCreateQuerySet {
  readonly kind: 'createQuerySet';
  readonly handleId: HandleId;
  readonly desc: Pick<GPUQuerySetDescriptor, 'label' | 'type' | 'count'>;
}

export interface RhiCallEventDestroyQuerySet {
  readonly kind: 'destroyQuerySet';
  readonly handleId: HandleId;
}

/** Geometry data of one BLAS build, with buffers named by tape handle. */
export interface RecordedBlasGeometry {
  readonly vertexBufferHandleId: HandleId;
  readonly firstVertex?: number | undefined;
  readonly vertexStride: number;
  readonly index?:
    | { readonly bufferHandleId: HandleId; readonly firstIndex?: number | undefined }
    | undefined;
}

export interface RecordedBlasBuild {
  readonly blasHandleId: HandleId;
  readonly geometries: readonly RecordedBlasGeometry[];
}

/** One TLAS instance; `transform` is the 3x4 row-major object-to-world matrix. */
export interface RecordedTlasInstance {
  readonly blasHandleId: HandleId;
  readonly transform: readonly number[];
  readonly customIndex: number;
  readonly mask: number;
}

export interface RecordedTlasBuild {
  readonly tlasHandleId: HandleId;
  readonly instances: readonly RecordedTlasInstance[];
}

export interface RhiCallEventCreateBlas {
  readonly kind: 'createBlas';
  readonly handleId: HandleId;
  readonly desc: {
    readonly label?: string | undefined;
    readonly geometries: readonly {
      readonly vertexFormat: 'float32x3';
      readonly vertexCount: number;
      readonly index?: { readonly format: GPUIndexFormat; readonly count: number } | undefined;
    }[];
    readonly preference?: 'fast-trace' | 'fast-build' | undefined;
    readonly updateMode?: 'rebuild' | 'refit' | undefined;
  };
  /**
   * Bootstrap records only: the last build observed before capture. Replay
   * rebuilds it from the geometry buffers' capture-start contents.
   */
  readonly build?: Pick<RecordedBlasBuild, 'geometries'> | undefined;
}

export interface RhiCallEventCreateTlas {
  readonly kind: 'createTlas';
  readonly handleId: HandleId;
  readonly desc: {
    readonly label?: string | undefined;
    readonly maxInstances: number;
    readonly preference?: 'fast-trace' | 'fast-build' | undefined;
    readonly updateMode?: 'rebuild' | 'refit' | undefined;
  };
  /** Bootstrap records only: the last instance list built before capture. */
  readonly build?: Pick<RecordedTlasBuild, 'instances'> | undefined;
}

export interface RhiCallEventDestroyBlas {
  readonly kind: 'destroyBlas';
  readonly handleId: HandleId;
}

export interface RhiCallEventDestroyTlas {
  readonly kind: 'destroyTlas';
  readonly handleId: HandleId;
}

export interface RhiCallEventCreateTextureView {
  readonly kind: 'createTextureView';
  readonly sourceHandleId: HandleId;
  readonly resultHandleId: HandleId;
  readonly desc: {
    readonly format?: GPUTextureFormat | undefined;
    readonly dimension?: GPUTextureViewDimension | undefined;
    readonly usage?: number | undefined;
    readonly aspect?: GPUTextureAspect | undefined;
    readonly baseMipLevel?: number | undefined;
    readonly mipLevelCount?: number | undefined;
    readonly baseArrayLayer?: number | undefined;
    readonly arrayLayerCount?: number | undefined;
  };
}

export interface RhiCallEventCreateSampler {
  readonly kind: 'createSampler';
  readonly handleId: HandleId;
  readonly desc?: Partial<GPUSamplerDescriptor> | undefined;
}

export interface RhiCallEventGetBindGroupLayout {
  readonly kind: 'getBindGroupLayout';
  readonly handleId: HandleId;
  readonly pipelineHandleId: HandleId;
  readonly index: number;
}

export interface RhiCallEventCreateBindGroupLayout {
  readonly kind: 'createBindGroupLayout';
  readonly handleId: HandleId;
  readonly desc: {
    readonly label?: string | undefined;
    readonly entries: Iterable<GPUBindGroupLayoutEntry>;
  };
}

/**
 * Resource kind discriminator stored alongside each createBindGroup
 * entry. Mirrors the closed RHI BindResource union (`sampler` /
 * `buffer` / `textureView` / `externalTexture` / `accelerationStructure`) so the inspector can
 * report the binding's true type without re-reading the BindGroupLayout
 * (I-8 fix, round 1 implement-review). Texture-view entries cover
 * cubemaps, 2D, 3D, and array textures — InspectBindingEntry.kind
 * narrows further into 'texture' (cubemap or otherwise) on the inspect
 * report side.
 */
export type RhiBindResourceKind =
  | 'sampler'
  | 'buffer'
  | 'textureView'
  | 'externalTexture'
  | 'accelerationStructure';

export interface RhiCallEventCreateBindGroup {
  readonly kind: 'createBindGroup';
  readonly handleId: HandleId;
  readonly layoutHandleId: HandleId;
  readonly entries: readonly {
    readonly binding: GPUBindGroupEntry['binding'];
    readonly resourceKind: RhiBindResourceKind;
    // Buffer bindings only: the sub-range the recording bound. A dynamic-offset
    // uniform/storage slice (`hasDynamicOffset` BGL entry) binds `size` bytes,
    // not the whole buffer; dropping these binds the entire buffer on replay,
    // which exceeds the device's uniform/storage binding-size limit and fails
    // createBindGroup. undefined = bind whole buffer from offset 0 (spec default).
    readonly bufferOffset?: number;
    readonly bufferSize?: number;
  }[];
  readonly resourceHandleIds: readonly HandleId[];
}

export interface RhiCallEventCreatePipelineLayout {
  readonly kind: 'createPipelineLayout';
  readonly handleId: HandleId;
  readonly bglHandleIds: readonly HandleId[];
}

export interface RhiCallEventCreateRenderPipeline {
  readonly kind: 'createRenderPipeline';
  readonly handleId: HandleId;
  readonly desc: {
    readonly label?: string;
    /** Serialized stage omits opaque shader module; the handle id is authoritative. */
    readonly vertex?: {
      readonly entryPoint?: string | undefined;
      readonly buffers: Iterable<GPUVertexBufferLayout | null | undefined>;
      readonly constants?: Record<string, number> | undefined;
    };
    readonly primitive?: GPUPrimitiveState | undefined;
    readonly depthStencil?: GPUDepthStencilState | undefined;
    readonly multisample?: GPUMultisampleState | undefined;
    /** Serialized stage omits opaque shader module; the handle id is authoritative. */
    readonly fragment?: {
      readonly entryPoint?: string | undefined;
      readonly targets: Iterable<GPUColorTargetState | null | undefined>;
      readonly constants?: Record<string, number> | undefined;
    };
  };
  readonly layoutHandleId: HandleId;
  /** HandleId of the re-created vertex shader module for cross-device binding. */
  readonly vertexShaderModuleHandleId?: HandleId | undefined;
  /** HandleId of the re-created fragment shader module for cross-device binding. */
  readonly fragmentShaderModuleHandleId?: HandleId | undefined;
}

export interface RhiCallEventCreateComputePipeline {
  readonly kind: 'createComputePipeline';
  readonly handleId: HandleId;
  readonly desc: {
    readonly label?: string;
    readonly compute: GPUProgrammableStage;
  };
  readonly layoutHandleId: HandleId;
  /** HandleId of the re-created compute shader module for cross-device binding. */
  readonly computeShaderModuleHandleId?: HandleId | undefined;
}

export interface RhiCallEventCreateShaderModule {
  readonly kind: 'createShaderModule';
  readonly handleId: HandleId;
  readonly wgslCode: string;
}

export interface RhiCallEventCreateCommandEncoder {
  readonly kind: 'createCommandEncoder';
  readonly cmdHandleId: HandleId;
  readonly desc?: Partial<GPUCommandEncoderDescriptor> | undefined;
}

// -- RhiQueue operations --

export interface RhiCallEventWriteBuffer {
  readonly kind: 'writeBuffer';
  readonly handleId: HandleId;
  readonly bufferOffset: number;
  readonly dataHash: string;
  readonly size: number;
}

export interface RhiCallEventWriteTexture {
  readonly kind: 'writeTexture';
  readonly destination: {
    readonly textureHandleId: HandleId;
    readonly mipLevel?: number | undefined;
    readonly origin?: GPUOrigin3D | undefined;
    readonly aspect?: GPUTextureAspect | undefined;
  };
  readonly dataHash: string;
  readonly dataLayout: {
    readonly offset?: number | undefined;
    readonly bytesPerRow?: number | undefined;
    readonly rowsPerImage?: number | undefined;
  };
  readonly size: GPUExtent3DStrict;
}

export interface RhiCallEventCopyExternalImageToTexture {
  readonly kind: 'copyExternalImageToTexture';
  readonly source: {
    readonly origin?: GPUOrigin2DStrict | undefined;
    readonly flipY?: boolean | undefined;
  };
  readonly destination: {
    readonly textureHandleId: HandleId;
    readonly mipLevel?: number | undefined;
    readonly origin?: GPUOrigin3D | undefined;
    readonly aspect?: GPUTextureAspect | undefined;
    readonly colorSpace?: PredefinedColorSpace | undefined;
    readonly premultipliedAlpha?: boolean | undefined;
  };
  readonly copySize: GPUExtent3DStrict;
}

export interface RhiCallEventSubmit {
  readonly kind: 'submit';
  readonly cmdHandleIds: readonly HandleId[];
}

// -- RhiCommandEncoder operations --

export interface RhiCallEventBeginRenderPass {
  readonly kind: 'beginRenderPass';
  readonly cmdHandleId: HandleId;
  readonly passHandleId: HandleId;
  readonly desc: {
    readonly label?: string | undefined;
    /** Attachment handles are replaced by the parallel HandleId arrays on replay. */
    readonly colorAttachments: Iterable<
      | {
          readonly view: unknown;
          readonly resolveTarget?: unknown;
          readonly [key: string]: unknown;
        }
      | null
      | undefined
    >;
    readonly depthStencilAttachment?:
      | {
          readonly view: unknown;
          readonly [key: string]: unknown;
        }
      | undefined;
    /** The opaque query set is represented by the parallel handle id below. */
    readonly timestampWrites?: Omit<GPURenderPassTimestampWrites, 'querySet'> | undefined;
    readonly maxDrawCount?: number | undefined;
  };
  readonly colorAttachmentViewHandleIds: readonly (HandleId | undefined)[];
  /**
   * Fresh-device handle identities for MSAA resolve targets. Optional for
   * backwards compatibility with tapes recorded before resolve capture was
   * added; those tapes retain their serialized descriptor behavior.
   */
  readonly colorAttachmentResolveTargetHandleIds?: readonly (HandleId | undefined)[];
  readonly depthStencilViewHandleId?: HandleId | undefined;
  readonly occlusionQuerySetHandleId?: HandleId | undefined;
  readonly timestampQuerySetHandleId?: HandleId | undefined;
}

export interface RhiCallEventBeginComputePass {
  readonly kind: 'beginComputePass';
  readonly timestampQuerySetHandleId?: HandleId | undefined;
  readonly cmdHandleId: HandleId;
  readonly passHandleId: HandleId;
  readonly desc?:
    | (Omit<Partial<GPUComputePassDescriptor>, 'timestampWrites'> & {
        readonly timestampWrites?: Omit<GPUComputePassTimestampWrites, 'querySet'> | undefined;
      })
    | undefined;
}

export interface RhiCallEventCopyBufferToBuffer {
  readonly kind: 'copyBufferToBuffer';
  readonly cmdHandleId: HandleId;
  readonly sourceHandleId: HandleId;
  readonly sourceOffset: number;
  readonly destinationHandleId: HandleId;
  readonly destinationOffset: number;
  readonly size: number;
}

export interface RhiCallEventCopyBufferToTexture {
  readonly kind: 'copyBufferToTexture';
  readonly cmdHandleId: HandleId;
  readonly source: Omit<GPUTexelCopyBufferInfo, 'buffer'> & { readonly bufferHandleId: HandleId };
  readonly destination: Omit<GPUTexelCopyTextureInfo, 'texture'> & {
    readonly textureHandleId: HandleId;
  };
  readonly copySize: GPUExtent3DStrict;
}

export interface RhiCallEventCopyTextureToBuffer {
  readonly kind: 'copyTextureToBuffer';
  readonly cmdHandleId: HandleId;
  readonly source: Omit<GPUTexelCopyTextureInfo, 'texture'> & {
    readonly textureHandleId: HandleId;
  };
  readonly destination: Omit<GPUTexelCopyBufferInfo, 'buffer'> & {
    readonly bufferHandleId: HandleId;
  };
  readonly copySize: GPUExtent3DStrict;
}

export interface RhiCallEventCopyTextureToTexture {
  readonly kind: 'copyTextureToTexture';
  readonly cmdHandleId: HandleId;
  readonly source: Omit<GPUTexelCopyTextureInfo, 'texture'> & {
    readonly textureHandleId: HandleId;
  };
  readonly destination: Omit<GPUTexelCopyTextureInfo, 'texture'> & {
    readonly textureHandleId: HandleId;
  };
  readonly copySize: GPUExtent3DStrict;
}

export interface RhiCallEventClearBuffer {
  readonly kind: 'clearBuffer';
  readonly cmdHandleId: HandleId;
  readonly handleId: HandleId;
  readonly offset?: number | undefined;
  readonly size?: number | undefined;
}

export interface RhiCallEventResolveQuerySet {
  readonly kind: 'resolveQuerySet';
  readonly cmdHandleId: HandleId;
  readonly querySetHandleId: HandleId;
  readonly firstQuery: number;
  readonly queryCount: number;
  readonly destinationHandleId: HandleId;
  readonly destinationOffset: number;
}

export interface RhiCallEventBuildAccelerationStructures {
  readonly kind: 'buildAccelerationStructures';
  readonly cmdHandleId: HandleId;
  readonly blas: readonly RecordedBlasBuild[];
  readonly tlas: readonly RecordedTlasBuild[];
}

export interface RhiCallEventPushDebugGroup {
  readonly kind: 'pushDebugGroup';
  readonly cmdHandleId: HandleId;
  readonly groupLabel: string;
}

export interface RhiCallEventPopDebugGroup {
  readonly kind: 'popDebugGroup';
  readonly cmdHandleId: HandleId;
}

export interface RhiCallEventInsertDebugMarker {
  readonly kind: 'insertDebugMarker';
  readonly cmdHandleId: HandleId;
  readonly markerLabel: string;
}

export interface RhiCallEventFinish {
  readonly kind: 'finish';
  readonly cmdHandleId: HandleId;
}

// -- RhiRenderPassEncoder operations --

export interface RhiCallEventSetPipeline {
  readonly kind: 'setPipeline';
  readonly passHandleId: HandleId;
  readonly pipelineHandleId: HandleId;
}

export interface RhiCallEventSetVertexBuffer {
  readonly kind: 'setVertexBuffer';
  readonly passHandleId: HandleId;
  readonly slot: number;
  readonly bufferHandleId: HandleId;
  readonly offset?: number | undefined;
  readonly size?: number | undefined;
}

export interface RhiCallEventSetIndexBuffer {
  readonly kind: 'setIndexBuffer';
  readonly passHandleId: HandleId;
  readonly bufferHandleId: HandleId;
  readonly format: 'uint16' | 'uint32';
  readonly offset?: number | undefined;
  readonly size?: number | undefined;
}

export interface RhiCallEventSetBindGroup {
  readonly kind: 'setBindGroup';
  readonly passHandleId: HandleId;
  readonly index: number;
  readonly bindGroupHandleId: HandleId;
  readonly dynamicOffsets?: readonly number[] | undefined;
}

export interface RhiCallEventDraw {
  readonly kind: 'draw';
  readonly passHandleId: HandleId;
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstVertex: number;
  readonly firstInstance: number;
}

export interface RhiCallEventDrawIndexed {
  readonly kind: 'drawIndexed';
  readonly passHandleId: HandleId;
  readonly indexCount: number;
  readonly instanceCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
}

export interface RhiCallEventSetViewport {
  readonly kind: 'setViewport';
  readonly passHandleId: HandleId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly minDepth: number;
  readonly maxDepth: number;
}

export interface RhiCallEventSetScissorRect {
  readonly kind: 'setScissorRect';
  readonly passHandleId: HandleId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RhiCallEventSetStencilReference {
  readonly kind: 'setStencilReference';
  readonly passHandleId: HandleId;
  readonly reference: number;
}

/** Native executeBundles state boundary; bundle commands are expanded in-place. */
export interface RhiCallEventResetRenderState {
  readonly kind: 'resetRenderState';
  readonly passHandleId: HandleId;
}

export interface RhiCallEventEndRenderPass {
  readonly kind: 'endRenderPass';
  readonly passHandleId: HandleId;
}

export interface RhiCallEventBeginOcclusionQuery {
  readonly kind: 'beginOcclusionQuery';
  readonly passHandleId: HandleId;
  readonly queryIndex: number;
}

export interface RhiCallEventEndOcclusionQuery {
  readonly kind: 'endOcclusionQuery';
  readonly passHandleId: HandleId;
}

export interface RhiCallEventSetBlendConstant {
  readonly kind: 'setBlendConstant';
  readonly passHandleId: HandleId;
  readonly color: GPUColor;
}

export interface RhiCallEventDrawIndirect {
  readonly kind: 'drawIndirect';
  readonly passHandleId: HandleId;
  readonly indirectBufferHandleId: HandleId;
  readonly indirectOffset: number;
}

export interface RhiCallEventDrawIndexedIndirect {
  readonly kind: 'drawIndexedIndirect';
  readonly passHandleId: HandleId;
  readonly indirectBufferHandleId: HandleId;
  readonly indirectOffset: number;
}

export interface RhiCallEventPassPushDebugGroup {
  readonly kind: 'passPushDebugGroup';
  readonly passHandleId: HandleId;
  readonly groupLabel: string;
}

export interface RhiCallEventPassPopDebugGroup {
  readonly kind: 'passPopDebugGroup';
  readonly passHandleId: HandleId;
}

export interface RhiCallEventPassInsertDebugMarker {
  readonly kind: 'passInsertDebugMarker';
  readonly passHandleId: HandleId;
  readonly markerLabel: string;
}

// -- RhiComputePassEncoder operations --

export interface RhiCallEventSetComputePipeline {
  readonly kind: 'setComputePipeline';
  readonly passHandleId: HandleId;
  readonly pipelineHandleId: HandleId;
}

export interface RhiCallEventDispatchWorkgroups {
  readonly kind: 'dispatchWorkgroups';
  readonly passHandleId: HandleId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RhiCallEventDispatchWorkgroupsIndirect {
  readonly kind: 'dispatchWorkgroupsIndirect';
  readonly passHandleId: HandleId;
  readonly indirectBufferHandleId: HandleId;
  readonly indirectOffset: number;
}

export interface RhiCallEventEndComputePass {
  readonly kind: 'endComputePass';
  readonly passHandleId: HandleId;
}

/**
 * Initial-data event representing a resource snapshot captured at recording start.
 *
 * handleId points to a resource declared by a prior create* event in the
 * bootstrap prefix. dataHash is a key into the tape's blobPool, where the
 * resource's actual GPU bytes (read back via copyToBuffer/mapAsync) are stored
 * with djb2 hash-dedup (D-1: reuse unified serialization path, no separate pool).
 *
 * The resource kind (buffer vs texture) and its shape are recorded in the
 * descriptor registry (snapshotResource reads it), not duplicated in this event
 * (architecture-principles #1 SSOT — avoid two sources for shape).
 */
export interface RhiCallEventInitialData {
  readonly kind: 'initialData';
  readonly handleId: HandleId;
  readonly dataHash: string;
}

/**
 * Closed union of all recordable RHI call events.
 *
 * v1 covers: core RHI methods + copyExternalImageToTexture + clearBuffer (IS-11).
 * Timestamp writes and render-bundle execution remain deferred; query-set
 * lifecycle, resolve, occlusion-query and BLAS/TLAS lifecycle and build events
 * are represented as ordinary events.
 *
 * Kinds are named 1:1 with RHI method names per plan-strategy §8 naming convention.
 * The frameMark kind is the only non-method event — it marks frame boundaries.
 */
export type RhiCallEvent =
  | RhiCallEventFrameMark
  | RhiCallEventCreateBuffer
  | RhiCallEventCreateTexture
  | RhiCallEventDestroyBuffer
  | RhiCallEventDestroyTexture
  | RhiCallEventCreateQuerySet
  | RhiCallEventDestroyQuerySet
  | RhiCallEventCreateBlas
  | RhiCallEventCreateTlas
  | RhiCallEventDestroyBlas
  | RhiCallEventDestroyTlas
  | RhiCallEventCreateTextureView
  | RhiCallEventCreateSampler
  | RhiCallEventCreateBindGroupLayout
  | RhiCallEventGetBindGroupLayout
  | RhiCallEventCreateBindGroup
  | RhiCallEventCreatePipelineLayout
  | RhiCallEventCreateRenderPipeline
  | RhiCallEventCreateComputePipeline
  | RhiCallEventCreateShaderModule
  | RhiCallEventCreateCommandEncoder
  | RhiCallEventWriteBuffer
  | RhiCallEventWriteTexture
  | RhiCallEventCopyExternalImageToTexture
  | RhiCallEventSubmit
  | RhiCallEventBeginRenderPass
  | RhiCallEventBeginComputePass
  | RhiCallEventCopyBufferToBuffer
  | RhiCallEventCopyBufferToTexture
  | RhiCallEventCopyTextureToBuffer
  | RhiCallEventCopyTextureToTexture
  | RhiCallEventClearBuffer
  | RhiCallEventResolveQuerySet
  | RhiCallEventBuildAccelerationStructures
  | RhiCallEventPushDebugGroup
  | RhiCallEventPopDebugGroup
  | RhiCallEventInsertDebugMarker
  | RhiCallEventFinish
  | RhiCallEventSetPipeline
  | RhiCallEventSetVertexBuffer
  | RhiCallEventSetIndexBuffer
  | RhiCallEventSetBindGroup
  | RhiCallEventDraw
  | RhiCallEventDrawIndexed
  | RhiCallEventSetViewport
  | RhiCallEventSetScissorRect
  | RhiCallEventSetStencilReference
  | RhiCallEventResetRenderState
  | RhiCallEventEndRenderPass
  | RhiCallEventBeginOcclusionQuery
  | RhiCallEventEndOcclusionQuery
  | RhiCallEventSetBlendConstant
  | RhiCallEventDrawIndirect
  | RhiCallEventDrawIndexedIndirect
  | RhiCallEventPassPushDebugGroup
  | RhiCallEventPassPopDebugGroup
  | RhiCallEventPassInsertDebugMarker
  | RhiCallEventSetComputePipeline
  | RhiCallEventDispatchWorkgroups
  | RhiCallEventDispatchWorkgroupsIndirect
  | RhiCallEventEndComputePass
  | RhiCallEventInitialData;

// ============================================================================
// Tape
// ============================================================================

/**
 * A recorded frame tape.
 *
 * Contains the sequence of RHI calls (events) plus a binary blob pool
 * for buffer data that is hash-deduplicated across events.
 *
 * formatVersion: integer version of the tape format. Mismatch with runtime
 *   version causes deserialize to reject with 'tape-format-version-mismatch'.
 * rhiCapsRecorded: the caps of the recording device for cross-device matching.
 * events: the ordered sequence of RHI call events including frameMark boundaries.
 * blobPool: hash-deduplicated binary data (buffer contents, shader source, etc).
 *   Keyed by hash string, valued as ArrayBuffer.
 */
export interface Tape {
  readonly formatVersion: number;
  readonly rhiCapsRecorded: RhiCapsRecorded;
  readonly events: readonly RhiCallEvent[];
  readonly blobPool: ReadonlyMap<string, ArrayBuffer>;
}

// ============================================================================
// InspectReport
// ============================================================================

/**
 * Information about a GPU binding group entry as seen at inspect time.
 */
export interface InspectBindingEntry {
  readonly groupIndex: number;
  readonly entryIndex: number;
  readonly handleId: HandleId;
  readonly kind: 'buffer' | 'texture' | 'sampler' | 'textureView' | 'accelerationStructure';
}

/**
 * Information about the work item at the inspected workIndex.
 */
export interface InspectDrawCall {
  readonly pipelineKind: 'render' | 'compute';
  readonly pipelineHandleId: HandleId;
  readonly vertexCount?: number | undefined;
  readonly instanceCount?: number | undefined;
  readonly indexCount?: number | undefined;
  readonly dispatchX?: number | undefined;
  readonly dispatchY?: number | undefined;
  readonly dispatchZ?: number | undefined;
  /** Present on `draw` — the first vertex offset (raw event field carried through). */
  readonly firstVertex?: number | undefined;
  /** Present on `drawIndexed` — index of the first element of the index buffer to read. */
  readonly firstIndex?: number | undefined;
  /** Present on `draw` and `drawIndexed` — the first instance for instanced rendering. */
  readonly firstInstance?: number | undefined;
  /** Present on `drawIndexed` — vertex offset added before indexing the vertex buffer. */
  readonly baseVertex?: number | undefined;
  /** Present on `drawIndirect` / `drawIndexedIndirect` — handle of the buffer holding the parameters. */
  readonly indirectBufferHandleId?: HandleId | undefined;
  /** Present on `drawIndirect` / `drawIndexedIndirect` — byte offset into the indirect buffer. */
  readonly indirectOffset?: number | undefined;
}

/**
 * Pipeline state for a single draw call, extracted from createRenderPipeline +
 * runtime events (pure event analysis, zero GPU). The seven WebGPU pipeline
 * stages the viewer's PipelineState panel renders; attached to InspectReport so
 * an AI `inspect-offline` call sees identical data. SSOT producer:
 * `makePipelineState` in inspect-core.ts; whole-frame producer: buildFrameModel.
 */
export interface DrawPipelineState {
  readonly inputAssembly: {
    readonly topology: GPUPrimitiveTopology;
    readonly stripIndexFormat: GPUIndexFormat | undefined;
  };
  readonly vertexInput: {
    readonly buffers: readonly {
      readonly arrayStride: number;
      readonly stepMode: GPUVertexStepMode;
      readonly attributes: readonly {
        readonly format: GPUVertexFormat;
        readonly offset: number;
        readonly shaderLocation: number;
      }[];
    }[];
  };
  readonly shaders: {
    readonly vertexShaderModuleHandleId: HandleId | undefined;
    readonly fragmentShaderModuleHandleId: HandleId | undefined;
    /** Active vertex entry point (a module may bundle several; this is the one this draw runs). */
    readonly vertexEntryPoint: string | undefined;
    /** Active fragment entry point — disambiguates a multi-entrypoint module (e.g. fs_main vs fs_gbuffer). */
    readonly fragmentEntryPoint: string | undefined;
  };
  readonly rasterizer: {
    readonly cullMode: GPUCullMode;
    readonly frontFace: GPUFrontFace;
  };
  readonly depthStencil: {
    readonly format: GPUTextureFormat;
    readonly depthWriteEnabled: boolean;
    readonly depthCompare: GPUCompareFunction;
    readonly stencilFront: NonNullable<GPUDepthStencilState['stencilFront']>;
    readonly stencilBack: NonNullable<GPUDepthStencilState['stencilBack']>;
    readonly stencilReadMask: number;
    readonly stencilWriteMask: number;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;
    readonly stencilReference: number;
  };
  readonly blend: {
    readonly colorTargets: readonly {
      readonly format: GPUTextureFormat;
      readonly color: GPUBlendComponent | undefined;
      readonly alpha: GPUBlendComponent | undefined;
      readonly writeMask: GPUColorWriteFlags;
    }[];
    readonly blendConstant: GPUColor | undefined;
  };
  readonly multisample: {
    readonly count: number;
    readonly mask: number;
    readonly alphaToCoverageEnabled: boolean;
  };
}

/**
 * A resource descriptor parsed from a create* event, discriminated by kind.
 * Consumed by the viewer's ResourceInspector panel and the cli `summary`
 * subcommand (via the FrameModel.resources map). SSOT producer: `buildResources`
 * in inspect-core.ts.
 */
export type CreateDescriptor =
  | {
      readonly kind: 'createBuffer';
      readonly handleId: HandleId;
      readonly size: GPUSize64;
      readonly usage: GPUBufferUsageFlags;
    }
  | {
      readonly kind: 'createTexture';
      readonly handleId: HandleId;
      readonly format: GPUTextureFormat;
      readonly size: readonly number[];
      readonly mipLevelCount: number;
      readonly sampleCount: number;
      readonly dimension: GPUTextureDimension;
      readonly usage: GPUTextureUsageFlags;
    }
  | {
      readonly kind: 'createSampler';
      readonly handleId: HandleId;
      readonly desc: Partial<GPUSamplerDescriptor> | undefined;
    }
  | {
      readonly kind: 'createBindGroupLayout';
      readonly handleId: HandleId;
      readonly entries: readonly GPUBindGroupLayoutEntry[];
    }
  | {
      readonly kind: 'createPipelineLayout';
      readonly handleId: HandleId;
      readonly bglHandleIds: readonly HandleId[];
    }
  | {
      readonly kind: 'createRenderPipeline';
      readonly handleId: HandleId;
      readonly vertex: GPUVertexState | undefined;
      readonly primitive: GPUPrimitiveState | undefined;
      readonly depthStencil: GPUDepthStencilState | undefined;
      readonly multisample: GPUMultisampleState | undefined;
      readonly fragment: GPUFragmentState | undefined;
      readonly layoutHandleId: HandleId;
      readonly vertexShaderModuleHandleId: HandleId | undefined;
      readonly fragmentShaderModuleHandleId: HandleId | undefined;
    }
  | { readonly kind: 'createShaderModule'; readonly handleId: HandleId; readonly wgslCode: string };

/**
 * Decoded RGBA8 pixels of the RT readback at the inspected draw call — the
 * structured RT payload produced by the node-free browser path (L3b
 * `inspectDrawJson`). `format` describes the native replay texels, so callers
 * can decode wide and floating-point attachments correctly. `pixels` are
 * tight-packed with row-alignment padding stripped.
 */
export interface InspectRtPixels {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly pixels: Uint8Array;
}

/**
 * The RT readback at the inspected draw call, in one of two genuinely
 * distinct forms keyed by execution environment:
 *
 * - `string` — a PNG **file path** on disk, produced by the DevKit Node shell
 *   after `rhi.inspect`, which encodes the readback to a PNG under the
 *   inspect/ output dir. Discriminate with `typeof rt === 'string'`.
 * - {@link InspectRtPixels} — the native `{ width, height, format, pixels }` tuple,
 *   produced by the node-free browser path (`inspectDrawJson`), which cannot
 *   write files and so hands back raw RGBA8 pixels. Discriminate with
 *   `typeof rt === 'object'` (or `'pixels' in rt`).
 *
 * AI users branch on `typeof` — the union is the single source of truth for
 * "what an `rt` field may hold", so no untyped-value cast is needed at either
 * producer.
 */
export type InspectRtPayload = string | InspectRtPixels;

/**
 * Structured report produced by inspectWork(replay, workIndex, fields?).
 *
 * frameIdx/workIndex/passIdx are **always present** — they identify the inspected
 * draw and are computed regardless of the `fields` selector.
 *
 * bindings/drawCall/rt are **field-cropped**: each is present only when the
 * `fields` selector includes its name, or when `fields` is undefined (full
 * report). When a field is not requested it is genuinely absent (the key is not
 * set), not assigned `undefined` (AC-12). AI users must narrow before reading
 * (`report.drawCall?.pipelineKind`, `if (report.bindings) …`).
 *
 * frameIdx: the frame index containing this draw call.
 * workIndex: the global work ordinal within the tape.
 * passIdx: the render/compute pass index containing this draw.
 * bindings: the bind group bindings active at this draw call (cropped: present
 *     when fields includes 'bindings' or is undefined).
 * drawCall: metadata about the draw/dispatch call itself (cropped: present when
 *     fields includes 'drawCall' or is undefined).
 * rt: the RT readback ({@link InspectRtPayload}) — a PNG file path string on
 *     the Node CLI path, or a decoded {width,height,pixels} object on the
 *     browser path. Cropped: present when fields includes 'rt' or is undefined
 *     (full report).
 * pipelineState: the seven WebGPU pipeline stages active at this draw
 *     ({@link DrawPipelineState}), derived from pure event analysis. Always
 *     present for render draws (never gated by `fields`); the AI sees the same
 *     pipeline state the viewer's PipelineState panel renders.
 */
export interface InspectReport {
  readonly frameIdx: number;
  readonly workIndex: number;
  readonly passIdx: number;
  readonly bindings?: readonly InspectBindingEntry[] | undefined;
  readonly drawCall?: InspectDrawCall | undefined;
  readonly rt?: InspectRtPayload | undefined;
  readonly pipelineState?: DrawPipelineState | undefined;
}

/**
 * Fields selector for inspectWork — controls which data is computed and returned.
 * An empty array means "minimum report" (frameIdx/workIndex/passIdx only).
 * undefined means "full report" (all fields including RT PNG).
 */
export type InspectFields = 'bindings' | 'drawCall' | 'rt';

/**
 * RHI commands that are known to be out-of-scope for current capture.
 *
 * These commands remain silent pass-throughs in the recorder (no pushEvent)
 * but are explicitly listed here so the coverage-invariant test can
 * distinguish "known-exempt" from "forgotten". New commands added to an
 * encoder interface that are not in this set AND have no RhiCallEvent kind
 * will cause the coverage-invariant .test-d.ts to fail at compile time.
 *
 * @internal
 */
export const DEFERRED_COMMANDS = new Set<string>(['writeTimestamp']);
