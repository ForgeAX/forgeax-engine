import { VARIANT_PERMUTATION_RULES } from '@forgeax/engine-shader';

interface RejectedPattern {
  readonly mask: number;
  readonly value: number;
}

function rejectedPatterns(axes: readonly string[]): RejectedPattern[][] {
  const patterns: RejectedPattern[][] = axes.map(() => []);
  for (const rule of VARIANT_PERMUTATION_RULES) {
    const entries = [...Object.entries(rule.when), [rule.axis, !rule.value] as const];
    const positions = entries.map(([axis]) => axes.lastIndexOf(axis));
    if (positions.some((position) => position < 0)) continue;
    let mask = 0;
    let value = 0;
    for (const [axis, enabled] of entries) {
      const bit = 1 << (axes.length - 1 - axes.lastIndexOf(axis));
      mask |= bit;
      if (enabled) value |= bit;
    }
    patterns[Math.max(...positions)]?.push({ mask, value });
  }
  return patterns;
}

/**
 * Visit the original descending boolean product, pruning only when every
 * declared axis in an owning rejection rule has been assigned. The same
 * rule table owns runtime requests and publication; rejected branches never
 * allocate the complete product's temporary define objects.
 */
export function supportedVariantDefines(axes: readonly string[]): Record<string, boolean>[] {
  const patterns = rejectedPatterns(axes);
  const results: Record<string, boolean>[] = [];
  const defines: Record<string, boolean> = {};
  const visit = (index: number, mask: number): void => {
    const axis = axes[index];
    if (axis === undefined) {
      results.push({ ...defines });
      return;
    }
    const bit = 1 << (axes.length - 1 - index);
    for (const enabled of [true, false]) {
      const next = enabled ? mask | bit : mask;
      defines[axis] = enabled;
      if (patterns[index]?.some((pattern) => (next & pattern.mask) === pattern.value)) continue;
      visit(index + 1, next);
    }
  };
  visit(0, 0);
  return results;
}
