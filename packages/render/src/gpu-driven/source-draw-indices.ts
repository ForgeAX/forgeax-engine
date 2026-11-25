import type { GpuDrivenDrawSnapshot } from '../extract/gpu-driven';

type Draws = readonly GpuDrivenDrawSnapshot[];
type SectionOrder = 'dense' | 'ascending' | ReadonlyMap<number, number>;
// The table's static content owns this index. A dense or ascending mesh adds
// no per-section storage, and no source table is retained by its index.
const issued = new WeakMap<Draws, SectionOrder>();

/** Seal a newly owned table and establish its declared source addresses. */
export function sealSourceDraws(draws: GpuDrivenDrawSnapshot[]): Draws {
  let dense = true,
    ascending = true,
    valid = true,
    previous = -1;
  for (let i = 0; i < draws.length; i++) {
    const draw = draws[i];
    if (draw === undefined) {
      valid = false;
      continue;
    }
    Object.freeze(draw);
    const section = draw.drawItemIndex;
    if (section === undefined || !Number.isSafeInteger(section) || section < 0) {
      valid = false;
      continue;
    }
    if (section !== i) dense = false;
    if (section <= previous) ascending = false;
    previous = section;
  }
  Object.freeze(draws);
  if (valid) {
    if (dense || ascending) issued.set(draws, dense ? 'dense' : 'ascending');
    else indexReorderedSections(draws);
  }
  return draws;
}

function indexReorderedSections(draws: Draws): void {
  const index = new Map<number, number>();
  for (let i = 0; i < draws.length; i++) {
    const section = (draws[i] as GpuDrivenDrawSnapshot).drawItemIndex as number;
    // Legacy lanes differ on first/last duplicate. Preserve both contracts.
    if (index.has(section)) return;
    index.set(section, i);
  }
  issued.set(draws, index);
}

/** Undefined keeps the caller's legacy interpretation; -1 is a proven missing section. */
export function issuedSectionIndex(draws: Draws | undefined, section: number): number | undefined {
  if (draws === undefined) return undefined;
  const order = issued.get(draws);
  if (order === undefined) return undefined;
  if (!Number.isInteger(section) || section < 0) return -1;
  if (order === 'dense') return section < draws.length ? section : -1;
  if (order !== 'ascending') return order.get(section) ?? -1;
  let begin = 0,
    end = draws.length;
  while (begin < end) {
    const middle = begin + Math.floor((end - begin) / 2);
    const source = (draws[middle] as GpuDrivenDrawSnapshot).drawItemIndex as number;
    if (source === section) return middle;
    if (source < section) begin = middle + 1;
    else end = middle;
  }
  return -1;
}

export function compactSourceDrawAt(draws: Draws | undefined, section: number): number {
  return (
    issuedSectionIndex(draws, section) ??
    draws?.findIndex((draw, index) => (draw.drawItemIndex ?? index) === section) ??
    -1
  );
}

/** Surface extraction observes a borrowed table's original first-match lookup. */
export function sourceDrawForSection(
  draws: Draws | undefined,
  section: number,
): GpuDrivenDrawSnapshot | undefined {
  const index = issuedSectionIndex(draws, section);
  if (index === undefined) return draws?.find((draw, i) => (draw.drawItemIndex ?? i) === section);
  return index < 0 ? undefined : draws?.[index];
}
