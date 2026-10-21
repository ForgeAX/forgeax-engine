import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';

/** Keep the accepted roster intact until the candidate is accepted. */
export function projectTextureConsumers<T>(
  previous: Map<number, readonly T[]>,
  removed: ReadonlySet<number>,
  rows: FrameList<RenderableSnapshot>,
  collect: (materials: readonly MaterialSnapshot[]) => readonly T[] | undefined,
): Map<number, readonly T[]> {
  let next = previous;
  for (const entity of removed) {
    if (!next.has(entity)) continue;
    if (next === previous) next = new Map(previous);
    next.delete(entity);
  }
  for (const row of rows) {
    const sources = collect(row.materials.map((material) => material.snapshot));
    if (sources === undefined && !next.has(row.entityKey)) continue;
    if (next === previous) next = new Map(previous);
    if (sources === undefined) next.delete(row.entityKey);
    else next.set(row.entityKey, sources);
  }
  return next;
}

export function materialVideoClips(materials: readonly MaterialSnapshot[]) {
  let clips: Set<number> | undefined;
  for (const material of materials) {
    const fields = material.videoTextureFields;
    if (fields === undefined) continue;
    for (const clip of fields.values()) {
      clips ??= new Set();
      clips.add(clip);
    }
  }
  return clips === undefined ? undefined : [...clips];
}

export function materialCanvasSources(materials: readonly MaterialSnapshot[]) {
  let sources: Set<CanvasTextureSource> | undefined;
  for (const material of materials) {
    const fields = material.textureSources;
    if (fields === undefined) continue;
    for (const source of fields.values()) {
      if (!isCanvasTextureSource(source)) continue;
      sources ??= new Set();
      sources.add(source);
    }
  }
  return sources === undefined ? undefined : [...sources];
}
