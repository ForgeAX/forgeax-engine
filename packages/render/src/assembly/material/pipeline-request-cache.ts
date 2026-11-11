import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { fnv1aUtf16 } from '@forgeax/engine-types';
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
          word = fnv1aUtf16(fact);
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

  private static find<T>(
    bucket: readonly { facts: readonly Fact[]; value: T }[] | undefined,
    facts: readonly Fact[],
  ): { facts: readonly Fact[]; value: T } | undefined {
    if (bucket === undefined) return undefined;
    entries: for (const entry of bucket) {
      if (entry.facts.length !== facts.length) continue;
      for (let index = 0; index < facts.length; index++)
        if (!Object.is(entry.facts[index], facts[index])) continue entries;
      return entry;
    }
    return undefined;
  }

  get(facts: readonly Fact[]): T | undefined {
    const entry = MaterialPipelineRequestCache.find(this.buckets.get(this.hash(facts)), facts);
    if (entry !== undefined) {
      this.hits++;
      return entry.value;
    }
    this.misses++;
    return undefined;
  }

  /** Stores the request's value, replacing an earlier value of the same facts. */
  set(facts: readonly Fact[], value: T): void {
    const hash = this.hash(facts);
    const known = MaterialPipelineRequestCache.find(this.buckets.get(hash), facts);
    if (known !== undefined) {
      known.value = value;
      return;
    }
    if (this.size >= this.capacity) {
      this.buckets.clear();
      this.size = 0;
    }
    const entry = { facts, value };
    const bucket = this.buckets.get(hash);
    if (bucket === undefined) this.buckets.set(hash, [entry]);
    else bucket.push(entry);
    this.size++;
  }
}

/**
 * A prepared request whose backend compilation was still in flight. Its
 * build is not repeated every frame: identical facts answer "pending" until
 * one of the owner's flights settles, then the next lookup rebuilds once and
 * observes the completed pipeline (or stores a fresh pending answer).
 */
export class PendingMaterialPipelineRequest {
  private readonly settled: number;

  constructor(private readonly owner: { readonly settled: number }) {
    this.settled = owner.settled;
  }

  get current(): boolean {
    return this.owner.settled === this.settled;
  }
}

/** The prepared PSO owner facts a pending answer is judged by. */
export interface PendingPipelineOwner {
  readonly settled: number;
  readonly pendingAnswers: number;
}

/**
 * Looks up one request, building it on a miss. A build answered by an
 * in-flight prepared compilation is remembered as pending, so identical
 * requests skip the build until that owner settles a flight.
 */
export function requestMaterialPipeline<T extends object>(
  requests: MaterialPipelineRequestCache<T | PendingMaterialPipelineRequest>,
  facts: readonly Fact[],
  lookupOnly: boolean,
  build: () => T | null,
  preparedOwner: () => PendingPipelineOwner | undefined,
): T | null {
  const cached = requests.get(facts);
  if (cached instanceof PendingMaterialPipelineRequest) {
    if (cached.current || lookupOnly) return null;
  } else if (cached !== undefined) return cached;
  else if (lookupOnly) return null;
  // A build may request another pipeline through the reused lookup storage.
  const stored = facts.slice();
  const answered = preparedOwner()?.pendingAnswers ?? 0;
  const pipeline = build();
  if (pipeline !== null) {
    requests.set(stored, pipeline);
    return pipeline;
  }
  const owner = preparedOwner();
  if (owner !== undefined && owner.pendingAnswers !== answered)
    requests.set(stored, new PendingMaterialPipelineRequest(owner));
  return null;
}

type RequestArgs<T extends unknown[]> = {
  [K in keyof T]: K extends '15' ? LayoutKind | undefined : T[K];
};

const formatKeys = new WeakMap<
  readonly string[],
  { readonly copy: readonly string[]; readonly key: string }
>();

/** Attachment format lists are pass-owned arrays; join each once while unchanged. */
function formatsKey(formats: readonly string[]): string {
  const cached = formatKeys.get(formats);
  if (cached !== undefined && cached.copy.length === formats.length) {
    let same = true;
    for (let index = 0; index < formats.length && same; index++)
      same = cached.copy[index] === formats[index];
    if (same) return cached.key;
  }
  const key = formats.join(',');
  formatKeys.set(formats, { copy: formats.slice(), key });
  return key;
}

/** Immutable layout/state owners and scalar specialization values determine one request. */
export function materialPipelineRequestFacts(
  args: [
    ...RequestArgs<Parameters<NonNullable<RenderSystemInternals['getMaterialShaderPipeline']>>>,
    pipelinePreparation?: boolean | undefined,
  ],
  /** Reused lookup storage; a stored request must keep its own copy. */
  facts: Fact[] = [],
): Fact[] {
  facts.length = 22;
  for (let index = 0; index < 22; index++) facts[index] = args[index];
  facts[2] = renderStateHash(args[2]);
  facts[7] =
    args[13]?.digest ??
    deriveVertexLayoutProjection(args[7] ?? DEFAULT_VERTEX_ATTRIBUTE_MAP).digest;
  facts[13] = args[13]?.digest;
  facts[17] = args[17] === undefined ? undefined : formatsKey(args[17]);
  // Constants can be fresh objects or mutated records; compare their current values.
  facts[21] = undefined;
  if (args[21] !== undefined)
    for (const key of Object.keys(args[21]).sort()) facts.push(key, args[21][key]);
  return facts;
}
