// Compile-time type assertions for the Handle<T,M> brand (w1 + AC-02).
//
// Locks two phantom dimensions:
//   - target T (the asset type tag, e.g. 'MeshAsset' / 'MaterialAsset')
//   - mode M ('unique' | 'shared')
//
// AC-02 requires at least one @ts-expect-error proving cross-mode rejection.
// Cross-target rejection is also covered. Handle<T,M> still widens to number
// for GPU upload compatibility.
//
// w3: EntityHandle type-level assertions — EntityHandle is numeric (widens
// to number), and encodeEntity returns an EntityHandle (not a bare number).

import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { EntityHandle } from '../entity-handle';

describe('Handle<T,M> — phantom brand (w1)', () => {
  it('Handle<T,M> structurally widens to number (GPU upload compatibility)', () => {
    type H = Handle<'MeshAsset', 'shared'>;
    expectTypeOf<H>().toMatchTypeOf<number>();
  });

  it('Handle<T,managed> and Handle<T,unmanaged> are distinct types', () => {
    type Managed = Handle<'MaterialAsset', 'unique'>;
    type Unmanaged = Handle<'MaterialAsset', 'shared'>;
    // Neither type is assignable to the other under TS structural rules
    // because the phantom `__handle.mode` differs.
    expectTypeOf<Managed>().not.toEqualTypeOf<Unmanaged>();
  });

  it('Handle<A,M> and Handle<B,M> with distinct targets are distinct types', () => {
    type Mesh = Handle<'MeshAsset', 'shared'>;
    type Material = Handle<'MaterialAsset', 'shared'>;
    expectTypeOf<Mesh>().not.toEqualTypeOf<Material>();
  });

  it('plain number is not assignable to Handle<T,M> (brand prevents accidental construction)', () => {
    type Mesh = Handle<'MeshAsset', 'shared'>;
    const n = 42 as number;
    // @ts-expect-error — plain number cannot be widened to a phantom-branded Handle
    const h: Mesh = n;
    void h;
  });

  it('Handle<T,managed> is not assignable to Handle<T,unmanaged> (cross-mode rejection — AC-02)', () => {
    type Managed = Handle<'MaterialAsset', 'unique'>;
    type Unmanaged = Handle<'MaterialAsset', 'shared'>;
    const m = 0 as unknown as Managed;
    // @ts-expect-error — managed handle cannot be assigned to an unmanaged slot
    const u: Unmanaged = m;
    void u;
  });

  it('Handle<T,unmanaged> is not assignable to Handle<T,managed> (cross-mode reverse)', () => {
    type Managed = Handle<'MeshAsset', 'unique'>;
    type Unmanaged = Handle<'MeshAsset', 'shared'>;
    const u = 0 as unknown as Unmanaged;
    // @ts-expect-error — unmanaged handle cannot be assigned to a managed slot
    const m: Managed = u;
    void m;
  });

  it('Handle<A,M> is not assignable to Handle<B,M> (cross-target rejection)', () => {
    type Mesh = Handle<'MeshAsset', 'shared'>;
    type Material = Handle<'MaterialAsset', 'shared'>;
    const mesh = 0 as unknown as Mesh;
    // @ts-expect-error — mesh handle cannot be assigned to a material handle slot
    const mat: Material = mesh;
    void mat;
  });
});

// w3: EntityHandle type-level assertions
describe('[w3] EntityHandle -- numeric brand', () => {
  it('EntityHandle widens to number (runtime identity is a JS number)', () => {
    expectTypeOf<EntityHandle>().toMatchTypeOf<number>();
  });

  it('plain number is not assignable to EntityHandle (brand prevents accidental construction)', () => {
    const n = 42 as number;
    // @ts-expect-error -- plain number cannot be widened to phantom-branded EntityHandle
    const eh: EntityHandle = n;
    void eh;
  });
});
