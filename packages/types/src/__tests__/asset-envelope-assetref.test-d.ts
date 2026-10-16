// asset-envelope-assetref.test-d.ts — type-level assertions for AssetEnvelope
// and AssetRef (feat-20260622-asset-ref-graph-protocol-unification-refs-as-ssot
// M1 / w2).
//
// Assertions:
// (a) AssetEnvelope.refs elements conform to AssetRef.
// (b) AssetRef.sourceField allows undefined for texture edges (D-2).
// (c) AssetRef.sourceField structured triple fields are correctly typed
//     (componentName/fieldName: string, arrayIndex?: number).
// (d) ImportedAsset adds the asset-local artifact map to the envelope shape.
// (e) Asset union still satisfies AssetEnvelope.payload constraint
//     (AC-01 envelope type exists).
//
// Anchors: requirements AC-01 (envelope type existence) + AC-02 (refs edge
//          metadata shape); plan-strategy D-1 / D-2 / D-3.

import { describe, expectTypeOf, it } from 'vitest';
import type { Asset, AssetEnvelope, AssetRef, ImportedAsset } from '../index';

describe('AssetEnvelope + AssetRef type-level contract (w2)', () => {
  it('(a) AssetEnvelope.refs elements conform to AssetRef', () => {
    const ref: AssetRef = { guid: '00000000-0000-4000-a000-000000000001' };
    const envelope: AssetEnvelope = {
      guid: '00000000-0000-4000-a000-000000000002',
      kind: 'mesh',
      payload: { kind: 'mesh' } as Asset,
      refs: [ref],
    };
    expectTypeOf(envelope.refs).toMatchTypeOf<readonly AssetRef[]>();
  });

  it('(b) AssetRef.sourceField allows undefined for texture edges (D-2)', () => {
    expectTypeOf<AssetRef['sourceField']>().toEqualTypeOf<
      | {
          readonly componentName?: string;
          readonly fieldName: string;
          readonly arrayIndex?: number;
        }
      | undefined
    >();
  });

  it('(c) AssetRef.sourceField structured triple fields are correctly typed', () => {
    const edge: AssetRef = {
      guid: '00000000-0000-4000-a000-000000000004',
      sourceField: { componentName: 'MeshRenderer', fieldName: 'materials', arrayIndex: 1 },
    };
    const sf = edge.sourceField;
    if (!sf) throw new Error('sourceField must be set for this test');
    expectTypeOf(sf).toMatchTypeOf<{
      readonly componentName?: string;
      readonly fieldName: string;
      readonly arrayIndex?: number;
    }>();
    expectTypeOf(sf.componentName).toEqualTypeOf<string | undefined>();
    expectTypeOf(sf.fieldName).toBeString();
    // arrayIndex is optional
    expectTypeOf(sf.arrayIndex).toEqualTypeOf<number | undefined>();
  });

  it('(d) ImportedAsset adds asset-local artifacts to AssetEnvelope', () => {
    expectTypeOf<ImportedAsset['artifacts']>().toMatchTypeOf<Readonly<Record<string, unknown>>>();
  });

  it('(e) Asset union satisfies AssetEnvelope.payload constraint', () => {
    // AC-01: AssetEnvelope.payload is Asset — the closed union is unchanged.
    const envelope: AssetEnvelope = {
      guid: '00000000-0000-4000-a000-000000000006',
      kind: 'material',
      payload: { kind: 'material' } as Asset,
      refs: [],
    };
    expectTypeOf(envelope.payload).toMatchTypeOf<Asset>();
    expectTypeOf(envelope.kind).toBeString();
    expectTypeOf(envelope.guid).toBeString();
  });
});
