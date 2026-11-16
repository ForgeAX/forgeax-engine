import { AssetGuid } from '@forgeax/engine/pack/guid';
import { VisibilityStateValue } from '@forgeax/engine/render';
import {
  err,
  type SceneAsset,
  type WaterBodyAsset,
  type WaterZoneAsset,
} from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import pack from '../harbor.pack';

it('cooks a calm harbor with distributed native support and independently adjustable cargo', async () => {
  const output = (
    await pack.build({
      packageId: pack.packageId,
      readByGuid: async () => err(new Error('Expected local Water dependencies')),
    })
  ).unwrap();
  const scene = output['scene/harbor'] as SceneAsset;
  const lake = output['body/lake'] as WaterBodyAsset;
  const zone = output['zone/harbor'] as WaterZoneAsset;
  const source = scene.entities['lake-craft']?.components;
  const anchors = source?.WaterPontoonSet?.anchorsM as readonly number[];
  expect(source?.RigidBody).toMatchObject({ type: 1, mass: 125 });
  expect(source?.Collider).toMatchObject({ shape: 5 });
  expect(anchors.length).toBe(12);
  expect(new Set(anchors.filter((_value, index) => index % 3 === 0)).size).toBe(2);
  expect(new Set(anchors.filter((_value, index) => index % 3 === 2)).size).toBe(2);
  expect(scene.entities['lake-craft-cargo']?.components).toMatchObject({
    ChildOf: { parent: 'lake-craft' },
    Visibility: { state: VisibilityStateValue.hidden },
  });
  expect(lake.waveSetGuid).toBe(AssetGuid.format(AssetGuid.derive(pack.packageId, 'waves/off')));
  expect(lake.geometrySnapshot?.collisionDescriptor).toBeDefined();
  expect(zone).toMatchObject({
    tessellationFactor: 4,
    waterInfo: { resolution: { widthPx: 256, heightPx: 256 } },
  });
}, 30_000);
