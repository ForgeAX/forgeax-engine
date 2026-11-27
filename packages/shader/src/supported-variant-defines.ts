import { VARIANT_PERMUTATION_RULES } from './variant-permutation-rules.js';

type Defines = Readonly<Record<string, boolean>>;
type RejectedPattern = readonly (readonly [string, boolean])[];

function rejectedPatterns(axes: readonly string[]): RejectedPattern[][] {
  const positions = new Map(axes.map((axis, index) => [axis, index]));
  const patterns: RejectedPattern[][] = axes.map(() => []);
  for (const rule of VARIANT_PERMUTATION_RULES) {
    const entries = [...Object.entries(rule.when), [rule.axis, !rule.value] as const];
    let last = -1;
    for (const [axis] of entries) {
      const position = positions.get(axis);
      if (position === undefined) {
        last = -1;
        break;
      }
      last = Math.max(last, position);
    }
    patterns[last]?.push(entries);
  }
  return patterns;
}

function matches(defines: Defines, pattern: RejectedPattern): boolean {
  for (const [axis, value] of pattern) if (defines[axis] !== value) return false;
  return true;
}

/** Rules are attached to the last field that can decide them in this traversal order. */
class VariantOrder {
  private readonly patterns: RejectedPattern[][];

  constructor(readonly axes: readonly string[]) {
    this.patterns = rejectedPatterns(axes);
  }

  *rows(constraints: Defines, preferTrue: boolean): Generator<Record<string, boolean>, void, void> {
    const { axes, patterns } = this;
    const defines: Record<string, boolean> = {};
    function* visit(index: number): Generator<Record<string, boolean>, void, void> {
      const axis = axes[index];
      if (axis === undefined) {
        yield { ...defines };
        return;
      }
      const forced = Object.hasOwn(constraints, axis) ? constraints[axis] : undefined;
      const choices = forced === undefined ? 2 : 1;
      for (let i = 0; i < choices; i++) {
        defines[axis] = forced ?? (i === 0 ? preferTrue : !preferTrue);
        if (!patterns[index]?.some((pattern) => matches(defines, pattern))) yield* visit(index + 1);
      }
    }
    yield* visit(0);
  }

  first(constraints: Defines, preferTrue: boolean): Defines | undefined {
    const defines: Record<string, boolean> = {};
    const { axes, patterns } = this;
    function visit(index: number): boolean {
      const axis = axes[index];
      if (axis === undefined) return true;
      const forced = Object.hasOwn(constraints, axis) ? constraints[axis] : undefined;
      const choices = forced === undefined ? 2 : 1;
      for (let i = 0; i < choices; i++) {
        defines[axis] = forced ?? (i === 0 ? preferTrue : !preferTrue);
        if (!patterns[index]?.some((pattern) => matches(defines, pattern)) && visit(index + 1))
          return true;
      }
      return false;
    }
    return visit(0) ? defines : undefined;
  }

  /** A fixed contradiction can reject the request before any free axis branches. */
  rejects(constraints: Defines): boolean {
    return this.patterns.some((group) => group.some((pattern) => matches(constraints, pattern)));
  }
}

export type VariantPreference = readonly [axis: string, value: boolean, weight: number];

/** One template family owns its legal choices. Requests only materialize the winning program. */
export class ShaderVariantDomain {
  private readonly publication: VariantOrder;
  private keyOrder?: VariantOrder;
  private readonly allTrue: Defines | undefined;

  constructor(readonly axes: readonly string[]) {
    this.publication = new VariantOrder(axes);
    const allTrue: Record<string, boolean> = {};
    for (const axis of axes) allTrue[axis] = true;
    if (!this.publication.rejects(allTrue)) this.allTrue = allTrue;
  }

  rows(constraints: Defines = {}): Generator<Record<string, boolean>, void, void> {
    return this.publication.rows(constraints, true);
  }

  first(constraints: Defines): Defines | undefined {
    return this.publication.rejects(constraints)
      ? undefined
      : this.publication.first(constraints, true);
  }

  preferred(constraints: Defines, preferences: readonly VariantPreference[]): Defines | undefined {
    if (this.publication.rejects(constraints)) return undefined;
    this.keyOrder ??= new VariantOrder([...this.axes].sort());
    const order = this.keyOrder;
    const fixed = { ...constraints };
    let best: Defines | undefined;
    let bestScore = -Infinity;
    const allTrue = this.allTrue;
    function earlier(candidate: Defines, current: Defines): boolean {
      if (candidate === allTrue || current === allTrue) return candidate === allTrue;
      for (const axis of order.axes)
        if (candidate[axis] !== current[axis]) return candidate[axis] === false;
      return false;
    }
    function search(index: number, ceiling: number): void {
      if (ceiling < bestScore) return;
      for (; index < preferences.length; index++) {
        const [axis, value, weight] = preferences[index] as VariantPreference;
        if (!order.axes.includes(axis) || Object.hasOwn(fixed, axis)) continue;
        fixed[axis] = value;
        search(index + 1, ceiling);
        fixed[axis] = !value;
        search(index + 1, ceiling - weight);
        delete fixed[axis];
        return;
      }
      // The empty all-true key sorts first. All other keys compare at the
      // first differing boolean of their canonical (sorted) axis sequence.
      const candidate =
        allTrue !== undefined && order.axes.every((axis) => fixed[axis] !== false)
          ? allTrue
          : order.rejects(fixed)
            ? undefined
            : order.first(fixed, false);
      if (
        candidate !== undefined &&
        (ceiling > bestScore || best === undefined || earlier(candidate, best))
      ) {
        best = candidate;
        bestScore = ceiling;
      }
    }
    // Every preferred branch is free; a mismatch subtracts its nonnegative weight.
    search(0, 0);
    return best;
  }
}

/** Visit legal selections in true-first publication order without visiting rejected subtrees. */
export function* supportedVariantDefines(
  axes: readonly string[],
  constraints: Defines = {},
): Generator<Record<string, boolean>, void, void> {
  yield* new VariantOrder(axes).rows(constraints, true);
}
