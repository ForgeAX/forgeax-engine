import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../main-pass-geometry.ts', import.meta.url), 'utf8');

describe('main-pass material pipeline cache', () => {
  it('keeps transient pending pipelines retryable across a tight frame loop', () => {
    const resolverStart = source.indexOf('const resolveMaterialPipeline =');
    const resolverEnd = source.indexOf(
      'for (let i = 0; i < validatedOrdered.length;',
      resolverStart,
    );
    const resolver = source.slice(resolverStart, resolverEnd);
    const pendingGuard = resolver.indexOf('if (handle !== null) {');
    const cachedInsert = resolver.indexOf('cachedLookups.push(nextLookup)', pendingGuard);
    const guardEnd = resolver.indexOf('\n    }\n    return handle;', pendingGuard);

    expect(pendingGuard).toBeGreaterThan(-1);
    expect(cachedInsert).toBeGreaterThan(pendingGuard);
    expect(guardEnd).toBeGreaterThan(cachedInsert);
  });
});
