import type { CameraSnapshot } from '../render-contract';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';

/** Closed owner-declared selections that can be re-read without a recorded frame. */
export type ScenePassSelection =
  | 'camera-outline'
  | 'camera-outline-distance'
  | 'camera-outline-focus'
  | 'camera-outline-accent'
  | 'camera-outline-large';

export type ScenePassSelectionCamera = Pick<CameraSnapshot, 'outline'>;

const EMPTY_ENTRIES: DrawRows = Object.freeze([]);

type EntitySelection = { readonly entities: readonly number[] };

export function resolveScenePassSelection(
  selection: ScenePassSelection,
  camera: ScenePassSelectionCamera,
): EntitySelection {
  switch (selection) {
    case 'camera-outline':
      return { entities: camera.outline?.distanceField ? [] : (camera.outline?.entities ?? []) };
    case 'camera-outline-distance':
      return { entities: camera.outline?.distanceField ? (camera.outline.entities ?? []) : [] };
    case 'camera-outline-focus':
      return {
        entities: camera.outline?.distanceField ? (camera.outline.focusedEntities ?? []) : [],
      };
    case 'camera-outline-accent':
      return {
        entities: camera.outline?.distanceField ? (camera.outline.accentEntities ?? []) : [],
      };
    case 'camera-outline-large':
      return {
        entities: camera.outline?.distanceField ? (camera.outline.largeEntities ?? []) : [],
      };
  }
}

function selected(entry: ValidatedRenderable, selection: EntitySelection): boolean {
  return selection.entities.includes(entry.source.entityKey);
}

export function selectScenePassPipelineEntries(
  entries: DrawRows | undefined,
  kind: ScenePassSelection | undefined,
  camera: ScenePassSelectionCamera | undefined,
): DrawRows {
  const rows = entries ?? EMPTY_ENTRIES;
  if (kind === undefined || rows.length === 0) return rows;
  if (camera === undefined) return EMPTY_ENTRIES;
  const selection = resolveScenePassSelection(kind, camera);
  const first = rows.at(0);
  if (first !== undefined && rows.length === 1)
    return selected(first, selection) ? rows : EMPTY_ENTRIES;
  if (rows.every((entry) => selected(entry, selection))) return rows;
  return rows.filter((entry) => selected(entry, selection));
}
