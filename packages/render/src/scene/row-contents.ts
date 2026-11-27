import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
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
  /** A resident content using this materials list. Cleared at its final release. */
  content?: ContentBinding;
}

interface ContentBinding {
  readonly key: string;
  readonly value: RowContent;
  readonly fieldCount: number;
  boundsRevision: number;
  boundsBinding: number;
  displacement: number;
  readonly arrays: readonly ArrayBinding[];
  holders: number;
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
    if (
      !Object.is(value, fact) &&
      !(Array.isArray(value) && Array.isArray(fact) && sameList(value, fact))
    )
      return false;
    count++;
  }
  return count === bound.fieldCount;
}

function arrayKey(field: string, value: readonly unknown[]): string {
  let key = `${field}:${value.length}`;
  for (const element of value) key += `,${token(element)}`;
  return key;
}

/** Shared, immutable draw facts. Every strong binding is held by a live scene row. */
export class RowContents {
  private readonly contents = new Map<string, ContentBinding>();
  private byContent = new WeakMap<RowContent, ContentBinding>();
  private readonly arrays = new Map<string, ArrayBinding>();
  private byArray = new WeakMap<readonly unknown[], ArrayBinding>();

  get size(): number {
    return this.contents.size;
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
  acquire(snapshot: RenderableSnapshot | RowContent): RowContent {
    const materials = this.resolveArray('materials', snapshot.materials);
    const source = snapshot as unknown as Fields;
    const bound = materials.content;
    if (bound !== undefined && sameFields(source, bound)) {
      bound.holders++;
      return bound.value;
    }
    return this.acquireKeyed(source, materials).value;
  }

  private acquireKeyed(source: Fields, materials: ArrayBinding): ContentBinding {
    const facts: Record<string, unknown> = {};
    const arrays: ArrayBinding[] = [];
    for (const field in source) {
      if (EXCLUDED.has(field)) continue;
      const value = field === 'materials' ? materials.value : source[field];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const binding = field === 'materials' ? materials : this.resolveArray(field, value);
        arrays.push(binding);
        facts[field] = binding.value;
      } else facts[field] = value;
    }
    const fields = Object.keys(facts).sort();
    let key = '';
    for (const field of fields) key += `${field}=${token(facts[field])};`;
    let entry = this.contents.get(key);
    if (entry === undefined) {
      const value = Object.freeze(facts) as unknown as RowContent;
      entry = {
        value,
        key,
        fieldCount: fields.length,
        arrays,
        holders: 0,
        boundsRevision: 0,
        boundsBinding: 0,
        displacement: 0,
      };
      for (const array of arrays) {
        if (array.holders++ === 0) {
          this.arrays.set(array.key, array);
          this.byArray.set(array.value, array);
        }
      }
      this.contents.set(key, entry);
      this.byContent.set(value, entry);
    }
    materials.content = entry;
    entry.holders++;
    return entry;
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
    this.contents.delete(entry.key);
    this.byContent.delete(content);
    for (const array of entry.arrays) {
      if (array.content === entry) delete array.content;
      if (--array.holders !== 0) continue;
      this.arrays.delete(array.key);
      if (this.byArray.get(array.value) === array) this.byArray.delete(array.value);
    }
  }

  clear(): void {
    this.contents.clear();
    this.arrays.clear();
    this.byArray = new WeakMap();
    this.byContent = new WeakMap();
  }
}
