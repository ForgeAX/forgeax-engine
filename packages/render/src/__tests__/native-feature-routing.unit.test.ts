import { expect, it } from 'vitest';
import { NativeFeatureWorkRouting } from '../features/frame-plan';
import type { RenderFeatureWork } from '../features/plan';

function work(scope: RenderFeatureWork['scope'], ...names: string[]): RenderFeatureWork {
  return {
    scope,
    resources: names.map((name) => ({ name, kind: 'buffer', size: 16, usage: ['storage'] })),
    passes: [],
  } as unknown as RenderFeatureWork;
}
it('retains scoped name relationships while publishing current resources and retiring removed scopes', () => {
  const routing = new NativeFeatureWorkRouting();
  const first = routing.resolve([work('frame', 'shared'), work({ view: 'a' }, 'local')]);
  const nextWork = [work('frame', 'shared'), work({ view: 'a' }, 'local')];
  const next = routing.resolve(nextWork);
  expect(next[0]?.keys).toBe(first[0]?.keys);
  expect(next[1]?.keys).toBe(first[1]?.keys);
  expect(next[1]?.work).toBe(nextWork[1]);
  expect(next[1]?.closure.resources[0]).toBe(nextWork[0]?.resources[0]);
  expect(next[1]?.closure.resources[1]).toBe(nextWork[1]?.resources[0]);
  const changed = routing.resolve([work('frame', 'renamed'), work({ view: 'a' }, 'local')]);
  expect(changed[1]?.keys).not.toBe(first[1]?.keys);
  expect(changed[1]?.keys.has('shared')).toBe(false);
  expect(first[1]?.keys.has('shared')).toBe(true);
  routing.resolve([]);
  expect(routing.resolve(nextWork)[1]?.keys).not.toBe(first[1]?.keys);
});
it('revalidates changed shared/local names and rejects newly colliding declarations', () => {
  const routing = new NativeFeatureWorkRouting();
  routing.resolve([work('frame', 'shared'), work({ view: 'a' }, 'local')]);
  expect(() => routing.resolve([work('frame', 'local'), work({ view: 'a' }, 'local')])).toThrow(
    'Duplicate native feature resource',
  );
  expect(() => routing.resolve([work('frame', 'shared'), work({ view: 'a' }, 'x', 'x')])).toThrow(
    'Duplicate native feature resource',
  );
  const rows = routing.resolve([work({ view: 'a' }, 'local'), work('frame', 'shared')]);
  expect(rows[0]?.work.scope).toBe('frame');
  expect(rows[1]?.keys.get('shared')).toBe('["frame","shared"]');
});
