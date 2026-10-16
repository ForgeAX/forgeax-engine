/** Observe existing native stage budgets from Node, including a stalled page realm. */
export function watchNativeStages(record, expire) {
  const pending = new Map();
  const running = new Set();
  const failures = [];
  let disposed = false;
  return {
    async receive(row) {
      if (!Number.isSafeInteger(row.id) || ![10000,30000,90000].includes(row.budgetMs) || !['begin','complete','failed'].includes(row.status))
        throw new Error('invalid native music stage receipt');
      clearTimeout(pending.get(row.id));pending.delete(row.id);
      if (row.status === 'begin' && !disposed) pending.set(row.id,setTimeout(()=>{
        pending.delete(row.id);
        const task = Promise.resolve().then(() => expire({...row,status:'deadline',observedAt:new Date().toISOString()}))
          .catch(error => { failures.push(error); }).finally(() => running.delete(task));
        running.add(task);
      },row.budgetMs));
      await record({...row,observedAt:new Date().toISOString()});
    },
    dispose() {disposed=true;for(const timer of pending.values())clearTimeout(timer);pending.clear();},
    async settled() {
      await Promise.all(running);
      if (failures.length) throw new AggregateError(failures, 'native music stage deadline cleanup failed');
    },
  };
}
