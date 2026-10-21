// @forgeax/engine-rhi-debug/src/types — RhiCallEvent closed union, Tape, RhiCapsRecorded.
//
// Shape:
// - RhiCallEvent: closed union (~40 kind incl. initialData + frameMark), each kind name 1:1 with RHI method name.
//   Query-set lifecycle, occlusion resolve and BLAS/TLAS calls are ordinary events;
//   timestamp writes and render-bundle execution remain deferred.
//   Includes: core RHI + copyExternalImageToTexture + clearBuffer (per IS-11).
// - Tape: header with formatVersion, rhiCapsRecorded, events array, blobPool map.
// - RhiCapsRecorded: subset of RhiCaps relevant to cross-device replay.
//
// Related: requirements IS-3 / IS-5 / IS-11; plan-strategy §3.1 types.ts module + §8 naming conv.

/// <reference types="@webgpu/types" />

import type { BlasDescriptor, TlasDescriptor } from '@forgeax/engine-rhi';
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
type RecordedCanvasColorSpace = 'srgb' | 'display-p3';

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
interface RhiCallEventFrameMark {
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

interface RhiCallEventCreateTexture {
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
interface RhiCallEventDestroyBuffer {
  readonly kind: 'destroyBuffer';
  readonly handleId: HandleId;
}

/** A successful GPUTexture.destroy call observed while recording. */
interface RhiCallEventDestroyTexture {
  readonly kind: 'destroyTexture';
  readonly handleId: HandleId;
}

interface RhiCallEventCreateQuerySet {
  readonly kind: 'createQuerySet';
  readonly handleId: HandleId;
  readonly desc: Pick<GPUQuerySetDescriptor, 'label' | 'type' | 'count'>;
}

interface RhiCallEventDestroyQuerySet {
  readonly kind: 'destroyQuerySet';
  readonly handleId: HandleId;
}

/** Geometry data of one BLAS build, with buffers named by tape handle. */
interface RecordedBlasGeometry {
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

interface RhiCallEventCreateBlas {
  readonly kind: 'createBlas';
  readonly handleId: HandleId;
  readonly desc: BlasDescriptor;
  /**
   * Bootstrap records only: the last build observed before capture. Replay
   * rebuilds it from the geometry buffers' capture-start contents.
   */
  readonly build?: Pick<RecordedBlasBuild, 'geometries'> | undefined;
}

interface RhiCallEventCreateTlas {
  readonly kind: 'createTlas';
  readonly handleId: HandleId;
  readonly desc: TlasDescriptor;
  /** Bootstrap records only: the last instance list built before capture. */
  readonly build?: Pick<RecordedTlasBuild, 'instances'> | undefined;
}

interface RhiCallEventDestroyBlas {
  readonly kind: 'destroyBlas';
  readonly handleId: HandleId;
}

interface RhiCallEventDestroyTlas {
  readonly kind: 'destroyTlas';
  readonly handleId: HandleId;
}

interface RhiCallEventCreateTextureView {
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

interface RhiCallEventCreateSampler {
  readonly kind: 'createSampler';
  readonly handleId: HandleId;
  readonly desc?: Partial<GPUSamplerDescriptor> | undefined;
}

interface RhiCallEventGetBindGroupLayout {
  readonly kind: 'getBindGroupLayout';
  readonly handleId: HandleId;
  readonly pipelineHandleId: HandleId;
  readonly index: number;
}

interface RhiCallEventCreateBindGroupLayout {
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

interface RhiCallEventCreateBindGroup {
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

interface RhiCallEventCreatePipelineLayout {
  readonly kind: 'createPipelineLayout';
  readonly handleId: HandleId;
  readonly bglHandleIds: readonly HandleId[];
}

interface RhiCallEventCreateRenderPipeline {
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

interface RhiCallEventCreateComputePipeline {
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

interface RhiCallEventCreateShaderModule {
  readonly kind: 'createShaderModule';
  readonly handleId: HandleId;
  readonly wgslCode: string;
}

interface RhiCallEventCreateCommandEncoder {
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

interface RhiCallEventCopyExternalImageToTexture {
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

interface RhiCallEventSubmit {
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

interface RhiCallEventBeginComputePass {
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

interface RhiCallEventCopyBufferToTexture {
  readonly kind: 'copyBufferToTexture';
  readonly cmdHandleId: HandleId;
  readonly source: Omit<GPUTexelCopyBufferInfo, 'buffer'> & { readonly bufferHandleId: HandleId };
  readonly destination: Omit<GPUTexelCopyTextureInfo, 'texture'> & {
    readonly textureHandleId: HandleId;
  };
  readonly copySize: GPUExtent3DStrict;
}

interface RhiCallEventCopyTextureToBuffer {
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

interface RhiCallEventCopyTextureToTexture {
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

interface RhiCallEventResolveQuerySet {
  readonly kind: 'resolveQuerySet';
  readonly cmdHandleId: HandleId;
  readonly querySetHandleId: HandleId;
  readonly firstQuery: number;
  readonly queryCount: number;
  readonly destinationHandleId: HandleId;
  readonly destinationOffset: number;
}

interface RhiCallEventBuildAccelerationStructures {
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

interface RhiCallEventPopDebugGroup {
  readonly kind: 'popDebugGroup';
  readonly cmdHandleId: HandleId;
}

export interface RhiCallEventInsertDebugMarker {
  readonly kind: 'insertDebugMarker';
  readonly cmdHandleId: HandleId;
  readonly markerLabel: string;
}

interface RhiCallEventFinish {
  readonly kind: 'finish';
  readonly cmdHandleId: HandleId;
}

// -- RhiRenderPassEncoder operations --

export interface RhiCallEventSetPipeline {
  readonly kind: 'setPipeline';
  readonly passHandleId: HandleId;
  readonly pipelineHandleId: HandleId;
}

interface RhiCallEventSetVertexBuffer {
  readonly kind: 'setVertexBuffer';
  readonly passHandleId: HandleId;
  readonly slot: number;
  readonly bufferHandleId: HandleId;
  readonly offset?: number | undefined;
  readonly size?: number | undefined;
}

interface RhiCallEventSetIndexBuffer {
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

interface RhiCallEventSetStencilReference {
  readonly kind: 'setStencilReference';
  readonly passHandleId: HandleId;
  readonly reference: number;
}

/** Native executeBundles state boundary; bundle commands are expanded in-place. */
interface RhiCallEventResetRenderState {
  readonly kind: 'resetRenderState';
  readonly passHandleId: HandleId;
}

interface RhiCallEventEndRenderPass {
  readonly kind: 'endRenderPass';
  readonly passHandleId: HandleId;
}

interface RhiCallEventBeginOcclusionQuery {
  readonly kind: 'beginOcclusionQuery';
  readonly passHandleId: HandleId;
  readonly queryIndex: number;
}

interface RhiCallEventEndOcclusionQuery {
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

interface RhiCallEventPassPopDebugGroup {
  readonly kind: 'passPopDebugGroup';
  readonly passHandleId: HandleId;
}

export interface RhiCallEventPassInsertDebugMarker {
  readonly kind: 'passInsertDebugMarker';
  readonly passHandleId: HandleId;
  readonly markerLabel: string;
}

// -- RhiComputePassEncoder operations --

interface RhiCallEventSetComputePipeline {
  readonly kind: 'setComputePipeline';
  readonly passHandleId: HandleId;
  readonly pipelineHandleId: HandleId;
}

interface RhiCallEventDispatchWorkgroups {
  readonly kind: 'dispatchWorkgroups';
  readonly passHandleId: HandleId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface RhiCallEventDispatchWorkgroupsIndirect {
  readonly kind: 'dispatchWorkgroupsIndirect';
  readonly passHandleId: HandleId;
  readonly indirectBufferHandleId: HandleId;
  readonly indirectOffset: number;
}

interface RhiCallEventEndComputePass {
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
