import { toShared } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { preparedSnapshot } from '../../__tests__/gpu-driven-production-fixture';
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
      {
        ...row.material,
        videoTextureFields: new Map([
          ['a', toShared<'VideoAsset'>(11)],
          ['b', toShared<'VideoAsset'>(11)],
          ['c', toShared<'VideoAsset'>(3)],
        ]),
      },
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
    {
      ...material,
      textureSources: new Map([
        ['a', first.source],
        ['b', first.source],
      ]),
    },
    { ...material, textureSources: new Map([['c', second.source]]) },
  ];
  expect(materialCanvasSources(rows)).toEqual([first.source, second.source]);
  expect(materialCanvasSources([material])).toBeUndefined();
  expect(materialVideoClips([material])).toBeUndefined();
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
      [{ ...preparedSnapshot(1, 1), materials: [borrowed] }],
      materialVideoClips,
    ),
  ).toThrow('source failed');
  expect([...accepted]).toEqual([[2, [1]]]);
  first.dispose();
  second.dispose();
});
