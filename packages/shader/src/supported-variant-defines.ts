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

/** Visit legal selections in true-first publication order without visiting rejected subtrees. */
export function* supportedVariantDefines(
  axes: readonly string[],
  constraints: Defines = {},
): Generator<Record<string, boolean>, void, void> {
  const patterns = rejectedPatterns(axes);
  const defines: Record<string, boolean> = {};
  function* visit(index: number): Generator<Record<string, boolean>, void, void> {
    const axis = axes[index];
    if (axis === undefined) {
      yield { ...defines };
      return;
    }
    const forced = Object.hasOwn(constraints, axis) ? constraints[axis] : undefined;
    const choices = forced === undefined ? [true, false] : [forced];
    for (const enabled of choices) {
      defines[axis] = enabled;
      const rejected = patterns[index]?.some((pattern) =>
        pattern.every(([name, value]) => defines[name] === value),
      );
      if (!rejected) yield* visit(index + 1);
    }
  }
  yield* visit(0);
}
