import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { pipelineStripIndexFormat, renderStateHash } from '../../pipeline-spec';
import type { RenderSystemInternals } from '../../record/render-context';
import type { LayoutKind } from '../material-shader-policy';

type Fact = string | number | boolean | object | null | undefined;

export type MaterialPipelineRequestFacts = Fact[];

const NEGATIVE_ZERO = Symbol();
type BranchKey = Fact | typeof NEGATIVE_ZERO;
type RequestNode<T> =
  | { readonly facts: readonly Fact[]; value: T }
  | { readonly field: number; readonly cases: Map<BranchKey, RequestNode<T>> };

// -1 selects the tuple length, which also distinguishes a missing trailing field from undefined.
function requestKey(facts: readonly Fact[], field: number): BranchKey {
  const value = field < 0 ? facts.length : facts[field];
  return Object.is(value, -0) ? NEGATIVE_ZERO : value;
}

function differingField(left: readonly Fact[], right: readonly Fact[]): number | undefined {
  if (left.length !== right.length) return -1;
  for (let field = 0; field < left.length; field++)
    if (!Object.is(left[field], right[field])) return field;
  return undefined;
}

/** Index only fields that distinguish admitted requests. Each leaf owns the complete facts. */
export class MaterialPipelineRequestCache<T> {
  private root: RequestNode<T> | undefined;
  private size = 0;
  keyCharacters = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly capacity = 512) {}

  get(facts: readonly Fact[]): T | undefined {
    let node = this.root;
    while (node !== undefined && 'cases' in node)
      node = node.cases.get(requestKey(facts, node.field));
    if (node !== undefined && differingField(node.facts, facts) === undefined) {
      this.hits++;
      return node.value;
    }
    this.misses++;
    return undefined;
  }

  set(facts: readonly Fact[], value: T): void {
    let node = this.root;
    let parent: Map<BranchKey, RequestNode<T>> | undefined;
    let key: BranchKey;
    while (node !== undefined && 'cases' in node) {
      parent = node.cases;
      key = requestKey(facts, node.field);
      node = parent.get(key);
    }
    const field = node === undefined ? undefined : differingField(node.facts, facts);
    if (node !== undefined && field === undefined) {
      node.value = value;
      return;
    }
    const leaf = { facts, value };
    if (this.size >= this.capacity) {
      this.root = leaf;
      this.size = 1;
      return;
    }
    let next: RequestNode<T> = leaf;
    if (node !== undefined && field !== undefined) {
      const cases = new Map<BranchKey, RequestNode<T>>();
      cases.set(requestKey(node.facts, field), node);
      cases.set(requestKey(facts, field), leaf);
      next = { field, cases };
    }
    if (parent === undefined) this.root = next;
    else parent.set(key, next);
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
  observePending = false,
): T | null {
  const cached = requests.get(facts);
  if (cached instanceof PendingMaterialPipelineRequest) {
    // A preparation transaction must receive the original flight's completion.
    if (lookupOnly || (cached.current && !observePending)) return null;
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
  facts.length = 24;
  for (let index = 0; index < 24; index++) facts[index] = args[index];
  facts[2] = renderStateHash(args[2]);
  facts[4] = pipelineStripIndexFormat(args[3], args[4]);
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
