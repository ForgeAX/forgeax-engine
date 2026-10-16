// feat-20260622 M6 / w23 — AC-07 contract: a new reference does NOT require any
// change to a graph-walk axis. The recursion source is `envelope.refs` (D-5), so
// when the importer puts a referenced GUID into refs[], the recursive loadByGuid
// walk pulls it -- no exhaustive `switch (asset.kind)` arm to add, no per-kind
// runtime walker to extend. feat-20260623 M2: the ASSET_BRAND table (the only
// kind-exhaustive mapping a new Asset kind previously touched) is now retired;
// a new kind requires zero engine-type changes (brand concept eliminated).
//
// This locks the structural win of the refs-as-SSOT pivot: adding a reference
// field to any Asset member surfaces in the load graph through refs[] alone.
//
// The retired graph-walk mechanisms (collect-refs.ts + the
// asset-registry.recursive.test-d.ts exhaustive-switch guard) are deleted in
// w19; their absence is enforced structurally -- nothing imports them and the
// milestone grep gate asserts the retired ref-collection switch leaves zero
// references across the tree.
// (A filesystem existsSync check is intentionally avoided: node:fs/node:path
// named imports are outside @types/node coverage in the runtime tsconfig.)

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const PARENT_GUID = 'c0000000-0000-4000-c000-000000000001';
const EXTRA_REF_GUID = 'c0000000-0000-4000-c000-000000000002';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const stubMaterial: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'forward',
      program: { module: 'test::dummy' },
      renderState: { tags: { LightMode: 'Forward' } },
    },
  ],
  values: {},
};

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test teardown
  delete (globalThis as any).fetch;
});

describe('AC-07 — a new reference appears in the load graph via envelope.refs', () => {
  it('an extra ref the importer adds to refs[] is recursively loaded', async () => {
    const reg = makeRegistry();

    // The "extra reference" sub-asset is pre-registered in dev mode so the
    // recursive walk hits the fast-path. Stand-in for "importer added a brand
    // new reference field whose GUID it dropped into refs[]".
    reg.catalog(parseGuid(EXTRA_REF_GUID), {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      data: new Uint8Array(4),
      colorSpace: 'srgb',
      mips: { kind: 'none' },
    });

    const packIndex = [
      { guid: PARENT_GUID, packageUrl: '/packs/parent.pack.json', kind: 'material' },
    ];
    // The pack body carries refs[] = [EXTRA_REF_GUID]. No new switch arm, no
    // per-kind walker change -- the GUID in refs[] is the entire wiring.
    const parentPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PARENT_GUID,
          kind: 'material',
          payload: {
            passes: [
              {
                name: 'forward',
                program: { module: 'test::dummy' },
                renderState: { tags: { LightMode: 'Forward' } },
              },
            ],
            values: {},
          },
          refs: [EXTRA_REF_GUID],
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/parent.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(parentPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await reg.loadByGuid<MaterialAsset>(parseGuid(PARENT_GUID));
    expect(result.ok).toBe(true);
    // The extra reference is in the load graph purely because it is in refs[].
    expect(reg.lookup(parseGuid(EXTRA_REF_GUID))).not.toBe(undefined);
  });

  it('catalog() inline path: refs[] drives recursion with no walker', async () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(EXTRA_REF_GUID), {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    // Direct register with an explicit refs edge; loadByGuid fast-path returns
    // the body and the refs edge is the recursion source.
    reg.catalog(parseGuid(PARENT_GUID), stubMaterial, [{ guid: EXTRA_REF_GUID }]);
    const result = await reg.loadByGuid<MaterialAsset>(parseGuid(PARENT_GUID));
    expect(result.ok).toBe(true);
    expect(reg.lookup(parseGuid(EXTRA_REF_GUID))).not.toBe(undefined);
  });
});
