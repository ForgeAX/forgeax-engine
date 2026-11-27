/** Level `l` gets a 2^-l share, reserving one per level when the budget permits.
 * Capacity remainders fill the earliest non-full levels in bounded level order. */
export function splitProbeBudget(budget: number, levels: number, perLevel: number): number[] {
  const admitted = Math.min(budget, levels * perLevel);
  if (admitted < levels)
    return Array.from({ length: levels }, (_, level) => Number(level < admitted));
  const total = 2 - 2 ** (1 - levels);
  let remaining = admitted;
  const out = Array.from({ length: levels }, (_, level) => {
    const share = Math.min(
      perLevel,
      Math.max(1, Math.floor((admitted * 2 ** -level) / total)),
      remaining - (levels - level - 1),
    );
    remaining -= share;
    return share;
  });
  for (let level = 0; level < levels && remaining > 0; level++) {
    const share = out[level] ?? 0;
    const extra = Math.min(perLevel - share, remaining);
    out[level] = share + extra;
    remaining -= extra;
  }
  return out;
}
