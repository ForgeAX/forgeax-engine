import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
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

/** Emit the GPU receipts of the given rows' owned draws; CPU draws receipt themselves. */
export function emitGpuDrivenDrawReceipts(
  rows: Iterable<RenderableSnapshot>,
  selection: GpuDrawSelection,
  onRenderableDraw: (
    entry: { readonly source: RenderableSnapshot },
    submeshIndex: number,
    receipt: RenderableDrawReceipt,
  ) => void,
): void {
  for (const source of rows) {
    const draws = source.gpuDrivenDraws;
    if (draws === undefined) continue;
    for (let index = 0; index < draws.length; index++) {
      const draw = draws[index];
      if (draw !== undefined && selection.owns(source, draw, index))
        onRenderableDraw({ source }, gpuDrivenSourceDrawItemIndex(draw, index), {
          lane: 'gpu',
          ready: true,
        });
    }
  }
}

/** Lane counters of one submitted frame; a pure function of its rows and selection. */
export function summarizeGpuDrivenDraws(
  renderables: FrameList<RenderableSnapshot>,
  selection: GpuDrawSelection,
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
        continue;
      }
      cpuDraws++;
      summary.cpuDraws++;
      if (draw?.preparationError?.detail.owner === 'skin') {
        const reason =
          draw?.preparationError?.detail.reason === 'skin-address-missing'
            ? 'skin-address-missing'
            : 'resource-not-ready';
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
