import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { renderStateHash } from '../../pipeline-spec';
import type { RenderSystemInternals } from '../../record/render-context';
import type { LayoutKind } from '../material-shader-policy';

type Fact = string | number | boolean | object | null | undefined;

/** Bounded generation-local requests; collisions compare every consumed fact. */
export class MaterialPipelineRequestCache<T> {
  private readonly buckets = new Map<number, { facts: readonly Fact[]; value: T }[]>();
  private readonly strings = new Map<string, number>();
  private readonly objects = new WeakMap<object, number>();
  private readonly numeric = new Float64Array(1);
  private readonly numericWords = new Uint32Array(this.numeric.buffer);
  private nextObject = 1;
  private size = 0;
  keyCharacters = 0;
  hits = 0;
  misses = 0;

  constructor(
    private readonly capacity = 512,
    private readonly comparisonOnlyTail = 0,
  ) {}

  private hash(facts: readonly Fact[]): number {
    let hash = 2166136261;
    for (let index = 0; index < facts.length - this.comparisonOnlyTail; index++) {
      const fact = facts[index];
      if (fact === undefined) continue;
      hash = Math.imul(hash ^ index, 16777619);
      let word: number;
      if (typeof fact === 'string') {
        const cached = this.strings.get(fact);
        if (cached !== undefined) word = cached;
        else {
          word = 2166136261;
          for (let index = 0; index < fact.length; index++)
            word = Math.imul(word ^ fact.charCodeAt(index), 16777619);
          if (this.strings.size >= this.capacity * 8) this.strings.clear();
          this.strings.set(fact, word);
        }
      } else if (typeof fact === 'number') {
        if (fact === (fact | 0)) word = fact | 0;
        else {
          this.numeric[0] = fact;
          word = (this.numericWords[0] ?? 0) ^ (this.numericWords[1] ?? 0);
        }
      } else if (typeof fact === 'object' && fact !== null) {
        const known = this.objects.get(fact);
        word = known ?? this.nextObject++;
        if (known === undefined) this.objects.set(fact, word);
      } else word = fact === undefined ? 0 : fact === null ? 1 : fact ? 2 : 3;
      hash = Math.imul(hash ^ word, 16777619);
    }
    return hash;
  }

  get(facts: readonly Fact[]): T | undefined {
    const bucket = this.buckets.get(this.hash(facts));
    if (bucket !== undefined) {
      entries: for (const entry of bucket) {
        if (entry.facts.length !== facts.length) continue;
        for (let index = 0; index < facts.length; index++)
          if (!Object.is(entry.facts[index], facts[index])) continue entries;
        this.hits++;
        return entry.value;
      }
    }
    this.misses++;
    return undefined;
  }

  set(facts: readonly Fact[], value: T): void {
    if (this.size >= this.capacity) {
      this.buckets.clear();
      this.size = 0;
    }
    const hash = this.hash(facts);
    const entry = { facts, value };
    const bucket = this.buckets.get(hash);
    if (bucket === undefined) this.buckets.set(hash, [entry]);
    else bucket.push(entry);
    this.size++;
  }
}

type RequestArgs<T extends unknown[]> = {
  [K in keyof T]: K extends '15' ? LayoutKind | undefined : T[K];
};

/** Immutable layout/state owners and scalar specialization values determine one request. */
export function materialPipelineRequestFacts(
  args: [
    ...RequestArgs<Parameters<NonNullable<RenderSystemInternals['getMaterialShaderPipeline']>>>,
    pipelinePreparation?: boolean | undefined,
  ],
): Fact[] {
  const facts: Fact[] = args.slice();
  facts.length = 22;
  facts[2] = renderStateHash(args[2]);
  facts[7] =
    args[13]?.digest ??
    deriveVertexLayoutProjection(args[7] ?? DEFAULT_VERTEX_ATTRIBUTE_MAP).digest;
  facts[13] = args[13]?.digest;
  facts[17] = args[17]?.join(',');
  // Constants can be fresh objects or mutated records; compare their current values.
  facts[21] = undefined;
  if (args[21] !== undefined)
    for (const key of Object.keys(args[21]).sort()) facts.push(key, args[21][key]);
  return facts;
}
