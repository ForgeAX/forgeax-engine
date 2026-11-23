import type { GpuTableWrites } from '../../gpu-table-writes';

export interface ClusterWordChange {
  readonly id: symbol;
  readonly base: symbol | undefined;
  readonly first: number;
  readonly end: number;
  readonly runs?: readonly number[];
}

type Words = Int32Array | Uint32Array;

const PAGE_WORDS = 256;

interface PagedWords {
  readonly length: number;
  readonly pages: readonly Int32Array[];
  readonly contiguous: Int32Array | undefined;
}

// Keep the seven largest gaps. Filling small gaps costs less than another queue write;
// streams with widely separated edits can still write just the touched words.
class ClusterWordEdits {
  private after: number;
  private gaps: number[] | undefined;
  constructor(private readonly first: number) {
    this.after = first;
  }

  add(first: number, end: number): void {
    const gap = first - this.after;
    if (gap >= 64) this.keepGap(first, gap);
    this.after = end;
  }

  private keepGap(first: number, length: number): void {
    this.gaps ??= [];
    const gaps = this.gaps;
    if (gaps.length === 14) {
      let least = 0;
      for (let i = 2; i < 14; i += 2)
        if (
          (gaps[i + 1] as number) - (gaps[i] as number) <
          (gaps[least + 1] as number) - (gaps[least] as number)
        )
          least = i;
      if (length <= (gaps[least + 1] as number) - (gaps[least] as number)) return;
      gaps.copyWithin(least, least + 2);
      gaps.length -= 2;
    }
    gaps.push(this.after, first);
  }

  publish(base: symbol): ClusterWordChange {
    const runs = this.gaps;
    if (runs !== undefined) {
      runs.unshift(this.first);
      runs.push(this.after);
      return { id: Symbol(), base, first: this.first, end: this.after, runs };
    }
    return { id: Symbol(), base, first: this.first, end: this.after };
  }
}

/** Compare actual words once. The page publisher receives only physically changed pages. */
export function describeClusterWords(
  current: Words,
  length: number,
  previous?: Words | PagedWords,
  prior?: ClusterWordChange,
  changedPage?: (page: number, start: number, end: number) => void,
): ClusterWordChange {
  if (previous === undefined || prior === undefined) {
    if (changedPage !== undefined)
      for (let start = 0; start < length; start += PAGE_WORDS)
        changedPage(start / PAGE_WORDS, start, Math.min(length, start + PAGE_WORDS));
    return { id: Symbol(), base: undefined, first: 0, end: length };
  }
  const flat = ArrayBuffer.isView(previous) ? previous : previous.contiguous;
  const pages = flat === undefined && 'pages' in previous ? previous.pages : undefined;
  let edits: ClusterWordEdits | undefined;
  for (let start = 0; start < length; start += PAGE_WORDS) {
    const page = start / PAGE_WORDS,
      end = Math.min(start + PAGE_WORDS, length);
    const words = flat ?? pages?.[page];
    const offset = flat === undefined ? -start : 0;
    let first = start,
      after = end;
    if (words !== undefined) {
      const common = Math.min(end, previous.length);
      while (first < common && current[first] === words[offset + first]) first++;
      if (first === end) continue;
      while (after > first && after <= common && current[after - 1] === words[offset + after - 1])
        after--;
    }
    edits ??= new ClusterWordEdits(first);
    edits.add(first, after);
    changedPage?.(page, start, end);
  }
  return (
    edits?.publish(prior.id) ??
    (length === previous.length
      ? prior
      : { id: Symbol(), base: prior.id, first: length, end: length })
  );
}

/** Immutable issued pages survive view reuse. Only the currently recording publication
 * borrows contiguous staging. Diagnostics can explicitly request their detached flat array. */
export class SubmittedClusterBounds implements PagedWords {
  private recording: Int32Array | undefined;
  private flat: Int32Array | undefined;
  private pageViews: readonly Int32Array[] | undefined;

  private constructor(
    readonly length: number,
    readonly contiguous: Int32Array | undefined,
    pages: readonly Int32Array[] | undefined,
    private readonly largestBackingWords: number,
    readonly change: ClusterWordChange,
  ) {
    this.pageViews = pages;
  }

  // Only a sparse successor needs page views of the previous dense publication.
  get pages(): readonly Int32Array[] {
    if (this.pageViews !== undefined) return this.pageViews;
    const dense = this.contiguous as Int32Array;
    const views: Int32Array[] = [];
    for (let at = 0; at < this.length; at += PAGE_WORDS)
      views.push(dense.subarray(at, at + PAGE_WORDS));
    this.pageViews = views;
    return views;
  }

  static capture(
    staging: Int32Array,
    length: number,
    edited: GpuTableWrites,
    previous?: SubmittedClusterBounds,
  ): SubmittedClusterBounds {
    edited.clear();
    let changedPages = 0,
      firstPage = -1,
      endPage = -1;
    const count = Math.ceil(length / PAGE_WORDS);
    const change = describeClusterWords(staging, length, previous, previous?.change, (page) => {
      if (page !== endPage) {
        if (firstPage >= 0) edited.addRange(firstPage, endPage);
        firstPage = page;
      }
      endPage = page + 1;
      changedPages++;
    });
    let result: SubmittedClusterBounds;
    if (previous?.change === change) result = previous;
    else if (
      previous === undefined ||
      changedPages * 4 >= count * 3 ||
      previous.largestBackingWords > Math.max(PAGE_WORDS, 2 * length)
    ) {
      // A dense replacement owns one allocation; a retiring large table releases its backing.
      result = new SubmittedClusterBounds(
        length,
        staging.slice(0, length),
        undefined,
        length,
        change,
      );
    } else {
      if (firstPage >= 0) edited.addRange(firstPage, endPage);
      const pages = previous.pages.slice(0, count);
      let page = edited.next(0);
      while (page !== -1) {
        const after = edited.end(page);
        for (; page < after; page++) {
          const start = page * PAGE_WORDS;
          pages[page] = staging.slice(start, Math.min(length, start + PAGE_WORDS));
        }
        page = edited.next(after);
      }
      result = new SubmittedClusterBounds(
        length,
        undefined,
        pages,
        Math.max(previous.largestBackingWords, PAGE_WORDS),
        change,
      );
    }
    result.recording = staging;
    return result;
  }

  releaseRecording(): void {
    this.recording = undefined;
  }

  uploadWords(): Int32Array {
    return this.recording ?? this.materialize();
  }

  materialize(): Int32Array {
    if (this.flat !== undefined) return this.flat;
    if (this.contiguous !== undefined) {
      this.flat = this.contiguous.slice();
      return this.flat;
    }
    const words = new Int32Array(this.length);
    let at = 0;
    for (const page of this.pages) {
      const size = Math.min(page.length, this.length - at);
      if (size === page.length) words.set(page, at);
      else for (let i = 0; i < size; i++) words[at + i] = page[i] ?? 0;
      at += size;
    }
    this.flat = words;
    return words;
  }
}

export interface ClusterMembershipPublication {
  readonly grid: ClusterWordChange;
  readonly bounds: ClusterWordChange;
  readonly indices: symbol;
}
