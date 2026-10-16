import { parseMaterial } from '@forgeax/engine/fbx';
import { guid } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import { importTriangleFbx } from './fbx-importer';

interface MaterialValues {
  readonly baseColor?: readonly number[];
  readonly metallic?: number;
  readonly roughness?: number;
}

const values = (payload: Record<string, unknown> | undefined): MaterialValues | undefined =>
  payload?.values as MaterialValues | undefined;

export default defineFeature({
  title: 'FBX material mapping',
  catalog: 'FBX material mapping',
  kind: 'headless',
  summary:
    'FBX Phong, Lambert, StingrayPBS and unrecognised shading models map into PBR baseColor/metallic/roughness; Phong shininess projects to roughness = 1 - sqrt(shininess / 100).',
  expect:
    'Imported Shiny (phong, shininess 25) becomes red with roughness 0.5, Matte (lambert) becomes green with roughness 0.5, Stingray channels pass through, and the fallback is grey 0.5 with metallic 0.',
  async run(checks) {
    const imported = await importTriangleFbx();
    checks.ok('FBX import ok', imported.ok, imported.ok ? undefined : imported.code);
    if (imported.ok) {
      const byGuid = new Map(imported.assets.map((asset) => [asset.guid, asset]));
      const shiny = values(byGuid.get(guid(0x302))?.payload);
      const matte = values(byGuid.get(guid(0x303))?.payload);
      checks.equal(
        'Phong diffuse -> baseColor',
        shiny?.baseColor?.map((v) => Math.round(v * 100) / 100),
        [0.9, 0.1, 0.1, 1],
      );
      checks.near('Phong shininess 25 -> roughness 0.5', shiny?.roughness ?? -1, 0.5, 1e-4);
      checks.equal('Phong metallic', shiny?.metallic, 0);
      checks.equal(
        'Lambert diffuse -> baseColor',
        matte?.baseColor?.map((v) => Math.round(v * 100) / 100),
        [0.1, 0.8, 0.2, 1],
      );
      checks.near('Lambert roughness default', matte?.roughness ?? -1, 0.5, 1e-4);
    }

    const glossy = parseMaterial({ kind: 'phong', diffuse: [1, 1, 1], shininess: 100 }, 0);
    checks.near('shininess 100 -> roughness 0', glossy.roughnessFactor ?? -1, 0, 1e-6);
    const over = parseMaterial({ kind: 'phong', diffuse: [1, 1, 1], shininess: 400 }, 0);
    checks.near('roughness clamps at 0', over.roughnessFactor ?? -1, 0, 1e-6);
    const stingray = parseMaterial(
      {
        kind: 'stingray-pbs',
        name: 'Metal',
        stingrayProps: { baseColor: [0.2, 0.3, 0.4], metallic: 1, roughness: 0.25 },
      },
      0,
    );
    checks.equal(
      'StingrayPBS channels pass through',
      [stingray.baseColorFactor, stingray.metallicFactor, stingray.roughnessFactor],
      [[0.2, 0.3, 0.4, 1], 1, 0.25],
    );
    const fallback = parseMaterial({ kind: 'fallback', name: 'Mystery' }, 0);
    checks.equal(
      'fallback grey PBR',
      [fallback.baseColorFactor, fallback.metallicFactor, fallback.roughnessFactor],
      [[0.5, 0.5, 0.5, 1], 0, 0.5],
    );
  },
});
