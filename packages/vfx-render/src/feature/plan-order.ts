/** Indices [start, end) one emitter group occupies in each of a plan's work arrays. */
export interface GroupDeclarationRanges {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

export interface KeyedDeclarationRanges extends GroupDeclarationRanges {
  readonly key: string;
}

/** Frame passes [start, end) one admitted tick of a stream wrote. */
export interface TickPassRange {
  readonly sequence: number;
  start: number;
  end: number;
}

export function compareKeys(left: { readonly key: string }, right: { readonly key: string }) {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Groups were declared in sorted arena-owner order. Restore each array to the
 * original group order and return the new index of every frame-array entry.
 */
export function restoreGroupDeclarationOrder<T>(
  arrays: readonly T[][],
  ranges: ReadonlyMap<string, GroupDeclarationRanges>,
  groups: readonly { readonly key: string }[],
): Map<number, number> {
  const frameIndices = new Map<number, number>();
  for (let index = 0; index < arrays.length; index++) {
    const array = arrays[index] as (typeof arrays)[number];
    const current = [...array];
    let destination = 0;
    for (const group of groups) {
      const range = ranges.get(group.key);
      if (range === undefined) continue;
      for (
        let source = range.starts[index] as number;
        source < (range.ends[index] as number);
        source++
      ) {
        if (index === 0) frameIndices.set(source, destination);
        array[destination++] = current[source] as T;
      }
    }
  }
  return frameIndices;
}

/** Follow restored frame passes so tick ranges keep addressing their own commands. */
export function remapTickPassRanges(
  ranges: TickPassRange[],
  frameIndices: ReadonlyMap<number, number>,
): void {
  for (const range of ranges) {
    range.start = frameIndices.get(range.start) ?? range.start;
    range.end = (frameIndices.get(range.end - 1) ?? range.end - 1) + 1;
  }
  ranges.sort((left, right) => left.start - right.start);
}

/**
 * Programs own storage, not execution order. Reorder complete tick blocks
 * only when a stream switches programs in this plan. Other stream slots and
 * the ordinary same-program compute chain retain their original order.
 */
export function reorderStreamTickBlocks<T>(
  passes: T[],
  streams: Iterable<{ readonly ranges: TickPassRange[] | undefined }>,
): void {
  let replacements: Map<number, { end: number; passes: readonly T[] }> | undefined;
  for (const stream of streams) {
    if (stream.ranges === undefined) continue;
    const ordered = [...stream.ranges].sort((left, right) => left.sequence - right.sequence);
    if (ordered.every((range, index) => range === stream.ranges?.[index])) continue;
    for (let index = 0; index < stream.ranges.length; index++) {
      const range = stream.ranges[index] as (typeof stream.ranges)[number];
      const replacement = ordered[index];
      if (replacement === undefined) continue;
      replacements ??= new Map();
      replacements.set(range.start, {
        end: range.end,
        passes: passes.slice(replacement.start, replacement.end),
      });
    }
  }
  if (replacements === undefined) return;
  const ordered: T[] = [];
  for (let index = 0; index < passes.length; ) {
    const replacement = replacements.get(index);
    if (replacement === undefined) {
      ordered.push(passes[index] as T);
      index++;
    } else {
      ordered.push(...replacement.passes);
      index = replacement.end;
    }
  }
  passes.splice(0, passes.length, ...ordered);
}

/**
 * Preserve each group's original resource dependency order while keeping
 * group declarations stable through queued/retained churn.
 */
export function sortGroupDeclarations<T>(
  arrays: readonly T[][],
  ranges: readonly KeyedDeclarationRanges[],
): void {
  const orderedRanges = [...ranges].sort(compareKeys);
  if (orderedRanges.every((range, index) => range === ranges[index])) return;
  for (let arrayIndex = 0; arrayIndex < arrays.length; arrayIndex++) {
    const array = arrays[arrayIndex] as (typeof arrays)[number];
    const original = [...array];
    let destination = 0;
    for (const range of orderedRanges)
      for (
        let index = range.starts[arrayIndex] as number;
        index < (range.ends[arrayIndex] as number);
        index++
      )
        array[destination++] = original[index] as T;
  }
}
