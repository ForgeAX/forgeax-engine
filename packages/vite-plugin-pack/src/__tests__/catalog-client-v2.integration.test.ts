import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createCatalogClient } from '../catalog-client.js';

const rows: readonly CatalogEntry[] = [
  {
    guid: 'a',
    kind: 'mesh',
    sourcePath: 'model.glb',
    packageUrl: '/preview/packages/model',
  },
  {
    guid: 'b',
    kind: 'texture',
    sourcePath: 'model.glb',
    packageUrl: '/preview/packages/model',
  },
];

describe('catalog client v2', () => {
  it('enumerates package navigation without interpreting artifact content', async () => {
    let requested = 0;
    const client = createCatalogClient(async () => {
      requested += 1;
      return rows;
    }, undefined);

    expect(await client.enumerate()).toEqual(rows);
    expect(requested).toBe(1);
    expect(rows[0]?.packageUrl).toBe('/preview/packages/model');
    expect(rows[0]).toHaveProperty('packageUrl');
    expect(rows[0]).not.toHaveProperty('compression');
  });

  it('forwards a packageUrl-only delta for a multi-asset package', () => {
    const delta: CatalogDelta = { added: rows, changed: [], removed: [] };
    let listener: ((data: unknown) => void) | undefined;
    const client = createCatalogClient(async () => rows, {
      on(_event, next) {
        listener = next;
      },
      off() {
        listener = undefined;
      },
    });
    const received: CatalogDelta[] = [];
    client.subscribe((next) => received.push(next));
    listener?.(delta);

    expect(received).toEqual([delta]);
    expect(delta.added.every((row) => row.packageUrl === '/preview/packages/model')).toBe(true);
  });
});
