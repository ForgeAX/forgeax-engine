import type { CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { CatalogHotChannel } from '../catalog-client.js';
import { createCatalogClient } from '../catalog-client.js';

const GUID = '019ffa97-3000-7000-8000-000000000901';
const SOURCE_KEY = 'color-grading/neutral';
const DIGEST = 'sha256:cube-neutral';

function row(generation: number): CatalogEntry {
  return {
    guid: GUID,
    kind: 'texture',
    sourcePath: 'assets/neutral.cube',
    sourceKey: SOURCE_KEY,
    sourceIndex: 0,
    packageUrl: `/__pack/scopes/demo/${generation}/asset/${GUID}.pack.json`,
    publication: {
      schemaVersion: 'asset-publication/1',
      sourcePath: 'assets/neutral.cube',
      sourceRevision: `sha256:source-${generation}`,
      generation,
      digest: DIGEST,
      outputSetDigest: DIGEST,
      outputs: [{ guid: GUID, sourceKey: SOURCE_KEY, kind: 'texture', digest: DIGEST, refs: [] }],
      receipt: {
        schemaVersion: 'asset-publication-receipt/1',
        sourcePath: 'assets/neutral.cube',
        sourceRevision: `sha256:source-${generation}`,
        inputFingerprint: DIGEST,
        outputDigest: DIGEST,
        outputSetDigest: DIGEST,
        externalEvidence: [],
      },
      externalEvidence: [],
    },
  };
}

describe('cube texture dev transport', () => {
  it('preserves ordinary texture identity through JSON stringify/fetch/parse', async () => {
    const sourceRows = [row(3)];
    const response = new Response(JSON.stringify(sourceRows));
    const client = createCatalogClient(
      async () => JSON.parse(await response.text()) as CatalogEntry[],
      undefined,
    );

    const received = await client.enumerate();
    expect(received).toEqual(sourceRows);
    expect(received[0]).toMatchObject({
      guid: GUID,
      kind: 'texture',
      sourceKey: SOURCE_KEY,
      publication: { generation: 3, digest: DIGEST },
    });
  });

  it('reconciles a repaired generation over the same source identity', async () => {
    let serve = row(1);
    let listener: ((data: unknown) => void) | undefined;
    const hot: CatalogHotChannel = {
      on(_event, next) {
        listener = next;
      },
      off() {
        listener = undefined;
      },
    };
    const client = createCatalogClient(
      async () => JSON.parse(JSON.stringify([serve])) as CatalogEntry[],
      hot,
    );
    const updates: unknown[] = [];
    const stop = client.subscribe((delta) => updates.push(delta));
    expect(await client.enumerate()).toEqual([row(1)]);

    serve = row(2);
    listener?.({ added: [], changed: [row(2)], removed: [], generation: 2, scopeId: 'demo' });
    expect(updates).toEqual([
      { added: [], changed: [row(2)], removed: [], generation: 2, scopeId: 'demo' },
    ]);
    expect((updates[0] as { changed: readonly CatalogEntry[] }).changed[0]).toMatchObject({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      publication: { generation: 2 },
    });
    stop();
  });
});
