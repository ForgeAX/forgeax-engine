import type { RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';

type Members<T> = Map<number, readonly T[]>;
export interface TextureConsumerRoster<T> {
  readonly size: number;
  forEach(visit: (sources: readonly T[], entity: number) => void): void;
}

/** The candidate exclusively stages edits. Removals followed by reinsertion
 * append in publication order, just as they do in the accepted Map. */
export class TextureConsumerEdits<T> implements TextureConsumerRoster<T> {
  private readonly updated = new Map<number, readonly T[] | undefined>();
  private readonly appended: Members<T> = new Map();
  size: number;

  constructor(private readonly accepted: Members<T>) {
    this.size = accepted.size;
  }

  get(entity: number): readonly T[] | undefined {
    return (
      this.appended.get(entity) ??
      (this.updated.has(entity) ? this.updated.get(entity) : this.accepted.get(entity))
    );
  }

  set(entity: number, before: readonly T[] | undefined, after: readonly T[] | undefined): void {
    if (before === undefined) this.size++;
    if (after === undefined) this.size--;
    if (this.appended.has(entity) || before === undefined) {
      if (after === undefined) this.appended.delete(entity);
      else this.appended.set(entity, after);
    } else this.updated.set(entity, after);
  }

  forEach(visit: (sources: readonly T[], entity: number) => void): void {
    this.accepted.forEach((sources, entity) => {
      if (!this.updated.has(entity)) visit(sources, entity);
      else {
        const changed = this.updated.get(entity);
        if (changed !== undefined) visit(changed, entity);
      }
    });
    this.appended.forEach(visit);
  }

  accept(): void {
    for (const [entity, sources] of this.updated) {
      if (sources === undefined) this.accepted.delete(entity);
      else this.accepted.set(entity, sources);
    }
    this.appended.forEach((sources, entity) => {
      this.accepted.set(entity, sources);
    });
  }
}

type Candidate<T> = Members<T> | TextureConsumerEdits<T>;

function sameMembers<T>(
  before: readonly T[] | undefined,
  values: ReadonlySet<T> | undefined,
): boolean {
  if (before === undefined) return !values?.size;
  if (values === undefined || values.size !== before.length) return false;
  let index = 0;
  for (const value of values) if (value !== before[index++]) return false;
  return true;
}

function stageMembers<T>(
  next: Candidate<T>,
  entity: number,
  values?: ReadonlySet<T>,
): Candidate<T> {
  const before = next.get(entity);
  if (sameMembers(before, values)) return next;
  const edits = next instanceof TextureConsumerEdits ? next : new TextureConsumerEdits(next);
  edits.set(entity, before, values?.size ? [...values] : undefined);
  return edits;
}

/** Read each material once for both media kinds. Only changed membership
 * lists survive the row; video and Canvas retain their own publication order. */
export function projectTextureConsumers(
  acceptedVideos: Members<number>,
  acceptedCanvases: Members<CanvasTextureSource>,
  removed: ReadonlySet<number>,
  rows: FrameList<RenderableSnapshot>,
) {
  let videos: Candidate<number> = acceptedVideos;
  let canvases: Candidate<CanvasTextureSource> = acceptedCanvases;
  for (const entity of removed) {
    videos = stageMembers(videos, entity);
    canvases = stageMembers(canvases, entity);
  }
  let clips: Set<number> | undefined;
  let sources: Set<CanvasTextureSource> | undefined;
  for (const row of rows) {
    clips?.clear();
    sources?.clear();
    for (const resource of row.materials) {
      const material = resource.snapshot;
      const videoFields = material.videoTextureFields;
      if (videoFields !== undefined) {
        clips ??= new Set();
        for (const clip of videoFields.values()) clips.add(clip);
      }
      const fields = material.textureSources;
      if (fields !== undefined) {
        sources ??= new Set();
        for (const source of fields.values())
          if (isCanvasTextureSource(source)) sources.add(source);
      }
    }
    videos = stageMembers(videos, row.entityKey, clips);
    canvases = stageMembers(canvases, row.entityKey, sources);
  }
  return { videos, canvases };
}
