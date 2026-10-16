import type { TimeResource } from '@forgeax/engine-ecs';
import type { MaterialRuntimeArtifact, MaterialShaderEntry } from '@forgeax/engine-shader';
import type { Asset, Handle, MeshAsset, Result } from '@forgeax/engine-types';
import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import type { FrameReceipt, RenderFrameInput } from '../render-contract';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { TransparentSortConfig } from '../systems/transparent-sort-config';
import type { PublishedCanvasFrame } from './canvas';
import type { PublishedRenderTarget, PublishedRenderTargetSource } from './targets';

/** Chosen by App before creating the receiver; never inferred from the first packet. */
export interface RenderPublicationIdentity {
  readonly source: string;
  readonly epoch: number;
}

/** Source-owned handle in the receiver's existing publication namespace. */
export interface PublishedMeshPreparation extends RenderPublicationIdentity {
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  readonly mesh: MeshAsset;
}

/** GPU residency only; source World and geometry candidate admission stay with the source. */
export interface PreparedPublishedMeshResidency {
  readonly deviceGeneration: number;
  isCurrent(): boolean;
  /** False transfers residency after source publication; true also cancels a pending transfer. */
  release(evict?: boolean): Promise<void> | undefined;
  /** Only the exact latest submitted frame can read its record-stage evidence. */
  recordStageLane(
    frame: FrameReceipt,
    entity: number,
  ): Result<DynamicGeometryRecordStageLane | undefined, RenderPublicationError>;
}

export type RenderPublicationMetadata = Omit<
  ExtractedFrame,
  | 'renderables'
  | 'dispatch'
  | 'visibilitySnapshots'
  | 'featureVisibilitySnapshots'
  | 'hiddenEntityReports'
  | 'shadowCasterEntityKeys'
  | 'shadowCasterDrawKeys'
  | 'shadowCasterMembership'
>;

export interface RenderPublicationTemplate {
  readonly snapshot: Omit<RenderableSnapshot, 'worldId' | 'entityKey' | 'transform'>;
  readonly dispatch: readonly Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>[];
}

/** Numeric storage and published mesh copies are owned; source buffers never transfer. */
export interface RenderPublication extends RenderPublicationIdentity {
  readonly revision: number;
  readonly base: number;
  readonly baseline: boolean;
  readonly time: TimeResource;
  readonly sampleTimeSeconds: number;
  readonly temporalReset: boolean;
  readonly transparentSort: TransparentSortConfig;
  readonly metadata: RenderPublicationMetadata;
  readonly templates: readonly RenderPublicationTemplate[];
  readonly canvasFrames?: readonly PublishedCanvasFrame[];
  readonly videoFrames: readonly {
    readonly entity: number;
    readonly clip: number;
    readonly frame: VideoFrame;
  }[];
  readonly targets: readonly PublishedRenderTarget[];
  readonly targetSources: readonly PublishedRenderTargetSource[];
  readonly features: readonly {
    readonly identity: string;
    readonly data: unknown;
    /** Sent once per accepted declaration; enable state remains per frame. */
    readonly fullscreen?: import('../features/fullscreen').FullscreenRenderFeatureDeclaration;
  }[];
  readonly programs: readonly {
    readonly key: string;
    readonly shader: MaterialShaderEntry;
    readonly artifact?: MaterialRuntimeArtifact;
  }[];
  /** entity, template index pairs. A publication source owns one World. */
  readonly upserts: Uint32Array;
  readonly removed: Uint32Array;
  readonly transformEntities: Uint32Array;
  readonly transforms: Float32Array;
  readonly assets: readonly {
    readonly handle: Handle<string, 'shared'>;
    readonly guid?: string;
    readonly sourceKey?: string;
    readonly value: Asset;
  }[];
  readonly retiredAssets: readonly Handle<string, 'shared'>[];
  readonly invalidatedAssets: readonly Handle<string, 'shared'>[];
}

export interface PublishedRenderFrameInput {
  readonly publication: RenderPublication;
  readonly geometryLane?: RenderFrameInput['geometryLane'];
  /** Realm-local adapter invoked only after the feature's graph is submitted. */
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
}

export function renderPublicationTransfers(packet: RenderPublication): ArrayBuffer[] {
  return [
    packet.upserts.buffer,
    packet.removed.buffer,
    packet.transformEntities.buffer,
    packet.transforms.buffer,
  ] as ArrayBuffer[];
}

/** Mesh copies stay with the receiver; only the four frame columns are recycled. */
export function renderPublicationAssetTransfers(packet: RenderPublication): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const collect = (value: unknown): void => {
    if (value instanceof ArrayBuffer) {
      buffers.add(value);
    } else if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child);
    }
  };
  for (const row of packet.assets) if (row.value.kind === 'mesh') collect(row.value);
  return [...buffers];
}

export type RenderPublicationFailure =
  | 'identity'
  | 'base'
  | 'revision'
  | 'shape'
  | 'unsupported'
  | 'in-flight'
  | 'disposed';

export class RenderPublicationError extends Error {
  readonly code = 'render-publication-invalid' as const;
  readonly expected = 'one valid publication for the bound source session and accepted base';
  readonly hint =
    'inspect detail.reason; repair the source or start a new session with a complete current baseline';
  constructor(
    readonly detail: { readonly reason: RenderPublicationFailure; readonly subject: string },
  ) {
    super(`render-publication-invalid: ${detail.reason}: ${detail.subject}`);
    this.name = 'RenderPublicationError';
  }
}
