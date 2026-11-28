import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';
import { alpineTextureSetRef, ueTextureSetRef } from '../cloud-texture-sets.pack.ts';
import { standardUeCloudRef } from '@forgeax-assets/ue-volumetric-clouds/references';
import { referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import gamePack from '../game.pack.ts';
import { UE_CLOUD_REFERENCE, ueCloudWindOffset } from '@forgeax-assets/volumetric-clouds/reference';
import { GROUND_ENTITY_KEYS, GROUND_SCENE_KEY, groundReferenceScene } from '../ground-scene.ts';
import { terrainRefs } from '../terrain.pack.ts';
import { OCCLUDER_CENTER, REFERENCE_EYE, REFERENCE_VERTICAL_FOV, SUN_DIRECTION } from '../terrain.ts';

function scene() {
  return groundReferenceScene({
    ground: terrainRefs.ground.$asset,
    groundMaterial: terrainRefs.groundMaterial.$asset,
    occluder: terrainRefs.occluder.$asset,
    occluderMaterial: terrainRefs.occluderMaterial.$asset,
    cloudMaterial: standardUeCloudRef.$asset,
  });
}

describe('formal ground Scene', () => {
  it('keeps the accepted seven-entity reference composition and lens', () => {
    const asset = scene();
    assert.equal(asset.kind, 'scene');
    assert.deepEqual(Object.keys(asset.entities), GROUND_ENTITY_KEYS);
    const camera = asset.entities.camera.components;
    assert.deepEqual(camera.Transform.pos, REFERENCE_EYE);
    assert.equal(camera.Camera.fov, REFERENCE_VERTICAL_FOV);
    assert.equal(camera.Camera.near, 0.05);
    assert.equal(camera.Camera.far, 25_000);
    assert.equal(camera.Camera.exposure, 0.00022);
    assert.equal(camera.Camera.autoAspect, false);
    assert.deepEqual(asset.entities.occluder.components.Transform.pos, OCCLUDER_CENTER);
    assert.deepEqual(asset.entities.sun.components.DirectionalLight.direction, SUN_DIRECTION);
    assert.equal(asset.entities.sun.components.DirectionalLight.intensity, 120_000);
  });

  it('references the existing producers and inherits the frozen UE B material defaults', () => {
    const entities = scene().entities;
    assert.equal(entities.ground.components.MeshFilter.assetHandle, terrainRefs.ground.$asset);
    assert.deepEqual(entities.ground.components.MeshRenderer.materials, [terrainRefs.groundMaterial.$asset]);
    assert.equal(entities.occluder.components.MeshFilter.assetHandle, terrainRefs.occluder.$asset);
    assert.deepEqual(entities.occluder.components.MeshRenderer.materials, [terrainRefs.occluderMaterial.$asset]);
    const cloud = entities.cloud.components.VolumetricCloudLayer;
    assert.equal(cloud.material, standardUeCloudRef.$asset);
    assert.equal(cloud.coverageBias, -2);
    assert.equal(cloud.extinctionOverridePerMeter, -1);
    assert.deepEqual(
      [cloud.bottomMeters, cloud.thicknessMeters, cloud.entryLimitMeters, cloud.traceLimitMeters],
      [1_000, 9_000, 50_000, 50_000],
    );
    assert.equal(cloud.viewSampleCountScale, 1);
    assert.equal(cloud.stopTransmittance, 0.005);
    assert.deepEqual(cloud.windOffsetMeters, [0, 0, -0]);
    assert.equal(
      AssetGuid.format(AssetGuid.derive(definePackageId('019a50a5-0000-7000-8000-000000000001'), GROUND_SCENE_KEY)),
      '3ff37484-d2aa-584c-8035-45e09d98cb72',
    );
  });

  it('reproduces the source default wind phase including the vertical component', () => {
    assert.equal(UE_CLOUD_REFERENCE.extinctionPerMeter, 0.00800000037997961);
    const ten = ueCloudWindOffset(10);
    const sixty = ueCloudWindOffset(60);
    assert.equal(ten[0], 213.33309936523438);
    assert.equal(ten[1], ten[0] * 0.5);
    assert.equal(ten[2], -ten[0]);
    assert.equal(sixty[0], 1279.9986572265625);
  });

  it('defaults to generated clouds while binding the UE and Alpine texture sets', async () => {
    const built = await gamePack.build({ packageId: gamePack.packageId,
      readByGuid: async () => { throw new Error('unexpected asset read'); } });
    assert.ok(built.ok);
    if (!built.ok) return;
    const scene = built.value[GROUND_SCENE_KEY] as ReturnType<typeof groundReferenceScene>;
    assert.equal(scene.entities.cloud.components.VolumetricCloudLayer.material, referenceCloudRef.$asset);
    const engine = built.value['plugin/engine'];
    assert.ok('config' in engine && engine.config && typeof engine.config === 'object');
    assert.ok('sampleUeTextureSet' in engine.config && 'alpineTextureSet' in engine.config);
    assert.deepEqual(engine.config.sampleUeTextureSet, ueTextureSetRef);
    assert.deepEqual(engine.config.alpineTextureSet, alpineTextureSetRef);
  });
});
