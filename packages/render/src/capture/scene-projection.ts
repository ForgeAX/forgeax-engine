import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { renderableDrawKey } from '../scene/draw-key';

/** One retained index domain for auxiliary views and the display's selected draws. */
export function projectCaptureScene(
  retained: {
    readonly renderables: readonly RenderableSnapshot[];
    readonly dispatch: readonly DispatchEntry[];
  },
  visible: readonly RenderableSnapshot[],
  displayDispatch: readonly DispatchEntry[],
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
  const remap = (
    entries: readonly DispatchEntry[],
    indexFor: (index: number) => number | undefined,
  ) =>
    entries.flatMap((entry) => {
      const index = indexFor(entry.renderableIndex);
      return index === undefined ? [] : [{ ...entry, renderableIndex: index }];
    });
  return {
    renderables,
    captureDispatch: remap(retained.dispatch, (index) => retainedIndices.get(index)),
    displayDispatch: remap(displayDispatch, (index) => {
      const row = visible[index];
      return row === undefined ? undefined : identityIndices.get(renderableDrawKey(row));
    }),
  };
}
