import { describe, expect, it } from 'vitest';
import { runHeadless } from '../src/lab/feature';
import { collectFeatures } from '../src/lab/registry';

// Headless features are pure logic, so the same checks the browser panel shows run
// here in Node; src/node-features/ holds Node-only probes (build-time owners) that
// the browser bundle never imports. Node probes spawn builds and CLIs, hence the long timeout. Visual and live probes run in scripts/run-features.mjs.
const features = collectFeatures({
  ...import.meta.glob('../src/features/*/*.ts', { eager: true }),
  ...import.meta.glob('../src/node-features/*/*.ts', { eager: true }),
});

describe('feature-lab registry', () => {
  it('discovers uniquely named features', () => {
    const ids = features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(features.length).toBeGreaterThan(0);
  });
});

describe.each(features.filter((feature) => feature.definition.kind === 'headless'))('$id', (feature) => {
  const { knownIssue } = feature.definition;
  it(knownIssue === undefined ? 'passes every check' : `still reproduces: ${knownIssue}`, async () => {
    if (feature.definition.kind !== 'headless') return;
    const failed = (await runHeadless(feature.definition)).filter((item) => !item.ok);
    if (knownIssue === undefined) expect(failed).toEqual([]);
    else expect(failed.length, 'known issue no longer reproduces; remove knownIssue').toBeGreaterThan(0);
  }, 120_000);
});
