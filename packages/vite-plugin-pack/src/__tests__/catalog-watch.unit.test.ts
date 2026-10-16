import { calculateCatalogDelta } from '@forgeax/engine-pack/build';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const entry = (guid: string, packageUrl = `/assets/${guid}.bin`): PackIndexEntry => ({
  guid,
  kind: 'texture',
  packageUrl,
  sourcePath: `${guid}.png`,
});

const richEntry = (guid: string, relativeUrl: string): PackIndexEntry => ({
  ...entry(guid, relativeUrl),
  packageId: 'pkg/watch',
  provenance: { provider: 'watch-fixture', version: '1.0.0' },
  revision: { digest: 'sha256:watch', observedAt: 1, rootId: 'root-watch' },
  sourceKey: 'watch/main',
  sourceIndex: 0,
  relations: [
    {
      from: { type: 'asset', id: guid },
      to: { type: 'asset', id: '019e2cc6-0c86-79da-aa76-b0984c86d45b' },
      type: 'references',
      provenance: { provider: 'watch-fixture', version: '1.0.0' },
    },
  ],
  diagnostics: [{ code: 'watch-note', severity: 'warning', hint: 'recheck revision' }],
});

describe('catalog-watch', () => {
  it('derives the final-state GUID diff with normalized removals', () => {
    const delta = calculateCatalogDelta(
      [
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45a'),
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45b'),
      ],
      [
        {
          ...entry('019e2cc6-0c86-79da-aa76-b0984c86d45a'),
          guid: '019E2CC6-0C86-79DA-AA76-B0984C86D45A',
        },
        entry('019e2cc6-0c86-79da-aa76-b0984c86d45c'),
      ],
    );

    expect(delta).toEqual({
      added: [entry('019e2cc6-0c86-79da-aa76-b0984c86d45c')],
      changed: [],
      removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45b'],
    });
  });

  it('reports changed rows without putting a GUID in more than one set', () => {
    const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45a';
    const delta = calculateCatalogDelta([entry(guid)], [entry(guid, '/assets/rebuilt.bin')]);

    expect(delta).toEqual({
      added: [],
      changed: [entry(guid, '/assets/rebuilt.bin')],
      removed: [],
    });
  });

  it('does not emit a delta when the final projection is unchanged', () => {
    expect(
      calculateCatalogDelta(
        [entry('019e2cc6-0c86-79da-aa76-b0984c86d45a')],
        [entry('019e2cc6-0c86-79da-aa76-b0984c86d45a')],
      ),
    ).toBeUndefined();
  });

  it('preserves full producer facts in a locator and revision delta', () => {
    const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45a';
    const next = {
      ...richEntry(guid, '/assets/new.bin'),
      revision: { digest: 'sha256:watch-2', observedAt: 2, rootId: 'root-watch' },
    };
    const delta = calculateCatalogDelta([richEntry(guid, '/assets/old.bin')], [next]);

    expect(delta).toMatchObject({ added: [], removed: [], changed: [next] });
    expect(delta?.changed[0]).toMatchObject({
      packageId: 'pkg/watch',
      sourceKey: 'watch/main',
      relations: richEntry(guid, '/assets/old.bin').relations,
      diagnostics: [{ code: 'watch-note', hint: 'recheck revision' }],
      revision: { digest: 'sha256:watch-2', observedAt: 2 },
    });
  });

  it('does not group topology by a locator when package identity is absent', () => {
    const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45a';
    const previous = {
      ...entry(guid, '/assets/old.bin'),
      sourceKey: 'watch/main',
      sourceIndex: 0,
    };
    const next = {
      ...entry(guid, '/assets/new.bin'),
      sourceKey: 'watch/main',
      sourceIndex: 0,
    };

    const delta = calculateCatalogDelta([previous], [next]);
    expect(delta?.topology).toBeUndefined();
  });
});
