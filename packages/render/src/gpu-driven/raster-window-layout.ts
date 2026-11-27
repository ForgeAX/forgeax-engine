import type { BindGroup, BindGroupLayout, RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';

export interface RasterWindowLayout {
  readonly layout: BindGroupLayout;
  readonly index: number;
  readonly slots: readonly number[];
}

const families = new WeakMap<
  BindGroupLayout,
  {
    readonly entries: readonly GPUBindGroupLayoutEntry[];
    readonly layouts: Map<string, RasterWindowLayout>;
    readonly byReads: WeakMap<ReadonlyMap<number, number>, RasterWindowLayout | null>;
  }
>();
let nextLayoutIndex = 1;
const pipelines = new WeakMap<RenderPipeline, RasterWindowLayout>();
const windows = new WeakMap<BindGroup, RasterWindowLayout>();

export function retainRasterWindowFamily(
  layout: BindGroupLayout,
  entries: readonly GPUBindGroupLayoutEntry[],
): void {
  families.set(layout, { entries, layouts: new Map(), byReads: new WeakMap() });
}

export function projectRasterWindowLayout(
  device: Pick<RhiDevice, 'createBindGroupLayout'>,
  base: BindGroupLayout,
  reads: ReadonlyMap<number, number> | undefined,
): RasterWindowLayout | undefined {
  const family = families.get(base);
  if (reads === undefined || family === undefined) return undefined;
  const byIdentity = family.byReads.get(reads);
  if (byIdentity !== undefined) return byIdentity ?? undefined;
  const entries = family.entries.flatMap((entry) => {
    const visibility = reads.get(entry.binding);
    return visibility === undefined ? [] : [{ ...entry, visibility }];
  });
  if (entries.length !== reads.size)
    throw new Error('Selected scene-index entry reads a binding outside the raster window ABI');
  if (
    entries.length === family.entries.length &&
    entries.every((entry, index) => entry.visibility === family.entries[index]?.visibility)
  ) {
    family.byReads.set(reads, null);
    return undefined;
  }
  const key = entries.map(({ binding, visibility }) => `${binding}:${visibility}`).join(',');
  const cached = family.layouts.get(key);
  if (cached !== undefined) {
    family.byReads.set(reads, cached);
    return cached;
  }
  const result = {
    layout: device.createBindGroupLayout({ label: `gpu-scene-window[${key}]`, entries }).unwrap(),
    index: nextLayoutIndex++,
    slots: entries.map(({ binding }) => binding),
  };
  family.layouts.set(key, result);
  family.byReads.set(reads, result);
  return result;
}

export function retainPipelineRasterWindow(
  pipeline: RenderPipeline,
  layout: RasterWindowLayout | undefined,
): void {
  if (layout !== undefined) pipelines.set(pipeline, layout);
}

export function pipelineRasterWindow(pipeline: RenderPipeline): RasterWindowLayout | undefined {
  return pipelines.get(pipeline);
}

export function retainRasterWindow(group: BindGroup, layout: RasterWindowLayout): void {
  windows.set(group, layout);
}

export function rasterWindowLayout(group: BindGroup): RasterWindowLayout | undefined {
  return windows.get(group);
}
