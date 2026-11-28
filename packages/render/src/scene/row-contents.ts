import { getOpaqueResourceIdentity } from '../opaque-resource-identity';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from './material-dispatch';
import { boundDisplacementRadius } from './render-scene-snapshots';

/**
 * The drawable facts of one row without its identity and pose. Rows whose
 * facts are equal field by field (arrays element by element) share one value.
 */
export type RowContent = Omit<RenderableSnapshot, 'entityKey' | 'transform'>;

const EXCLUDED = new Set(['entityKey', 'transform', 'temporal']);

function token(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'u';
    case 'number':
      return Object.is(value, -0) ? 'n-0' : `n${value}`;
    case 'boolean':
      return value ? 't' : 'f';
    case 'string':
      return `s${value.length}:${value}`;
    case 'object':
      return value === null ? 'z' : `o${getOpaqueResourceIdentity(value)}`;
    default:
      return `x${String(value)}`;
  }
}

type Fields = Readonly<Record<string, unknown>>;

interface ArrayBinding {
  readonly field: string;
  readonly key: string;
  readonly value: readonly unknown[];
  holders: number;
}

interface ContentBinding {
  readonly key: number;
  readonly value: RowContent;
  readonly fieldCount: number;
  boundsRevision: number;
  boundsBinding: number;
  displacement: number;
  readonly arrays: readonly ArrayBinding[];
  holders: number;
  next: ContentBinding | undefined;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Compare this admission to immutable live facts, including values supplied in mutable lists. */
function sameFields(source: Fields, bound: ContentBinding): boolean {
  const facts = bound.value as unknown as Fields;
  let count = 0;
  for (const field in source) {
    if (EXCLUDED.has(field)) continue;
    const value = source[field];
    if (value === undefined) continue;
    const fact = facts[field];
    if (!Object.hasOwn(facts, field)) return false;
    if (
      !Object.is(value, fact) &&
      !(Array.isArray(value) && Array.isArray(fact) && sameList(value, fact))
    )
      return false;
    count++;
  }
  return count === bound.fieldCount;
}

function textHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash;
}

const numericWord = new Float64Array(1);
const numericBits = new Int32Array(numericWord.buffer);

function mixWord(value: number): number {
  const mixed = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  return mixed ^ (mixed >>> 13);
}

function atomHash(value: unknown): number {
  switch (typeof value) {
    case 'number':
      // Object.is treats all NaNs alike, including NaNs read from foreign numeric storage.
      numericWord[0] = Number.isNaN(value) ? NaN : value;
      return mixWord((numericBits[0] as number) ^ Math.imul(numericBits[1] as number, 31));
    case 'string':
      return textHash(value);
    case 'object':
    case 'function':
      return value === null ? 7 : getOpaqueResourceIdentity(value);
    case 'boolean':
      return value ? 11 : 13;
    default:
      return 0;
  }
}

function fieldValueHash(value: unknown): number {
  if (!Array.isArray(value)) return atomHash(value);
  let hash = value.length;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ atomHash(value[i]), 0x01000193);
  return hash;
}

/** Field order is irrelevant. The hash only locates a bucket; equality is still exact. */
function rowContentHash(source: Fields): number {
  let hash = 0;
  for (const field in source) {
    if (EXCLUDED.has(field)) continue;
    const value = source[field];
    if (value === undefined) continue;
    hash ^= mixWord(textHash(field) ^ fieldValueHash(value));
  }
  return hash;
}

function arrayKey(field: string, value: readonly unknown[]): string {
  let key = `${field}:${value.length}`;
  for (const element of value) key += `,${token(element)}`;
  return key;
}

/** Shared, immutable draw facts. Every strong binding is held by a live scene row. */
export class RowContents {
  private readonly contents = new Map<number, ContentBinding>();
  private byContent = new WeakMap<RowContent, ContentBinding>();
  private readonly arrays = new Map<string, ArrayBinding>();
  private byArray = new WeakMap<readonly unknown[], ArrayBinding>();
  private liveContents = 0;

