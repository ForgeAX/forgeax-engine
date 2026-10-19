import { describe, expectTypeOf, it } from 'vitest';
import type { DdcErrorRootKind } from '../errors.js';
import type { BrowserDdcStatusLayer, DdcStatusLayer, DdcStatusRootKind } from '../index.js';

type ExpectedRootKinds = 'build-cache' | 'project-ddc' | 'runtime';
type LayerRootKind = DdcStatusLayer['rootKind'];
type BrowserLayerRootKind = BrowserDdcStatusLayer['rootKind'];

describe('DDC status root kind owner', () => {
  it('keeps the exact root membership and derives status from the error owner', () => {
    expectTypeOf<DdcErrorRootKind>().toEqualTypeOf<ExpectedRootKinds>();
    expectTypeOf<ExpectedRootKinds>().toEqualTypeOf<DdcErrorRootKind>();
    expectTypeOf<DdcStatusRootKind>().toEqualTypeOf<DdcErrorRootKind>();
    expectTypeOf<DdcErrorRootKind>().toEqualTypeOf<DdcStatusRootKind>();

    const acceptsRootKind = (kind: DdcStatusRootKind): DdcStatusRootKind => kind;
    acceptsRootKind('build-cache');
    acceptsRootKind('project-ddc');
    acceptsRootKind('runtime');
    // @ts-expect-error unknown root kinds remain outside the closed owner union.
    acceptsRootKind('root-kind-not-real');
  });

  it('preserves the layer/root distinction and browser projection', () => {
    expectTypeOf<DdcStatusLayer['kind']>().toEqualTypeOf<'build' | 'project' | 'runtime'>();
    expectTypeOf<LayerRootKind>().toEqualTypeOf<DdcErrorRootKind>();
    expectTypeOf<BrowserLayerRootKind>().toEqualTypeOf<DdcErrorRootKind>();
  });
});
