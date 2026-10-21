import type { DispatchEntry, DispatchList, RenderableSnapshot } from '../render-system-extract';
import { renderableDrawKey } from '../scene/draw-key';
import type { FrameList } from '../scene/frame-list';

/** One retained index domain for auxiliary views and the display's selected draws. */
export function projectCaptureScene(
  retained: {
    readonly renderables: FrameList<RenderableSnapshot>;
    readonly dispatch: DispatchList;
  },
  visible: FrameList<RenderableSnapshot>,
  displayDispatch: DispatchList,
) {
  const renderables: RenderableSnapshot[] = [];
  const retainedIndices = new Map<number, number>();
  const identityIndices = new Map<string, number>();
  for (const [index, row] of retained.renderables.entries()) {
    if (row.authorVisible === false) continue;
    retainedIndices.set(index, renderables.length);
    identityIndices.set(renderableDrawKey(row), renderables.length);
    renderables.push(row);
  }
  const remap = (entries: DispatchList, indexFor: (index: number) => number | undefined) => {
    const result: DispatchEntry[] = [];
    for (const entry of entries) {
      const index = indexFor(entry.renderableIndex);
      if (index !== undefined) result.push({ ...entry, renderableIndex: index });
    }
    return result;
  };
  return {
    renderables,
    captureDispatch: remap(retained.dispatch, (index) => retainedIndices.get(index)),
    displayDispatch: remap(displayDispatch, (index) => {
      const row = visible.at(index);
      return row === undefined ? undefined : identityIndices.get(renderableDrawKey(row));
    }),
  };
}
