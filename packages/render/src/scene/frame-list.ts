/** Actual frame work can be read from native arrays or a retained scene root. */
export interface FrameList<T> extends Iterable<T> {
  readonly length: number;
  at(index: number): T | undefined;
  slice(start?: number, end?: number): T[];
  filter(predicate: (value: T, index: number) => unknown): T[];
  map<U>(project: (value: T, index: number) => U): U[];
  some(predicate: (value: T, index: number) => unknown): boolean;
  every(predicate: (value: T, index: number) => unknown): boolean;
  reduce<U>(fold: (accumulated: U, value: T, index: number) => U, initial: U): U;
  find(predicate: (value: T, index: number) => unknown): T | undefined;
  entries(): IterableIterator<[number, T]>;
  findIndex(predicate: (value: T, index: number) => unknown): number;
  forEach(consume: (value: T, index: number) => void): void;
  flatMap<U>(project: (value: T, index: number) => U | readonly U[]): U[];
}

/** Shared operations enumerate requested execution work, never maintain a dense copy. */
export abstract class FrameListBase<T> implements FrameList<T> {
  abstract readonly length: number;
  abstract at(index: number): T | undefined;
  abstract [Symbol.iterator](): Iterator<T>;

  slice(start = 0, end = this.length): T[] {
    const result: T[] = [];
    start = Math.trunc(start) || 0;
    end = Math.trunc(end) || 0;
    start = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    end = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
    for (let index = start; index < end; index++) {
      const value = this.at(index);
      result.push(value as T);
    }
    return result;
  }

  filter(predicate: (value: T, index: number) => unknown): T[] {
    const result: T[] = [];
    let index = 0;
    for (const value of this) if (predicate(value, index++)) result.push(value);
    return result;
  }

  map<U>(project: (value: T, index: number) => U): U[] {
    const result: U[] = [];
    let index = 0;
    for (const value of this) result.push(project(value, index++));
    return result;
  }

  some(predicate: (value: T, index: number) => unknown): boolean {
    let index = 0;
    for (const value of this) if (predicate(value, index++)) return true;
    return false;
  }

  every(predicate: (value: T, index: number) => unknown): boolean {
    let index = 0;
    for (const value of this) if (!predicate(value, index++)) return false;
    return true;
  }

  reduce<U>(fold: (accumulated: U, value: T, index: number) => U, initial: U): U {
    let index = 0;
    for (const value of this) initial = fold(initial, value, index++);
    return initial;
  }

  find(predicate: (value: T, index: number) => unknown): T | undefined {
    let index = 0;
    for (const value of this) if (predicate(value, index++)) return value;
    return undefined;
  }

  findIndex(predicate: (value: T, index: number) => unknown): number {
    let index = 0;
    for (const value of this) {
      if (predicate(value, index)) return index;
      index++;
    }
    return -1;
  }

  *entries(): IterableIterator<[number, T]> {
    let index = 0;
    for (const value of this) yield [index++, value];
  }

  forEach(consume: (value: T, index: number) => void): void {
    let index = 0;
    for (const value of this) consume(value, index++);
  }

  flatMap<U>(project: (value: T, index: number) => U | readonly U[]): U[] {
    const result: U[] = [];
    let index = 0;
    for (const value of this) {
      const projected = project(value, index++);
      if (Array.isArray(projected)) result.push(...projected);
      else result.push(projected as U);
    }
    return result;
  }
}

/** A fixed input and projection; construction does no work proportional to input size. */
export class FrameProjection<T, U> extends FrameListBase<U> {
  constructor(
    readonly source: FrameList<T>,
    private readonly project: (value: T, index: number) => U,
  ) {
    super();
  }
  get length(): number {
    return this.source.length;
  }
  at(index: number): U | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const value = this.source.at(index);
    return this.project(value as T, index);
  }
  [Symbol.iterator](): IterableIterator<U> {
    return new ProjectionIterator(this.source[Symbol.iterator](), this.project);
  }
}

/**
 * Projects each source step into one reused result object; consumers read the
 * value before the next step, so a walk allocates per walk, not per row.
 */
class ProjectionIterator<T, U> implements IterableIterator<U> {
  #index = 0;
  readonly #result: { value: U | undefined; done: boolean } = { value: undefined, done: false };
  constructor(
    private readonly source: Iterator<T>,
    private readonly project: (value: T, index: number) => U,
  ) {}
  next(): IteratorResult<U> {
    const step = this.source.next();
    const result = this.#result;
    if (step.done === true) {
      result.value = undefined;
      result.done = true;
    } else result.value = this.project(step.value, this.#index++);
    return result as IteratorResult<U>;
  }
  return(): IteratorResult<U> {
    this.source.return?.();
    this.#result.value = undefined;
    this.#result.done = true;
    return this.#result as IteratorResult<U>;
  }
  [Symbol.iterator](): IterableIterator<U> {
    return this;
  }
}

export interface RetainedRowFacts<U> {
  readonly lodCandidateCount: number;
  /** Rows carrying the sparse source fact, in row order. */
  sparseRows(kind: 'terrain' | 'capsule'): IterableIterator<U>;
}

/**
 * The retained scene root projection: it carries the facts its owner maintained
 * while writing the rows. Row results are fixed by the projector's own per-row
 * memo, so the list itself keeps no index-addressed copy.
 */
export class RetainedFrameProjection<T, U> extends FrameProjection<T, U> {
  constructor(
    source: FrameList<T>,
    project: (value: T, index: number) => U,
    /** Facts the owner maintained while writing the rows, so consumers need not walk them. */
    readonly facts?: RetainedRowFacts<U>,
  ) {
    super(source, project);
  }
}

/** The retained scene root under row-preserving projections, if the list is one. */
function retainedFacts<U>(list: FrameList<U>): RetainedFrameProjection<unknown, U> | undefined {
  let node: FrameList<unknown> = list;
  while (node instanceof FrameProjection) {
    if (node instanceof RetainedFrameProjection && node.facts !== undefined)
      return node as RetainedFrameProjection<unknown, U>;
    node = node.source;
  }
  return undefined;
}

/**
 * LOD candidate count of a frame list: read from the retained scene projection
 * under any chain of row-preserving projections, else counted by walking rows.
 */
export function lodCandidateCountOf(
  list: FrameList<{ readonly lods?: readonly unknown[] | undefined }>,
): number {
  const retained = retainedFacts(list);
  if (retained?.facts !== undefined) return retained.facts.lodCandidateCount;
  return list.reduce((total, row) => total + ((row.lods?.length ?? 0) > 0 ? 1 : 0), 0);
}

/**
 * The rows that can carry a sparse source fact: the owner's index when the list is
 * the retained scene root itself, otherwise every row (the caller filters by the fact).
 */
export function sparseRowsOf<U>(list: FrameList<U>, kind: 'terrain' | 'capsule'): Iterable<U> {
  const facts = list instanceof RetainedFrameProjection ? list.facts : undefined;
  return facts === undefined ? list : { [Symbol.iterator]: () => facts.sparseRows(kind) };
}
