import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';

/** Old author path: coalesce W writes, replace U refs, then rebind actual users.
 * Texture-dependent material refs are the old path's required publication work. */
export function createAssetAdapter(world, assets) {
  const pending = new Set();
  const target = value => value.kind === 'material' ? 'MaterialAsset' : value.kind === 'mesh' ? 'MeshAsset' : 'TextureAsset';
  const bind = (record, entity, component) => world.set(entity, component === 'material' ? MeshRenderer : MeshFilter,
    component === 'material' ? { materials: [record.handle] } : { assetHandle: record.handle }).unwrap();
  const api = {
    kind: 'legacy-replace-rebind',
    create(value) { return { handle: world.allocSharedRef(target(value), value), value, users: [], dependents: [], version: 1 }; },
    attach(record, entity, component = 'material') { record.users.push({ entity, component }); },
    texture(record, material, parameter) { record.dependents.push({ material, parameter }); },
    update(record, patch) { record.value = { ...record.value, ...patch, ...(patch.values === undefined ? {} : { values: { ...record.value.values, ...patch.values } }) }; pending.add(record); },
    range(record, range) {
      const source = record.value;
      if (source.kind === 'texture') {
        const data = source.data.slice(), width = source.shape.extent.width;
        for (let row = 0; row < range.size.height; row++) data.set(range.data.subarray(row * range.size.width * 4, (row + 1) * range.size.width * 4), ((range.origin.y + row) * width + range.origin.x) * 4);
        record.value = { ...source, data };
      } else {
        const position = source.attributes.position.slice(), vertices = source.vertices.slice();
        position.set(range.values, range.first * 3);
        const stride = vertices.length / (position.length / 3);
        for (let i = 0; i < range.values.length / 3; i++) vertices.set(range.values.subarray(i * 3, i * 3 + 3), (range.first + i) * stride);
        record.value = { ...source, attributes: { ...source.attributes, position }, vertices };
      }
      pending.add(record);
    },
    replace(record, value) { record.value = value; pending.add(record); },
    bind(record, entity, component = 'material') { bind(record, entity, component); record.users.push({ entity, component }); },
    release(record) { world.sharedRefs.release(record.handle).unwrap(); },
    flush() {
      const retiring = [];
      for (const record of pending) {
        retiring.push(record.handle);
        record.handle = world.allocSharedRef(target(record.value), record.value);
        record.version++;
        for (const { material, parameter } of record.dependents) api.update(material, { values: { [parameter]: record.handle } });
        for (const { entity, component } of record.users) bind(record, entity, component);
      }
      for (const previous of retiring) world.sharedRefs.release(previous).unwrap();
      pending.clear();
    },
    version(record) { return record.version; },
    stats() { return { assets: world.sharedRefs._liveCount() }; },
    dispose() { assets.clearCatalogSource(); assets.invalidateAll(); },
  };
  return api;
}
