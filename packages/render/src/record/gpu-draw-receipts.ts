import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { skinLaneReason } from '../gpu-driven/production-raster-prepare';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';

/** Internal receipt for one concrete CPU/GPU presentation draw unit. */
export interface RenderableDrawReceipt {
  readonly pipeline?: import('@forgeax/engine-rhi').RenderPipeline;
  readonly programKey?: string;
  readonly material?: MaterialSnapshot;
  readonly passIndex?: number;
  readonly unsupportedLineage?: boolean;
  readonly lane: 'cpu' | 'gpu';
  readonly ready: boolean;
}

export interface GpuDrawSummary {
  gpuDraws: number;
  gpuEntities: number;
  mixedEntities: number;
  totalDraws: number;
  cpuDraws: number;
  semanticDraws: number;
  deformationDraws: number;
  blockedDraws: number;
  readonly deformationReasons: ReadonlyMap<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >;
}

/** Emit requested draw observations after submission; no per-entity selection table is retained. */
export function emitGpuDrivenDrawReceipts(
  renderables: FrameList<RenderableSnapshot>,
  selection: GpuDrawSelection,
  onRenderableDraw: (
    entry: { readonly source: RenderableSnapshot },
    submeshIndex: number,
    receipt: RenderableDrawReceipt,
  ) => void,
): GpuDrawSummary {
  const deformationReasons = new Map<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >();
  const summary: GpuDrawSummary = {
    gpuDraws: 0,
    gpuEntities: 0,
    mixedEntities: 0,
    totalDraws: 0,
    cpuDraws: 0,
    semanticDraws: 0,
    deformationDraws: 0,
    blockedDraws: 0,
    deformationReasons,
  };
  for (const source of renderables) {
    const draws = source.gpuDrivenDraws;
    let gpuDraws = 0;
    let cpuDraws = 0;
    for (let index = 0; index < Math.max(1, draws?.length ?? 0); index++) {
      const draw = draws?.[index];
      summary.totalDraws++;
      if (draw !== undefined && selection.owns(source, draw, index)) {
        gpuDraws++;
        summary.gpuDraws++;
        onRenderableDraw({ source }, gpuDrivenSourceDrawItemIndex(draw, index), {
          lane: 'gpu',
          ready: true,
        });
        continue;
      }
      cpuDraws++;
      summary.cpuDraws++;
      const skinReason = skinLaneReason(source);
      if (skinReason !== undefined || draw?.preparationError?.detail.owner === 'skin') {
        const reason =
          skinReason ??
          (draw?.preparationError?.detail.reason === 'skin-address-missing'
            ? 'skin-address-missing'
            : 'resource-not-ready');
        summary.deformationDraws++;
        deformationReasons.set(reason, (deformationReasons.get(reason) ?? 0) + 1);
      } else if (
        draw?.preparationError?.detail.recovery === 'route-cpu-lane' ||
        draw?.preparationError === undefined
      ) {
        summary.semanticDraws++;
      } else summary.blockedDraws++;
    }
    if (gpuDraws > 0) summary.gpuEntities++;
    if (gpuDraws > 0 && cpuDraws > 0) summary.mixedEntities++;
  }
  return summary;
}
