import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { EMPTY_GPU_DRAW_SELECTION, type GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { type FrameList, rasterRowsOf } from '../scene/frame-list';
import { hasRasterDemand } from '../scene/raster-demand';

/** Immutable execution facts; each presentation callback supplies its own draw identity. */
export interface RenderableDrawReceipt {
  readonly pipeline?: import('@forgeax/engine-rhi').RenderPipeline;
  readonly programKey?: string;
  readonly material?: MaterialSnapshot;
  readonly passIndex?: number;
  readonly unsupportedLineage?: boolean;
  /** Exact Baked source closure selected by this actual Water geometry draw. */
  readonly waterBaked?: import('../world/view-draw-receipt').WaterBakedDrawReceiptFact;
  readonly lane: 'cpu' | 'gpu';
  readonly ready: boolean;
}

type PublishedMaterialProgram = NonNullable<
  MaterialSnapshot['materialPublication']
>['programs'][number];

/** Resolve the accepted publication entry that actually produced the selected shader. */
export function selectSubmittedMaterialProgram(
  programs: readonly PublishedMaterialProgram[] | undefined,
  hasPass: boolean,
  passIndex: number,
  submittedShader: string | undefined,
): PublishedMaterialProgram | undefined {
  if (submittedShader === undefined || programs === undefined) return undefined;
  if (hasPass) {
    const selected = programs[passIndex];
    return selected?.specializationKey === submittedShader ? selected : undefined;
  }
  let match: PublishedMaterialProgram | undefined;
  for (const program of programs) {
    if (program.specializationKey !== submittedShader) continue;
    if (match !== undefined) return undefined;
    match = program;
  }
  return match;
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
  if (selection === EMPTY_GPU_DRAW_SELECTION) return;
  for (const source of rows) {
    if (!hasRasterDemand(source)) continue;
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
  admitsCpu: (source: RenderableSnapshot) => boolean = () => true,
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
  for (const source of rasterRowsOf(renderables)) {
    if (!hasRasterDemand(source)) continue;
    const draws = source.gpuDrivenDraws;
    const admitsCpuDraw = admitsCpu(source);
    let gpuDraws = 0;
    let cpuDraws = 0;
    for (let index = 0; index < Math.max(1, draws?.length ?? 0); index++) {
      const draw = draws?.[index];
      if (draw !== undefined && selection.owns(source, draw, index)) {
        gpuDraws++;
        summary.gpuDraws++;
        summary.totalDraws++;
        continue;
      }
      if (!admitsCpuDraw) continue;
      cpuDraws++;
      summary.cpuDraws++;
      summary.totalDraws++;
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
