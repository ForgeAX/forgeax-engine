import type { TimeResource } from '@forgeax/engine-ecs';
import type { MaterialRuntimeArtifact, MaterialShaderEntry } from '@forgeax/engine-shader';
import type { Asset, AssetHandle, MeshAsset, Result } from '@forgeax/engine-types';
import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import type { FrameReceipt, RenderFrameInput } from '../render-contract';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { TransparentSortConfig } from '../systems/transparent-sort-config';
import type { PublishedAssetPatch } from './asset-patch';
import type { PublishedCanvasFrame } from './canvas';
import type { PublishedRenderTarget, PublishedRenderTargetSource } from './targets';

/** Chosen by App before creating the receiver; never inferred from the first packet. */
export interface RenderPublicationIdentity {
  readonly source: string;
  readonly epoch: number;
}

/** Source-owned handle in the receiver's existing publication namespace. */
export interface PublishedMeshPreparation extends RenderPublicationIdentity {
  readonly meshHandle: AssetHandle<'mesh'>;
  readonly revision: number;
  readonly mesh: MeshAsset;
  /** Actual candidate draw facts; absent for standalone mesh-buffer residency. */
  readonly pipelinePreparation?: MeshPipelinePreparation;
}

/** Same producer snapshot/program vocabulary as a scene publication, without scene admission. */
export interface MeshPipelinePreparation {
  readonly materials: RenderPublication['materials'];
  readonly entity: number;
  readonly transform: RenderableSnapshot['transform'];
  readonly template: RenderPublicationTemplate;
  readonly programs: RenderPublication['programs'];
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
>;

export interface RenderPublicationTemplate {
  readonly snapshot: Omit<
    RenderableSnapshot,
    'worldId' | 'entityKey' | 'transform' | 'material' | 'materials' | 'materialOverrides'
  > & {
    readonly material: number;
    readonly materials: readonly number[];
    readonly materialOverrides?: readonly number[];
  };
  readonly dispatch: readonly Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>[];
}

/**
 * One publication as its source prepared it and its receiver decoded it. The
 * Worker boundary carries its `RenderPublicationMessage` encoding (`./record`):
 * the five columns share one record, and published mesh copies are owned.
 */
export interface RenderPublication extends RenderPublicationIdentity {
  readonly materials: readonly {
    readonly id: number;
    readonly value: import('../render-system-extract').MaterialSnapshot;
  }[];
  readonly retiredMaterials: readonly number[];
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
  readonly retiredJoints: Uint32Array;
  readonly transformEntities: Uint32Array;
  readonly transforms: Float32Array;
  readonly assets: readonly {
    readonly handle: number;
    readonly revision: number;
    readonly guid?: string;
    readonly sourceKey?: string;
    readonly value: Asset;
    /** Omission retains the accepted projection; null clears a previous program contract. */
    readonly materialProjection?:
      | import('@forgeax/engine-assets-runtime').MaterialRenderProjection
      | null;
    /**
     * Instead of `materialProjection`: adopt the projection already accepted for
     * this resident, non-retiring material handle.
     */
    readonly materialProjectionSource?: number;
  }[];
  /**
   * Mesh asset rows whose exact payload the receiver already holds from a
   * ready `mesh-prepare` residency for the same handle and revision. The
   * receiver adopts that prepared payload, so the bytes cross once.
   */
  readonly preparedAssets?: readonly {
    readonly handle: number;
    readonly revision: number;
    readonly guid?: string;
    readonly sourceKey?: string;
  }[];
  /** Fixed versions used by queued work, independent of the current asset rows. */
  readonly assetVersions?: readonly {
    readonly handle: number;
    readonly revision: number;
    readonly value: Asset;
  }[];
  readonly retiredAssetVersions?: readonly { readonly handle: number; readonly revision: number }[];
  readonly assetPatches: readonly PublishedAssetPatch[];
  readonly retiredAssets: readonly number[];
}

export interface PublishedRenderFrameInput {
  readonly publication: import('./record').RenderPublicationMessage;
  readonly geometryObservation?: true;
  /** Diagnostic identity of the World that produced this publication. The
   * transport's publication namespace is not an ECS World identity. */
  readonly geometryObservationSourceWorldIdentity?: string;
  readonly geometryLane?: RenderFrameInput['geometryLane'];
  /** Realm-local adapter invoked only after the feature's graph is submitted. */
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
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
