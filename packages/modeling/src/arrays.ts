/**
 * Reductions and appends over arrays of any length. `Math.max(...a)` and `a.push(...b)`
 * pass every element as a call argument, so a large mesh throws a RangeError (or crosses
 * the engine's argument limit) where these loops do not. Results match the spread forms:
 * the same pairwise `Math.max`/`Math.min`, so NaN and signed zero agree.
 */
export function maxOf(values: Iterable<number>): number {
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) result = Math.max(result, value);
  return result;
}

export function minOf(values: Iterable<number>): number {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) result = Math.min(result, value);
  return result;
}

export function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}

export function replaceAll<T>(target: T[], items: Iterable<T>): void {
  target.length = 0;
  for (const item of items) target.push(item);
}
