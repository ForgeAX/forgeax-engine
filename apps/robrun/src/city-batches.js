import {
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  Visibility,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { nativeRuntime, sectionMesh } from './native-renderer.js';

export function createCityBatch(material) {
  return { material, records: [], buckets: [], visible: false, receiveShadow: false };
}
export function addCityGeometry(batch, geometry, full) {
  const mesh = nativeRuntime().assets.create(sectionMesh(geometry, full)).unwrap();
  batch.buckets.push({ mesh, records: [], dirty: true, entity: null, active: 0 });
  return batch.buckets.length - 1;
}
export function addCityInstance(batch, geometry, matrix) {
  const record = {
    matrix: new Float32Array(matrix),
    visible: false,
    bucket: batch.buckets[geometry],
  };
  batch.records.push(record);
  record.bucket.records.push(record);
  return batch.records.length - 1;
}
export function setCityVisibility(batch, id, visible) {
  const record = batch.records[id];
  if (record.visible !== visible) {
    record.visible = visible;
    record.bucket.dirty = true;
  }
}
export function publishCityBatch(batch) {
  const { world, assets } = nativeRuntime();
  const source = batch.material;
  const shadow = source.colorWrite === false;
  if (!source.userData.nativeHandle)
    source.userData.nativeHandle = assets
      .create(
        Materials.unlit([0, 0, 0, 1], {
          renderState: {
            colorWriteMask: shadow ? 0 : 15,
            depthWriteEnabled: !shadow,
            cullMode: 'none',
          },
        }),
      )
      .unwrap();
  for (const bucket of batch.buckets) {
    const show = batch.visible && source.visible;
    if (!bucket.dirty && bucket.visible === show) continue;
    let count = 0;
    if (show) for (const record of bucket.records) if (record.visible) count++;
    const packed = new Float32Array(count * 16);
    let offset = 0;
    if (show)
      for (const record of bucket.records)
        if (record.visible) {
          packed.set(record.matrix, offset);
          offset += 16;
        }
    if (!bucket.entity && count) {
      bucket.entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: bucket.mesh } },
          { component: MeshRenderer, data: { materials: [source.userData.nativeHandle] } },
          { component: Instances, data: { transforms: packed } },
          { component: Visibility, data: { state: 2 } },
          { component: ShadowParticipation, data: { cast: shadow, receive: batch.receiveShadow } },
        )
        .unwrap();
    } else if (bucket.entity) {
      world.set(bucket.entity, Instances, { transforms: packed }).unwrap();
      world.set(bucket.entity, Visibility, { state: count ? 2 : 1 }).unwrap();
    }
    bucket.active = count;
    bucket.dirty = false;
    bucket.visible = show;
  }
}
