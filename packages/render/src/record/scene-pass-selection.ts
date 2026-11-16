import type { CameraSnapshot } from '../render-contract';
import type { ValidatedRenderable } from './frame-snapshot';

/** Closed owner-declared selections that can be re-read without a recorded frame. */
export type ScenePassSelection = 'camera-outline';

export type ScenePassSelectionCamera = Pick<CameraSnapshot, 'outline'>;

const EMPTY_ENTRIES: readonly ValidatedRenderable[] = Object.freeze([]);

type EntitySelection = { readonly entities: readonly number[] };

export function resolveScenePassSelection(
  selection: ScenePassSelection,
  camera: ScenePassSelectionCamera,
): EntitySelection {
  switch (selection) {
    case 'camera-outline':
      return { entities: camera.outline?.entities ?? [] };
  }
}

function selected(entry: ValidatedRenderable, selection: EntitySelection): boolean {
  return selection.entities.includes(entry.source.entityKey);
}

export function selectScenePassPipelineEntries(
  entries: readonly ValidatedRenderable[] | undefined,
  kind: ScenePassSelection | undefined,
  camera: ScenePassSelectionCamera | undefined,
): readonly ValidatedRenderable[] {
  const rows = entries ?? EMPTY_ENTRIES;
  if (kind === undefined || rows.length === 0) return rows;
  if (camera === undefined) return EMPTY_ENTRIES;
  const selection = resolveScenePassSelection(kind, camera);
  const first = rows[0];
  if (first !== undefined && rows.length === 1)
    return selected(first, selection) ? rows : EMPTY_ENTRIES;
  if (rows.every((entry) => selected(entry, selection))) return rows;
  return rows.filter((entry) => selected(entry, selection));
}
