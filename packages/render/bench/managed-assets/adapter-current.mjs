import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';

export function createAssetAdapter(world, assets) {
  const records = runtimeAssets(assets);
  return {
    kind: 'native-owner',
    create(value) { return { handle: assets.create(value).unwrap(), value, users: [] }; },
    attach(record, entity, component = 'material') { record.users.push({ entity, component }); },
    texture() {},
    update(record, patch) { assets.update(record.handle, patch).unwrap(); },
    range(record, range) { assets.writeRange(record.handle, range).unwrap(); },
    replace(record, value) { assets.replace(record.handle, value).unwrap(); record.value = value; },
    bind(record, entity, component = 'material') {
      world.set(entity, component === 'material' ? MeshRenderer : MeshFilter,
        component === 'material' ? { materials: [record.handle] } : { assetHandle: record.handle }).unwrap();
      record.users.push({ entity, component });
    },
    release(record) { assets.release(record.handle).unwrap(); },
    flush() {},
    version(record) { return records.version(record.handle).unwrap(); },
    stats() { return records.inspect(); },
    dispose() { assets.dispose(); },
  };
}
