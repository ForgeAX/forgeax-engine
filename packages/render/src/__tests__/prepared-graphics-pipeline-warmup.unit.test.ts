import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ownerSource = readFileSync(new URL('../render-system.ts', import.meta.url), 'utf8');
const resolverSource = readFileSync(
  new URL('../record/prepared-material-bindings.ts', import.meta.url),
  'utf8',
);

describe('prepared graphics material pipeline warmup', () => {
  it('does not substitute an unrelated unlit pipeline while the authored shader warms', () => {
    const start = ownerSource.indexOf('const preparedPipeline =');
    const end = ownerSource.indexOf('resolveBindings:', start);
    const owner = ownerSource.slice(start, end);

    expect(owner).toContain('const pipeline = preparedPipeline ?? null');
    expect(owner).not.toContain('unlitPipeline');
    expect(owner).toContain('err(makePreparedPipelinePendingError())');
  });

  it('keeps view-only material bindings on the canonical view group with depth', () => {
    const declaration = resolverSource.indexOf('preparedViewOnlyPipelines: new WeakSet()');
    const classification = ownerSource.indexOf('preparedViewOnlyPipelines.add', declaration);
    const bindingResolution = ownerSource.indexOf(
      'preparedViewOnlyPipelines.has(pipeline as object)',
      classification,
    );

    expect(declaration).toBeGreaterThan(-1);
    expect(classification).toBeGreaterThan(-1);
    expect(bindingResolution).toBeGreaterThan(classification);
  });
});
