import type { GraphBuffer } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { PipelineState } from '../record/render-context';
import type { FramePresentationPendingReason } from '../render-contract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { LiveRasterBatch } from './live-raster';
import type { GpuDrivenPrepareInput } from './production-raster';
import type { ProjectedRasterClass } from './production-raster-classes';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import type { FilteredProductionPlan, PreparedProductionPlan } from './production-raster-prepare';
import type { ShadowViewStatePool } from './shadow-views';
import type { GpuDrivenView } from './view-gpu';

/** Everything one accepted GPU-lane preparation retains for graph projection and commit. */
export interface RasterProjectionFrame {
  readonly input: GpuDrivenPrepareInput;
  readonly scene: PersistentGpuDrivenState;
  readonly materialPipelineState: PipelineState;
  readonly filtered: FilteredProductionPlan;
  readonly shadowFiltered: FilteredProductionPlan | undefined;
  readonly liveRasterBatches: readonly LiveRasterBatch[];
  readonly view: GpuDrivenView;
  readonly shadowViewPool: ShadowViewStatePool;
  readonly materialRaster: MaterialAbiRasterAdapter;
  readonly skinRaster: MaterialAbiRasterAdapter | undefined;
  readonly viewClipping: string;
  readonly viewClippingLive: boolean;
}
export interface PreparedRasterFrame extends RasterProjectionFrame {
  readonly materials: GpuSceneResourceFrame;
  readonly preparedPlan: PreparedProductionPlan;
}

/** Attachment facts one graph projection compiles its raster classes against. */
export interface RasterGraphTarget {
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly rendererRecording: boolean;
  readonly colorFormats: readonly TextureFormat[];
  readonly colorFormatKey: string | undefined;
}

/** One graph projection: its compiled classes and the late region added afterwards. */
export interface ProjectedRasterGraph {
  readonly frame: RasterProjectionFrame;
  readonly target: RasterGraphTarget;
  readonly indirect: GraphBuffer;
  readonly rasterClasses: Map<string, ProjectedRasterClass>;
  lateRegion: { readonly indirectByteOffset: number; readonly visibleBase: number } | undefined;
}

export interface PipelinePreparationJob {
  prepare(
    entries: readonly ValidatedRenderable[],
    artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    onPending?: (reason: FramePresentationPendingReason) => void,
    materials?: import('../scene/material-dispatch').MaterialFrame,
  ): boolean;
  sourceRequests(batches: readonly LiveRasterBatch[]): Iterable<() => boolean>;
}
