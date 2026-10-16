import type { derive } from '@forgeax/engine-types';

type Layout = ReturnType<typeof derive>;
type Ranges = { readonly values: readonly number[]; readonly dynamic: readonly number[] };
const rangesByLayout = new WeakMap<Layout, Ranges>();

/** The packer's immutable derivation owns byte coverage, including mutable schema replacement. */
export function materialUniformComparisonRanges(layout: Layout): Ranges {
  const cached = rangesByLayout.get(layout);
  if (cached !== undefined) return cached;
  const values: number[] = [];
  for (const entry of layout.uboLayout.entries) values.push(entry.offset / 4, entry.size / 4);
  const dynamic = [0, 3];
  for (const record of layout.coordinateRecords) dynamic.push(record.offset / 4, record.size / 4);
  const result = { values: [...values, ...dynamic], dynamic };
  rangesByLayout.set(layout, result);
  return result;
}

export function materialUniformWordsDiffer(
  current: Uint32Array,
  previous: Uint32Array,
  offset: number,
  ranges?: readonly number[],
): boolean {
  if (ranges === undefined) {
    for (let word = 0; word < current.length; word++)
      if (current[word] !== previous[offset + word]) return true;
  } else {
    for (let index = 0; index < ranges.length; index += 2) {
      const start = ranges[index] ?? 0;
      const end = start + (ranges[index + 1] ?? 0);
      for (let word = start; word < end; word++)
        if (current[word] !== previous[offset + word]) return true;
    }
  }
  return false;
}
