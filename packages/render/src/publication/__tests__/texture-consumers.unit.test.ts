import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { preparedSnapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import type { MaterialSnapshot } from '../../render-system-extract';
import { CanvasTexture } from '../../textures/canvas-texture';
import { projectTextureConsumers, TextureConsumerEdits } from '../texture-consumers';

it('keeps candidate texture consumer changes separate from the accepted roster', () => {
  const row = preparedSnapshot(5, 1);
  const prior = new Map([[7, [3, 8]]]);
  const stable = projectTextureConsumers(prior, new Map(), new Set([99]), [row]).videos;
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
  const candidate = projectTextureConsumers(prior, new Map(), new Set([7]), [changedRow]).videos;
  expect([...prior]).toEqual([[7, [3, 8]]]);
  const projected = new Map<number, readonly number[]>();
  candidate.forEach((clips, entity) => {
    projected.set(entity, clips);
  });
  expect([...projected]).toEqual([[5, [11, 3]]]);
  if (!(candidate instanceof TextureConsumerEdits)) throw new Error('expected a membership edit');
  candidate.accept();
  expect([...prior]).toEqual([...projected]);
  const retired = projectTextureConsumers(prior, new Map(), new Set(), [row]).videos;
  expect(retired.size).toBe(0);
  expect(prior.get(5)).toEqual([11, 3]);
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
  const canvasRows = projectTextureConsumers(new Map(), new Map(), new Set(), [
    { ...preparedSnapshot(1, 1), materials: rows },
  ]);
  expect(canvasRows.canvases.get(1)).toEqual([first.source, second.source]);
  const empty = projectTextureConsumers(new Map(), new Map(), new Set(), [preparedSnapshot(1, 1)]);
  expect(empty.canvases.get(1)).toBeUndefined();
  expect(empty.videos.get(1)).toBeUndefined();
  const borrowed = {
    get videoTextureFields() {
      throw Error('source failed');
    },
  } as MaterialSnapshot;
  const accepted = new Map([[2, [1]]]);
  expect(() =>
    projectTextureConsumers(accepted, new Map(), new Set([2]), [
      { ...preparedSnapshot(1, 1), materials: [new MaterialResource(borrowed)] },
    ]),
  ).toThrow('source failed');
  expect([...accepted]).toEqual([[2, [1]]]);
  first.dispose();
  second.dispose();
});

it('stages and commits sparse edits without enumerating accepted members and appends reinsertions last', () => {
  const rows = new Map<number, readonly number[]>();
  for (let entity = 1; entity <= 1024; entity++) rows.set(entity, [entity]);
  const iterate = vi.spyOn(rows, Symbol.iterator);
  const walk = vi.spyOn(rows, 'forEach');
  const changed = new MaterialResource({
    ...preparedSnapshot(1, 1).material.snapshot,
    videoTextureFields: new Map([['video', Number(500) as AssetHandle<'video'>]]),
  });
  const edits = projectTextureConsumers(
    rows,
    new Map(),
    new Set([12, 22]),
    [12, 34].map((entity) => ({ ...preparedSnapshot(entity, 1), materials: [changed] })),
  ).videos;
  expect(iterate).not.toHaveBeenCalled();
  expect(walk).not.toHaveBeenCalled();
  expect(rows.get(12)).toEqual([12]);
  const observed = new Map<number, readonly number[]>();
  edits.forEach((clips, entity) => {
    observed.set(entity, clips);
  });
  expect(observed.size).toBe(1023);
  expect([...observed.keys()].at(-1)).toBe(12);
  expect(observed.get(34)).toEqual([500]);
  walk.mockClear();
  if (!(edits instanceof TextureConsumerEdits)) throw new Error('expected edits');
  edits.accept();
  expect(walk).not.toHaveBeenCalled();
  expect(iterate).not.toHaveBeenCalled();
  expect([...rows.keys()]).toEqual([...observed.keys()]);
});
