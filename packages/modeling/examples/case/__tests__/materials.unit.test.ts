import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { publishMaterials } from '../render';

interface PublishedPack {
  readonly assets: readonly {
    readonly guid: string;
    readonly kind: string;
    readonly payload: { readonly cooked: unknown };
  }[];
}

describe('native case material publication', () => {
  it('loads distinct material values through shared storage-WebGPU program transport', {
    timeout: 120_000,
  }, async () => {
    const assets = new AssetRegistry();
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    const installed = vi.spyOn(assets, 'setCatalogSource');
    try {
      const handles = await publishMaterials(assets, {
        red: () => ({ baseColor: [1, 0, 0, 1], roughness: 0.25 }),
        blue: () => ({ baseColor: [0, 0, 1, 1], roughness: 0.75 }),
      });
      expect([...handles.keys()]).toEqual(['red', 'blue']);
      const source = installed.mock.calls[0]?.[0];
      if (source === undefined) throw new Error('case materials did not install their Catalog');
      const fetch = source.openPackage?.('case-pack://case/pack.json');
      if (fetch === undefined)
        throw new Error('case Catalog did not retain its actual package bytes');
      const response = await fetch('case-pack://case/pack.json');
      const wire = await response.json();
      const decoded = decodeMaterialProgramWire(wire);
      if (!decoded.ok) throw decoded.error;
      const pack = decoded.value as PublishedPack;
      const materials = pack.assets.filter((asset) => asset.kind === 'material');
      expect(materials).toHaveLength(2);
      const records = materials.map((asset) =>
        validateCookedMaterialRecord(asset.payload.cooked).unwrap(),
      );
      for (const record of records) {
        expect(record.programs.length).toBeGreaterThan(0);
        expect(record.programs.every((program) => program.artifact.bytes.byteLength > 0)).toBe(
          true,
        );
        expect(
          record.programs
            .flatMap((program) => program.selections)
            .every(
              ({ context }) =>
                context.backend === 'webgpu' && context.capability !== 'uniform-fallback',
            ),
        ).toBe(true);
      }
      for (const [name, color] of [
        ['red', [1, 0, 0, 1]],
        ['blue', [0, 0, 1, 1]],
      ] as const) {
        const handle = handles.get(name);
        if (handle === undefined) throw new Error(`missing material ${name}`);
        expect(assets.read(handle).unwrap().values?.baseColor).toEqual(color);
      }
      expect((wire as { readonly schemaVersion?: string }).schemaVersion).toBe(
        'pack-material-programs/2',
      );
      const left = (materials[0]?.payload.cooked as { readonly programs: readonly unknown[] })
        .programs;
      const right = (materials[1]?.payload.cooked as { readonly programs: readonly unknown[] })
        .programs;
      expect(left.some((program) => right.includes(program))).toBe(true);
      for (const handle of handles.values()) assets.release(handle).unwrap();
    } finally {
      installed.mockRestore();
      assets.dispose();
    }
  });

  it('keeps prior values independent when the file-owned cooker serves another Registry', {
    timeout: 120_000,
  }, async () => {
    const first = new AssetRegistry();
    const second = new AssetRegistry();
    for (const assets of [first, second]) {
      assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    }
    try {
      const initial = await publishMaterials(first, {
        paint: () => ({ baseColor: [1, 0, 0, 1], roughness: 0.25 }),
      });
      const changed = await publishMaterials(second, {
        paint: () => ({ baseColor: [0, 1, 0, 1], roughness: 0.75 }),
      });
      const a = initial.get('paint');
      const b = changed.get('paint');
      if (a === undefined || b === undefined) throw new Error('missing published paint');
      expect(first.read(a).unwrap().values?.baseColor).toEqual([1, 0, 0, 1]);
      expect(first.read(a).unwrap().values?.roughness).toBe(0.25);
      expect(second.read(b).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
      expect(second.read(b).unwrap().values?.roughness).toBe(0.75);
      first.release(a).unwrap();
      second.release(b).unwrap();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
