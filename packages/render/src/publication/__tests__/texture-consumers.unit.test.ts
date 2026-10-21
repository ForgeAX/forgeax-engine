import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { preparedSnapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot } from '../../render-system-extract';
import { CanvasTexture } from '../../textures/canvas-texture';
import {
  materialCanvasSources,
  materialVideoClips,
  projectTextureConsumers,
} from '../texture-consumers';

it('keeps candidate texture consumer changes separate from the accepted roster', () => {
  const row = preparedSnapshot(5, 1);
  const prior = new Map([[7, [3, 8]]]);
  const stable = projectTextureConsumers(prior, new Set([99]), [row], materialVideoClips);
  expect(stable).toBe(prior);
  const changedRow = {
    ...row,
    materials: [
      new MaterialResource({
        ...row.material.snapshot,
        videoTextureFields: new Map([
          ['a', Number(11) as AssetHandle<'video'>],
          ['b', Number(11) as AssetHandle<'video'>],
          ['c', Number(3) as AssetHandle<'video'>],
        ]),
      }),
    ],
  };
  const candidate = projectTextureConsumers(prior, new Set([7]), [changedRow], materialVideoClips);
  expect([...prior]).toEqual([[7, [3, 8]]]);
  expect([...candidate]).toEqual([[5, [11, 3]]]);
  const retired = projectTextureConsumers(candidate, new Set(), [row], materialVideoClips);
  expect(retired.size).toBe(0);
  expect(candidate.get(5)).toEqual([11, 3]);
});

it('deduplicates canvas owners and leaves texture-free materials empty', () => {
  const first = new CanvasTexture({ width: 0, height: 0 } as OffscreenCanvas);
  const second = new CanvasTexture({ width: 0, height: 0 } as OffscreenCanvas);
  const material = preparedSnapshot(1, 1).material;
  const rows = [
    new MaterialResource({
      ...material.snapshot,
      textureSources: new Map([
        ['a', first.source],
        ['b', first.source],
      ]),
    }),
    new MaterialResource({ ...material.snapshot, textureSources: new Map([['c', second.source]]) }),
  ];
  expect(materialCanvasSources(rows.map((row) => row.snapshot))).toEqual([
    first.source,
    second.source,
  ]);
  expect(materialCanvasSources([material.snapshot])).toBeUndefined();
  expect(materialVideoClips([material.snapshot])).toBeUndefined();
  const borrowed = {
    get videoTextureFields() {
      throw Error('source failed');
    },
  } as MaterialSnapshot;
  const accepted = new Map([[2, [1]]]);
  expect(() =>
    projectTextureConsumers(
      accepted,
      new Set([2]),
      [{ ...preparedSnapshot(1, 1), materials: [new MaterialResource(borrowed)] }],
      materialVideoClips,
    ),
  ).toThrow('source failed');
  expect([...accepted]).toEqual([[2, [1]]]);
  first.dispose();
  second.dispose();
});
