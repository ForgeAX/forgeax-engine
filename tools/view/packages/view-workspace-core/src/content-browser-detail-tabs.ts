import type { ContentBrowserDetailContribution, ContentBrowserDetailTabs } from './frontend-contract.ts';

export function createContentBrowserDetailTabs(): ContentBrowserDetailTabs {
  const contributions = new Map<string, ContentBrowserDetailContribution>();
  const listeners = new Set<() => void>();
  let snapshot: readonly ContentBrowserDetailContribution[] = Object.freeze([]);
  const notify = () => {
    snapshot = Object.freeze([...contributions.values()].sort((a, b) => a.id.localeCompare(b.id)));
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    register(contribution: ContentBrowserDetailContribution) {
      if (!contribution?.id?.trim() || !contribution.titleKey?.trim() || typeof contribution.matches !== 'function' || typeof contribution.mount !== 'function') throw new TypeError('detail tab requires id, titleKey, matcher and mount');
      if (contributions.has(contribution.id)) throw new Error(`Content Browser detail tab already registered: ${contribution.id}`);
      const registered = Object.freeze(contribution);
      contributions.set(contribution.id, registered);
      notify();
      return () => { if (contributions.get(contribution.id) === registered) { contributions.delete(contribution.id); notify(); } };
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); listener(); return () => { listeners.delete(listener); }; },
  });
}
