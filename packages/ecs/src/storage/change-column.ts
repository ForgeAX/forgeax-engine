// @forgeax/engine-ecs — change epochs stored beside the rows they describe.

/** Rows per summary chunk: one max epoch covers 64 consecutive rows. */
export const CHANGE_CHUNK_SHIFT = 6;

/**
 * Per-row last-write epochs plus a conservative summary. `chunks[k]` bounds
 * every epoch in rows `[k * 64, k * 64 + 64)`; `max` bounds the whole column.
 * Summaries only grow: a removed row leaves its bound high, which costs one
 * extra scan of its chunk and never hides a change.
 */
export interface ChangeColumn {
  epochs: Float64Array;
  chunks: Float64Array;
  max: number;
}

export function createChangeColumn(capacity: number): ChangeColumn {
  return {
    epochs: new Float64Array(capacity),
    chunks: new Float64Array((capacity + 63) >>> CHANGE_CHUNK_SHIFT),
    max: 0,
  };
}

/** Stamp one row. Epochs only move forward, so the bounds take a plain max. */
export function stampChange(column: ChangeColumn, row: number, epoch: number): void {
  column.epochs[row] = epoch;
  const chunk = row >>> CHANGE_CHUNK_SHIFT;
  if (epoch > (column.chunks[chunk] as number)) column.chunks[chunk] = epoch;
  if (epoch > column.max) column.max = epoch;
}

/** Stamp `count` consecutive rows from `start` with one epoch. */
export function stampChangeRange(
  column: ChangeColumn,
  start: number,
  count: number,
  epoch: number,
): void {
  if (count <= 0) return;
  const epochs = column.epochs;
  for (let row = start, end = start + count; row < end; row++) epochs[row] = epoch;
  const first = start >>> CHANGE_CHUNK_SHIFT;
  const last = (start + count - 1) >>> CHANGE_CHUNK_SHIFT;
  for (let chunk = first; chunk <= last; chunk++)
    if (epoch > (column.chunks[chunk] as number)) column.chunks[chunk] = epoch;
  if (epoch > column.max) column.max = epoch;
}

/** Copy one row's epoch into another row, e.g. a swap-remove. */
export function moveChange(column: ChangeColumn, to: number, from: number): void {
  const epoch = column.epochs[from] as number;
  column.epochs[to] = epoch;
  const chunk = to >>> CHANGE_CHUNK_SHIFT;
  if (epoch > (column.chunks[chunk] as number)) column.chunks[chunk] = epoch;
}

/** Grow the row arrays; summaries are copied, so no bound is lost. */
export function growChangeColumn(column: ChangeColumn, capacity: number): ChangeColumn {
  const epochs = new Float64Array(capacity);
  epochs.set(column.epochs);
  const chunks = new Float64Array((capacity + 63) >>> CHANGE_CHUNK_SHIFT);
  chunks.set(column.chunks);
  return { epochs, chunks, max: column.max };
}
