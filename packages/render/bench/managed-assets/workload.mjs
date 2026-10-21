import { defineComponent } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const texture = (size, green = false, checker = false) => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size), on = !checker || (((x >>> 2) + (y >>> 2)) & 1) === 0;
    data.set(on ? green ? [40, 210, 60, 255] : [210, 40, 60, 255] : [35, 35, 35, 255], i * 4);
  }
  return { kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear', shape: { viewDimension: '2d', extent: { width: size, height: size } }, mips: { kind: 'none' }, data };
};

export function createWorkload(world, adapter, config) {
  for(const component of [Transform,Camera,MeshFilter,MeshRenderer]){
    const registered=world.components.resolve(component.name);
    if(registered!==undefined&&registered!==component)throw new Error(`Benchmark bundle duplicated component identity: ${component.name}`);
  }
  const materialCase = ['material', 'lifecycle', 'backpressure', 'transform'].includes(config.kind);
  let shape;
  if (materialCase) shape = createBoxGeometry(.14, .14, .14).unwrap();
  else if (config.kind.startsWith('mesh')) shape = createPlaneGeometry(2, 2, config.vertices === 1_000_000 ? 999 : 255, config.vertices === 1_000_000 ? 999 : 249).unwrap();
  else shape = createPlaneGeometry(2, 2).unwrap();
  const mesh = adapter.create(shape);
  const image = materialCase ? undefined : adapter.create(texture(config.extent ?? 64, false, config.kind.startsWith('mesh')));
  const material = green => Materials.standard({ baseColor: green ? [.6, .6, .3, 1] : [.2, .6, .3, 1], roughness: .7, ...(image === undefined ? {} : { baseColor: [1, 1, 1, 1], baseColorTexture: image.handle }) });
  let records = Array.from({ length: config.unique ?? 1 }, () => adapter.create(material(false)));
  if (image !== undefined) for (const record of records) adapter.texture(image, record, 'baseColorTexture');
  for (let i = 0; i < (config.unrelated ?? 0); i++) adapter.create(Materials.standard({ baseColor: [.1, .1, .1, 1], roughness: .7 }));
  const side = materialCase ? Math.ceil(Math.sqrt(config.count)) : 1;
  const entities = [];
  const tags = Array.from({ length: config.tables ?? 0 }, (_, index) => defineComponent(`ChangeQualificationTable${index}`, {}));
  const positions = [];
  for (let i = 0; i < config.count; i++) {
    const record = records[i % records.length];
    const entity = world.spawn({ component: Transform, data: { pos: materialCase ? [(i % side - (side - 1) / 2) * .18, (Math.floor(i / side) - (side - 1) / 2) * .18, 0] : [0, 0, 0] } }, { component: MeshFilter, data: { assetHandle: mesh.handle } }, { component: MeshRenderer, data: { materials: [record.handle] } }).unwrap();
    if (tags.length) world.addComponent(entity, { component: tags[i % tags.length], data: {} }).unwrap();
    if (config.kind === 'transform') positions.push([(i % side - (side - 1) / 2) * .18, (Math.floor(i / side) - (side - 1) / 2) * .18, 0]);
    entities.push(entity); adapter.attach(record, entity); adapter.attach(mesh, entity, 'mesh');
  }
  world.spawn({ component: Transform, data: { pos: [0, 0, materialCase ? Math.max(1, side * .19) : 3] } }, { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: .1, far: 100, antialias: 0, bloom: 0 } }).unwrap();
  world.spawn({ component: DirectionalLight, data: { intensity: 2, direction: [-.3, -.5, -1], castShadow: true, cascadeCount: 4, splitLambda: .75 } }).unwrap();
  const patches = [0, 1].map(parity => Array.from({ length: Math.max(config.writes, 1) }, (_, write) => ({ values: { baseColor: [.2 + parity * .4 + write * .001, .6, .3, 1] } })));
  let rangePair, replacementPair;
  if (config.kind === 'mesh') {
    const first = config.changed === config.vertices ? 0 : Math.floor(config.vertices / 2);
    rangePair = [-.3, .3].map(z => {
      const values = shape.attributes.position.slice(first * 3, (first + config.changed) * 3);
      for (let i = 2; i < values.length; i += 3) values[i] = z;
      return { attribute: 'position', first, values };
    });
  } else if (config.kind === 'texture') {
    rangePair = [false, true].map(green => ({ origin: { x: Math.floor((config.extent - config.region) / 2), y: Math.floor((config.extent - config.region) / 2) }, size: { width: config.region, height: config.region }, data: texture(config.region, green).data }));
  } else if (config.kind === 'texture-resize') replacementPair = [texture(config.extent, false), texture(config.extent / 2, true)];
  else if (config.kind === 'mesh-topology') replacementPair = [shape, createPlaneGeometry(1.5, 2, 255, 255).unwrap()];
  let sourceLayout;
  if (config.kind === 'transform') {
    const spans = world.query({ read: [MeshFilter] }).unwrap().spans().unwrap();
    let meshTables = 0, meshRows = 0;
    for (const span of spans) { meshTables++; meshRows += span.length; }
    const expectedTables = config.tables ?? 1;
    if (meshTables !== expectedTables || meshRows !== config.count) throw new Error(`Source layout differs: ${meshTables}/${expectedTables} tables, ${meshRows}/${config.count} rows`);
    sourceLayout = { meshTables, meshRows };
  }
  let authoredWrites = 0;
  return {
    write(step, force = false) {
      if (!config.writes && !force) return;
      const parity = step & 1;
      if (config.kind === 'transform') {
        for (let index = 0; index < config.writes; index++) {
          const target = (Math.floor(config.count / 2) + index) % config.count;
          const [x, y, z] = positions[target];
          world.set(entities[target], Transform, { pos: [x + (parity ? .08 : -.08), y, z + (parity ? .12 : -.12)] }).unwrap();
          authoredWrites++;
        }
      } else if (config.kind === 'material' || config.kind === 'backpressure') {
        for (const patch of patches[parity]) for (const record of records) adapter.update(record, patch);
      } else if (config.kind === 'mesh') adapter.range(mesh, rangePair[parity]);
      else if (config.kind === 'texture') adapter.range(image, rangePair[parity]);
      else if (config.kind === 'mesh-topology') adapter.replace(mesh, replacementPair[parity]);
      else if (config.kind === 'texture-resize') adapter.replace(image, replacementPair[parity]);
      else if (config.kind === 'lifecycle') {
        const old = records;
        records = Array.from({ length: config.unique }, () => adapter.create(material(parity)));
        for (let i = 0; i < entities.length; i++) adapter.bind(records[i % records.length], entities[i]);
        for (const record of old) adapter.release(record);
      } else throw new Error(`Missing workload: ${config.kind}`);
      adapter.flush();
    },
    state() { const record = config.kind.startsWith('mesh') ? mesh : image ?? records[0]; return { handle: record.handle, version: adapter.version(record), ...(config.kind === 'transform' ? { authoredWrites, liveEntities: entities.length, changedPerWrite: config.writes, sourceLayout } : {}), ...adapter.stats() }; },
  };
}
