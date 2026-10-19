import type { CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { previewThumbnailInput } from '../thumbnail.js';

const row = (guid: string, digest: string, refs: string[] = []): CatalogEntry => ({
  guid,
  kind: 'mesh',
  packageUrl: '/pack',
  sourcePath: '/source',
  lifecycle: 'current',
  refs,
  revision: { rootId: 'project', observedAt: 0, digest },
});
const input = (entries: CatalogEntry[]) =>
  previewThumbnailInput(new Map(entries.map((item) => [item.guid, item])), 'mesh');

describe('preview thumbnail semantic inputs', () => {
  it('invalidates a recursive dependency and preserves unrelated edits and restarts', () => {
    const mesh = row('mesh', 'mesh-1', ['material']);
    const material = row('material', 'material-1', ['texture']);
    const texture = row('texture', 'texture-1');
    const initial = input([mesh, material, texture, row('other', 'old')]);
    expect(
      input([
        row('other', 'new'),
        texture,
        material,
        {
          ...mesh,
          name: 'renamed',
          packageUrl: '/new',
          revision: { rootId: 'project', digest: 'mesh-1', observedAt: 20 },
        },
      ]),
    ).toBe(initial);
    expect(input([mesh, material, row('texture', 'texture-2')])).not.toBe(initial);
    expect(input([row('mesh', 'mesh-2', ['material']), material, texture])).not.toBe(initial);
  });
  it('rejects missing, stale and unversioned dependencies and accepts bounded cycles', () => {
    const mesh = row('mesh', '1', ['material']);
    expect(input([mesh])).toBeUndefined();
    expect(input([mesh, { ...row('material', '1'), lifecycle: 'stale' }])).toBeUndefined();
    const { revision: _revision, ...unversioned } = row('material', '1');
    expect(input([mesh, unversioned])).toBeUndefined();
    expect(input([mesh, row('material', '1', ['mesh'])])).toBeDefined();
  });
  it('uses the selected output and its refs rather than a sibling output-set digest', () => {
    const publication = {
      outputs: [{ guid: 'mesh', kind: 'mesh', sourceKey: 'mesh', digest: 'output-1', refs: [] }],
      digest: 'package-1',
      outputSetDigest: 'siblings-1',
      generation: 1,
    } as unknown as NonNullable<CatalogEntry['publication']>;
    const mesh = { ...row('mesh', 'package-1'), publication };
    const initial = input([mesh]);
    expect(
      input([
        { ...mesh, publication: { ...publication, generation: 2, outputSetDigest: 'siblings-2' } },
      ]),
    ).toBe(initial);
    expect(
      input([
        {
          ...mesh,
          publication: {
            ...publication,
            outputs: [
              { guid: 'mesh', kind: 'mesh', sourceKey: 'mesh', digest: 'output-2', refs: [] },
            ],
          },
        },
      ]),
    ).not.toBe(initial);
  });
});
