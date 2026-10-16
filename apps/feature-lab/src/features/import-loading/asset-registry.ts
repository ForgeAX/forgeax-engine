import { Materials } from '@forgeax/engine/render';
import type { MaterialAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage } from '../../lab/stage';

const VALID = '019f1a00-0000-7000-8000-0000000000a1';
const INVALID = '019f1a00-0000-7000-8000-0000000000a2';
const MISSING = '019f1a00-0000-7000-8000-0000000000a3';

function code(error: unknown): string {
  return String((error as { code?: unknown }).code);
}

export default defineFeature({
  title: 'AssetRegistry',
  catalog: 'AssetRegistry',
  kind: 'probe',
  summary:
    "The live App's AssetRegistry (app.assets) owns the GUID -> payload catalogue. Inline catalog() validates the payload before it becomes visible, invalidate() retracts it, and the loaded payload renders through an ordinary shared ref.",
  expect:
    'A green quad renders from the catalogued material. Checks: app.assets exists, a valid material catalogs and resolves by GUID, an empty-pass material is rejected and stays invisible, invalidate retracts the GUID, an uncatalogued GUID fails with a structured code.',
  async setup({ app, world }) {
    spawnStage(world);
    const assets = app.assets;
    const checks: FeatureCheck[] = [{ name: 'app.assets is wired', ok: assets !== undefined }];
    if (assets === undefined) return { checks: () => checks };

    const accepted = assets.catalog(VALID, Materials.unlit([0.2, 0.85, 0.3, 1]));
    checks.push({ name: 'valid material catalogs', ok: accepted.ok });
    const loaded = await assets.loadByGuid<MaterialAsset>(assets.parseGuid(VALID));
    checks.push({
      name: 'loadByGuid returns the catalogued material',
      ok: loaded.ok && loaded.value.kind === 'material',
    });
    if (loaded.ok) {
      spawnMesh(world, MESH.quad, world.allocSharedRef('MaterialAsset', loaded.value), {
        pos: [0, 1, 0],
        scale: [2, 2, 2],
      });
    }

    const rejected = assets.catalog(INVALID, {
      kind: 'material',
      passes: [],
      values: {},
    } as unknown as MaterialAsset);
    checks.push({
      name: 'empty-pass material is rejected',
      ok: !rejected.ok,
      ...(rejected.ok ? {} : { detail: code(rejected.error) }),
    });
    checks.push({
      name: 'rejected GUID stays invisible',
      ok: assets.lookup(INVALID) === undefined,
    });

    assets.invalidate(VALID);
    checks.push({ name: 'invalidate retracts the GUID', ok: assets.lookup(VALID) === undefined });

    const missing = await assets.loadByGuid(assets.parseGuid(MISSING));
    checks.push({
      name: 'uncatalogued GUID fails with a structured code',
      ok: !missing.ok && typeof (missing.error as { code?: unknown }).code === 'string',
      ...(missing.ok ? {} : { detail: code(missing.error) }),
    });
    return { checks: () => checks };
  },
});
