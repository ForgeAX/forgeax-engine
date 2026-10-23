import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import { expect, it } from 'vitest';
import { PublishedMaterialProjections } from '../material-projections';

const projection = (name: string) =>
  ({ materialGuid: name }) as unknown as MaterialRenderProjection;
const detach = (value: MaterialRenderProjection | undefined) => value ?? null;

it('names a resident holder only while it stays accepted and is not retiring', () => {
  const resident = new PublishedMaterialProjections();
  const shared = projection('shared');
  expect(resident.row(1, shared, [], detach)).toEqual({ materialProjection: shared });
  resident.accept([], new Map([[1, shared]]));
  // The same handle with the same projection is omitted.
  expect(resident.row(1, shared, [], detach)).toEqual({});
  // Another handle adopts the resident projection by holder.
  expect(resident.row(2, shared, [], detach)).toEqual({ materialProjectionSource: 1 });
  // A holder retiring in the same packet is never named.
  expect(resident.row(2, shared, [1], detach)).toEqual({ materialProjection: shared });
  resident.accept([], new Map([[2, shared]]));
  expect(resident.row(3, shared, [1], detach)).toEqual({ materialProjectionSource: 2 });
  // Retirement and replacement release holders.
  const other = projection('other');
  resident.accept([1], new Map([[2, other]]));
  expect(resident.row(3, shared, [], detach)).toEqual({ materialProjection: shared });
  expect(resident.row(3, other, [], detach)).toEqual({ materialProjectionSource: 2 });
  // A cleared projection is carried as null and never names a holder.
  expect(resident.row(2, undefined, [], detach)).toEqual({ materialProjection: null });
  resident.clear();
  expect(resident.row(2, other, [], detach)).toEqual({ materialProjection: other });
});
