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
  *[Symbol.iterator](): Generator<U> {
    let index = 0;
    for (const value of this.source) yield this.project(value, index++);
  }
}

/**
 * A projection whose per-index result is fixed for this object's lifetime.
 * Several frame consumers read the same rows; each row is projected once,
 * lazily, so construction still does no work proportional to input size.
 */
export class RetainedFrameProjection<T, U> extends FrameProjection<T, U> {
  private readonly values: (U | undefined)[] = [];
  constructor(
    source: FrameList<T>,
    private readonly retainedProject: (value: T, index: number) => U,
  ) {
    super(source, retainedProject);
  }
  override at(index: number): U | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const retained = this.values[index];
    if (retained !== undefined) return retained;
    const value = this.retainedProject(this.source.at(index) as T, index);
    this.values[index] = value;
    return value;
  }
  override *[Symbol.iterator](): Generator<U> {
    let index = 0;
    for (const value of this.source) {
      let projected = this.values[index];
      if (projected === undefined) {
        projected = this.retainedProject(value, index);
        this.values[index] = projected;
      }
      yield projected;
      index++;
    }
  }
}
