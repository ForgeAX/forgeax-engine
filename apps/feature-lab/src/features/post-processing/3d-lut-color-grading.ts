import { Camera, TONEMAP_LINEAR } from '@forgeax/engine/render';
import { createStandaloneRuntimeAssetBinding, type TextureAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { passChecks } from './shared/scenes';

const LUT_GUID = 'dab53d78-d233-4c79-8cb3-c03f33f1a001';
const LUT_SOURCE_KEY = 'feature-lab://post-processing/channel-swap-lut';

/** 2x2x2 identity lattice with R and B swapped: red objects turn blue and vice versa. */
function channelSwapLut(): TextureAsset {
  const half = new Uint16Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    const r = i & 1 ? 0x3c00 : 0;
    const g = i & 2 ? 0x3c00 : 0;
    const b = i & 4 ? 0x3c00 : 0;
    half.set([b, g, r, 0x3c00], i * 4);
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'rgba16float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(half.buffer),
  };
}

export default defineFeature({
  title: '3D LUT color grading',
  catalog: '3D LUT color grading',
  kind: 'visual',
  summary:
    'Camera.colorLut binds a GUID-catalogued 3D TextureAsset (no URL identity, no LUT registry); colorLutStrength blends it after tone mapping.',
  expect:
    'ON: a channel-swap LUT turns the red cube blue and the blue sphere red (green stays green). OFF (strength 0): original red cube, green box, blue sphere.',
  async setup({ app, world, hud, frames }) {
    const { camera } = spawnStage(world, {
      eye: [0, 1.6, 5],
      target: [0, 0.5, 0],
      data: { tonemap: TONEMAP_LINEAR },
    });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.05, 0.05, 1] }), {
      pos: [-1.6, 0.5, 0],
    });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.05, 1, 0.05, 1] }), {
      pos: [0, 0.5, 0],
      scale: [0.6, 1, 0.6],
    });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.05, 0.05, 1, 1] }), {
      pos: [1.6, 0.5, 0],
      scale: [0.55, 0.55, 0.55],
    });
    const assets = app.assets;
    const lut = channelSwapLut();
    if (assets === undefined) {
      hud.status('app.assets is unavailable: LUT cannot be catalogued');
    } else {
      const binding = createStandaloneRuntimeAssetBinding('feature-lab-3d-lut');
      const snapshot = {
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: binding.scopeId,
        generation: binding.generation,
        authority: 'authoritative',
        entries: [
          {
            guid: LUT_GUID,
            kind: 'texture',
            packageUrl: 'data:application/json,{}',
            sourceKey: LUT_SOURCE_KEY,
          },
        ],
      };
      assets.configureRuntimeBinding({
        ...binding,
        catalogUrl: `data:application/json,${encodeURIComponent(JSON.stringify(snapshot))}`,
      });
      await assets.refreshCatalog();
      assets.catalog(LUT_GUID, lut).unwrap();
    }
    const handle = world.allocSharedRef('TextureAsset', lut);
    world.set(camera, Camera, { colorLut: handle, colorLutStrength: 1 } as never).unwrap();
    return {
      toggle(on) {
        world.set(camera, Camera, { colorLutStrength: on ? 1 : 0 } as never).unwrap();
      },
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        const standardLut = inspection.output.standardLut;
        return [
          ...passChecks(inspection.perFramePassNames, ['standard-color-lut']),
          ...new CheckList()
            .ok('app.assets registry present', assets !== undefined)
            .equal('LUT resolved by catalog sourceKey', standardLut?.sourceKey, LUT_SOURCE_KEY)
            .ok(
              'no output error',
              inspection.output.error === undefined,
              JSON.stringify(inspection.output.error),
            ).items,
        ];
      },
    };
  },
});
