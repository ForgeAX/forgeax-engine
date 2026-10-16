// Worker pool shared by the split Vitest runners: groups start in the given
// order, at most `concurrency` run at once, and the first failure stops new
// launches while already running groups finish. Exclusive groups drain active
// work and finish before the next parallel batch starts.
export async function runGroups({
  groups,
  concurrency,
  runGroupImpl,
  order,
  isExclusive = () => false,
}) {
  const results = Array(groups.length);
  const schedule = order ?? groups.map((_group, index) => index);
  if (
    schedule.length !== groups.length ||
    schedule.some((index) => !Number.isInteger(index) || index < 0 || index >= groups.length) ||
    new Set(schedule).size !== groups.length
  ) {
    throw new Error('group schedule must contain every group index exactly once');
  }
  async function runBatch(batch) {
    let nextIndex = 0;
    let firstError = null;
    async function worker() {
      while (firstError === null) {
        const index = batch[nextIndex++];
        if (index === undefined) return;
        try {
          results[index] = await runGroupImpl(groups[index], index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));
    if (firstError !== null) throw firstError;
  }

  let batch = [];
  for (const index of schedule) {
    if (isExclusive(groups[index], index)) {
      await runBatch(batch);
      batch = [];
      results[index] = await runGroupImpl(groups[index], index);
    } else batch.push(index);
  }
  await runBatch(batch);
  return results;
}
