import { type BuildDdcInput, semanticBuildKey } from '@forgeax/engine-ddc';
import { describe, expect, it } from 'vitest';

const base = {
  schemaVersion: '2.0.0',
  importerVersion: 'fixture@1',
  codecVersion: 'codec@1',
  sourceDependencies: [{ path: 'model.source', digest: 'source-digest' }],
  settings: { profile: 'dev' },
  declaredGuids: ['11111111-1111-4111-8111-111111111111'],
  cookProfile: 'dev',
} as const;

function key(input: Record<string, unknown> = {}): string {
  return semanticBuildKey({ ...base, ...input } as BuildDdcInput);
}

describe('semantic DDC key for source overrides', () => {
  it('distinguishes different non-empty override payloads', () => {
    expect(key({ sourceOverrides: { 'mesh/main': { lod: 1 } } })).not.toBe(
      key({ sourceOverrides: { 'mesh/main': { lod: 2 } } }),
    );
  });

  it('canonicalizes omitted and empty maps to the legacy key', () => {
    expect(key({ sourceOverrides: {} })).toBe(key());
  });

  it('does not include UI state or file paths in the semantic identity', () => {
    const a = key({ sourceOverrides: { 'mesh/main': { lod: 1 } } });
    const b = key({
      sourceOverrides: { 'mesh/main': { lod: 1 } },
      sourcePath: '/moved/model.source',
      panelState: { expanded: true },
    });
    expect(a).toBe(b);
    expect(key({ sourceOverrides: { 'mesh/main': { lod: 1 } }, sourcePath: 'one' })).toBe(
      key({ sourceOverrides: { 'mesh/main': { lod: 1 } }, sourcePath: 'two' }),
    );
  });

  it('invalidates the fingerprint when the producer implementation version changes', () => {
    expect(key({ importerVersion: 'fixture@2' })).not.toBe(key({ importerVersion: 'fixture@1' }));
  });
});
