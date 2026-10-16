import { describe, expectTypeOf, it } from 'vitest';
import type { Asset, AssetEnvelope, AssetRef, ImportedAsset } from '../index.js';

describe('AssetRef vocabulary characterization', () => {
  it('keeps the public envelope and reference fields stable', () => {
    const reference: AssetRef = {
      guid: '00000000-0000-4000-a000-000000000001',
      sourceField: { componentName: 'MeshRenderer', fieldName: 'materials', arrayIndex: 0 },
      sceneEntityKey: 'entity-7',
    };
    const envelope: AssetEnvelope = {
      guid: '00000000-0000-4000-a000-000000000002',
      kind: 'mesh',
      payload: { kind: 'mesh' } as Asset,
      refs: [reference],
    };

    expectTypeOf(envelope.refs).toMatchTypeOf<readonly AssetRef[]>();
    expectTypeOf(reference.sourceField).toMatchTypeOf<
      | {
          readonly componentName?: string;
          readonly fieldName: string;
          readonly arrayIndex?: number;
        }
      | undefined
    >();
    expectTypeOf<ImportedAsset['artifacts']>().toMatchTypeOf<Readonly<Record<string, unknown>>>();
  });
});