  get size(): number {
    return this.liveContents;
  }

  private resolveArray(field: string, input: readonly unknown[]): ArrayBinding {
    const known = this.byArray.get(input);
    if (known?.field === field) return known;
    const key = arrayKey(field, input);
    return (
      this.arrays.get(key) ?? {
        field,
        key,
        value: Object.isFrozen(input) ? input : Object.freeze([...input]),
        holders: 0,
      }
    );
  }

  /** Acquire current drawable facts without retaining the producer's row, pose or mutable lists. */
  acquire(snapshot: RenderableSnapshot | RowContent, before?: RowContent): RowContent {
    const source = snapshot as unknown as Fields;
    const current = before === undefined ? undefined : this.byContent.get(before);
    if (current !== undefined && (snapshot === before || sameFields(source, current))) {
      current.holders++;
      return current.value;
    }
    return this.acquireIndexed(source);
  }

  private acquireIndexed(source: Fields): RowContent {
    const key = rowContentHash(source);
    for (let entry = this.contents.get(key); entry !== undefined; entry = entry.next) {
      if (sameFields(source, entry)) {
        entry.holders++;
        return entry.value;
      }
    }
    return this.addContent(source, key);
  }

  private addContent(source: Fields, key: number): RowContent {
    const facts: Record<string, unknown> = {};
    const arrays: ArrayBinding[] = [];
    let fieldCount = 0;
    for (const field in source) {
      if (EXCLUDED.has(field)) continue;
      const value = source[field];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const binding = this.resolveArray(field, value);
        arrays.push(binding);
        facts[field] = binding.value;
      } else facts[field] = value;
      fieldCount++;
    }
    const value = Object.freeze(facts) as unknown as RowContent;
    const entry = {
      value,
      key,
      fieldCount,
      arrays,
      holders: 1,
      boundsRevision: 0,
      boundsBinding: 0,
      displacement: 0,
      next: this.contents.get(key),
    };
    for (const array of arrays) {
      if (array.holders++ === 0) {
        this.arrays.set(array.key, array);
        this.byArray.set(array.value, array);
      }
    }
    this.contents.set(key, entry);
    this.byContent.set(value, entry);
    this.liveContents++;
    return value;
  }

  /** Pose-independent radius of a live content and its effective fixed material slots. */
  displacementRadius(
    content: RowContent,
    effective: Pick<RowContent, 'materials' | 'material'>,
    materials: MaterialFrame | undefined,
  ): number {
    const revision = MaterialFrame.cullingRevision(materials);
    const entry = revision === 0 ? undefined : this.byContent.get(content);
    if (entry === undefined) return boundDisplacementRadius(effective, materials);
    const binding = effective === content ? 0 : getOpaqueResourceIdentity(effective);
    if (entry.boundsRevision !== revision || entry.boundsBinding !== binding) {
      const radius = boundDisplacementRadius(effective, materials);
      entry.boundsRevision = revision;
      entry.boundsBinding = binding;
      entry.displacement = radius;
    }
    return entry.displacement;
  }

  release(content: RowContent): void {
    const entry = this.byContent.get(content);
    if (entry === undefined || --entry.holders !== 0) return;
    const head = this.contents.get(entry.key);
    if (head === entry) {
      if (entry.next === undefined) this.contents.delete(entry.key);
      else this.contents.set(entry.key, entry.next);
    } else {
      for (let previous = head; previous !== undefined; previous = previous.next) {
        if (previous.next !== entry) continue;
        previous.next = entry.next;
        break;
      }
    }
    this.liveContents--;
    this.byContent.delete(content);
    for (const array of entry.arrays) {
      if (--array.holders !== 0) continue;
      this.arrays.delete(array.key);
      if (this.byArray.get(array.value) === array) this.byArray.delete(array.value);
    }
  }

  clear(): void {
    this.contents.clear();
    this.liveContents = 0;
    this.arrays.clear();
    this.byArray = new WeakMap();
    this.byContent = new WeakMap();
  }
}
