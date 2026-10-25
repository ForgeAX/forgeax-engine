import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Camera, CameraView, DirectionalLight, Instances, Materials, MeshFilter, MeshRenderer, PointLight, PointLightShadow, RenderPublicationTargetOwner, SpotLight, Visibility, VisibilityStateValue } from '@forgeax/engine-render';
import { ChildOf, MorphWeights, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';

export const phases = ['idle', 'camera', 'pose', 'binding', 'material', 'mesh', 'hierarchy', 'churn', 'mixed', 'dense'];
export const identity = { source: 'change-propagation-mixed-v1', epoch: 1 };
export const hash = value => createHash('sha256').update(typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value)).digest('hex');
export const unwrap = result => {
  if (!result?.ok) throw new Error(JSON.stringify(result?.error ?? 'missing Result'));
  return result.value;
};

export function validateConfig(config) {
  const scenario = config.scenario !== undefined;
  for (const key of ['count', 'dirty', 'users', 'frames', 'warmup']) assert(Number.isSafeInteger(config[key]) && (config[key] > 0 || (scenario && key === 'dirty' && config[key] === 0)), `invalid ${key}`);
  // Scenario cells size D from 0 to N (the 100% moving cell), so the legacy N/8 cap does not apply.
  assert(scenario ? config.count >= 8 && config.dirty <= config.count : config.count >= 64 && config.dirty <= config.count / 8, 'count >= 64; dirty <= count / 8 (scenario: count >= 8, dirty <= count)');
  assert(config.users <= config.count / 2 && config.users >= 1, 'users must fit the first half of the scene');
  assert(scenario ? scenarios[config.scenario] !== undefined : phases.includes(config.phase), scenario ? `unknown scenario ${config.scenario}` : 'unknown phase');
  assert(config.residuals === undefined || (Number.isSafeInteger(config.residuals) && config.residuals >= 0), 'invalid residuals');
  assert(config.cameras === undefined || (Number.isSafeInteger(config.cameras) && config.cameras >= 1 && config.cameras <= 4), 'cameras must be 1..4');
  assert(config.transparent === undefined || (Number.isSafeInteger(config.transparent) && config.transparent >= 0 && config.transparent <= config.count - config.users), 'transparent must fit after the shared users');
  return config;
}

// Fixed logical indexes and tick numbers, independent of World/asset handles.
// Rotating sparse edits avoid a benchmark that repeatedly hits only one hot slot.
export function commands(config, phase, tick) {
  assert(phases.includes(phase));
  const quarter = Math.floor(config.count / 4);
  const indexes = Array.from({ length: config.dirty }, (_, i) => (tick * 37 + i) % quarter);
  const active = kind => phase === kind || phase === 'mixed';
  return {
    tick,
    pose: phase === 'dense' ? Array.from({ length: config.count }, (_, i) => i) : active('pose') ? indexes : [],
    binding: active('binding') ? indexes.map(i => quarter * 2 + i) : [],
    camera: active('camera'), material: active('material'), mesh: active('mesh'),
    hierarchy: active('hierarchy'), churn: active('churn') ? indexes.map(i => quarter * 3 + i) : [],
  };
}

// Scenario matrix. A scenario is a named workload: optional hooks over the one population builder below.
//   prepare(ctx)            create shared assets before the population exists
//   kindAt(index, ctx)      override the per-index kind (rigid | skin | morph | transparent | unlit | instances)
//   pick(index, kind, ctx)  override { mesh, material } for one spawned row
//   extra(index, kind, ctx) additional components for one spawned row
//   setup(ctx)              extra entities after the population (lights, cameras, targets); `lights: true` skips the default rig
//   step(ctx, tick)         the per-frame mutation; returns a JSON-able operation record (hashed for the A/A digest)
// D (`config.dirty`) is the per-frame change count; `params` carries the cell's scenario-specific knobs.
export const sparse = (dirty, tick, span, offset = 0) => {
  const n = Math.min(dirty, span), start = (tick * 37) % span;
  return Array.from({ length: n }, (_, i) => offset + (start + i) % span);
};
const posePose = (ctx, index, tick) => { const pos = ctx.position(index); pos[2] = Math.sin(tick * 0.1 + index) * 0.02; unwrap(ctx.world.set(ctx.entities[index], Transform, { pos })); };
const moveStep = (ctx, tick) => {
  const indexes = sparse(ctx.config.dirty, tick, ctx.config.count);
  for (const index of indexes) posePose(ctx, index, tick);
  return { tick, pose: indexes.length };
};
const cameraSweep = (ctx, tick) => unwrap(ctx.world.set(ctx.camera, Transform, { pos: [Math.sin(tick * 0.01) * 0.1, 0, ctx.cameraDistance] }));
const lightRig = (ctx, count, shadowed, moving) => {
  const { world } = ctx;
  const lights = [];
  const span = Math.max(4, Math.sqrt(ctx.config.count) * 0.18);
  for (let i = 0; i < count; i++) {
    const spot = i % 2 === 1;
    const pos = [(i / Math.max(1, count - 1) - 0.5) * span, (i % 3 - 1) * span * 0.2, 1.5];
    lights.push({ pos, spot, entity: unwrap(world.spawn({ component: Transform, data: { pos } },
      spot ? { component: SpotLight, data: { intensity: 4, range: span, direction: [0, 0, -1], innerConeDeg: 20, outerConeDeg: 35, castShadow: shadowed } }
        : { component: PointLight, data: { intensity: 2, range: span, color: [0.8, 0.9, 1] } },
      ...(shadowed && !spot ? [{ component: PointLightShadow, data: { mapSize: 256 } }] : []))) });
  }
  ctx.lights = lights; ctx.lightsMoving = moving;
};
const moveLights = (ctx, tick) => {
  if (!ctx.lightsMoving) return 0;
  for (const [i, light] of ctx.lights.entries()) unwrap(ctx.world.set(light.entity, Transform, { pos: [light.pos[0] + Math.sin(tick * 0.05 + i) * 0.3, light.pos[1], light.pos[2]] }));
  return ctx.lights.length;
};
const texture = value => ({ kind: 'texture', shape: { viewDimension: '2d', extent: { width: 4, height: 4 } }, format: 'rgba8unorm',
  data: new Uint8Array(64).fill(value), colorSpace: 'linear', mips: { kind: 'none' } });

export const scenarios = {
  idle: { summary: 'static scene, no authored change (D=0)', step: (_ctx, tick) => ({ tick }) },
  move: { summary: 'D Transform writes per frame (D=8, 1%, 10%, 100% of N), static camera', step: moveStep },
  churn: { summary: 'despawn D rows and spawn D fresh rows per frame; population neutral',
    step(ctx, tick) {
      const span = ctx.config.count - ctx.config.users;
      const indexes = sparse(ctx.config.dirty, tick, Math.max(1, span), ctx.config.users);
      for (const index of indexes) { unwrap(ctx.world.despawn(ctx.entities[index])); ctx.entities[index] = ctx.spawn(index); }
      return { tick, churn: indexes.length };
    } },
  'material-swap': { summary: 'D rows swap MeshRenderer.materials among a pool of 4',
    prepare(ctx) { ctx.pool = [0.2, 0.4, 0.6, 0.8].map(r => unwrap(ctx.assets.create(Materials.standard({ baseColor: [r, 0.5, 1 - r, 1], roughness: r })))); },
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick, ctx.config.count - ctx.config.users, ctx.config.users);
      for (const [i, index] of indexes.entries()) unwrap(ctx.world.set(ctx.entities[index], MeshRenderer, { materials: [ctx.pool[(tick + i) % ctx.pool.length]] }));
      return { tick, swap: indexes.length };
    } },
  'mesh-swap': { summary: 'D rows swap MeshFilter.assetHandle among a pool of 3 meshes',
    prepare(ctx) { ctx.pool = [0.12, 0.14, 0.16].map(size => unwrap(ctx.assets.create(unwrap(createBoxGeometry(size, 0.12, 0.12))))); },
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick, ctx.config.count - ctx.config.users, ctx.config.users);
      for (const [i, index] of indexes.entries()) unwrap(ctx.world.set(ctx.entities[index], MeshFilter, { assetHandle: ctx.pool[(tick + i) % ctx.pool.length] }));
      return { tick, swap: indexes.length };
    } },
  'visibility-toggle': { summary: 'D rows alternate Visibility hidden/visible (the same D rows hide on even ticks, show on odd)',
    extra: () => [{ component: Visibility, data: {} }],
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick >> 1, ctx.config.count);
      for (const index of indexes) unwrap(ctx.world.set(ctx.entities[index], Visibility, { state: tick % 2 ? VisibilityStateValue.visible : VisibilityStateValue.hidden }));
      return { tick, toggle: indexes.length };
    } },
  'multi-camera': { summary: 'params.cameras (1/2/4) CameraViews in screen quadrants plus D pose writes',
    step(ctx, tick) { cameraSweep(ctx, tick); return { ...moveStep(ctx, tick), camera: 1 }; } },
  'split-screen': { summary: 'two side-by-side CameraViews (left/right halves) plus D pose writes',
    setup(ctx) {
      for (const [index, camera] of ctx.cameras.entries()) unwrap(ctx.world.set(camera, CameraView, { viewport: new Float32Array([index * 0.5, 0, 0.5, 1]) }));
    },
    step(ctx, tick) { cameraSweep(ctx, tick); return { ...moveStep(ctx, tick), camera: 1 }; } },
  'render-target-camera': { summary: 'display camera plus params.targets auxiliary cameras writing 256x256 RenderTargets; D pose writes',
    setup(ctx) {
      ctx.targetOwner ??= new RenderPublicationTargetOwner();
      ctx.targetCameras = [];
      for (let i = 0; i < (ctx.params.targets ?? 1); i++) {
        const target = unwrap(ctx.targetOwner.authoring.createRenderTarget({ shape: '2d', width: 256, height: 256, format: 'rgba8unorm', mipLevels: 1, sampleCount: 1, depth: 'depth32float', sampled: true, readback: false }));
        ctx.targetCameras.push(unwrap(ctx.world.spawn({ component: Transform, data: { pos: [i * 0.1, 0, ctx.cameraDistance] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: ctx.cameraDistance * 4, target: ctx.world.allocSharedRef('RenderTarget', target) } })));
      }
    },
    step(ctx, tick) { cameraSweep(ctx, tick); return moveStep(ctx, tick); } },
  'shadow-lights': { summary: 'directional (4 cascades) + params.lights shadowed point/spot lights; D pose writes; params.moving moves every light per frame',
    lights: true,
    setup(ctx) {
      unwrap(ctx.world.spawn({ component: DirectionalLight, data: { intensity: 2, direction: [-0.3, -0.5, -1], castShadow: true, cascadeCount: 4, mapSize: 512 } }));
      lightRig(ctx, ctx.params.lights ?? 8, true, ctx.params.moving === 1);
    },
    step(ctx, tick) { const moved = moveLights(ctx, tick); return { ...moveStep(ctx, tick), lights: moved }; } },
  skinned: { summary: 'every row is a Skin character with its own joint entity; D joints animate per frame',
    kindAt: (index, ctx) => index < ctx.config.users ? 'rigid' : 'skin', joints: true,
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick, ctx.config.count - ctx.config.users, ctx.config.users);
      for (const index of indexes) unwrap(ctx.world.set(ctx.joints.get(index), Transform, { pos: [0, Math.sin(tick * 0.2 + index) * 0.05, 0] }));
      return { tick, joints: indexes.length };
    } },
  morph: { summary: 'every row has morph targets; D MorphWeights written per frame',
    kindAt: (index, ctx) => index < ctx.config.users ? 'rigid' : 'morph',
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick, ctx.config.count - ctx.config.users, ctx.config.users);
      for (const index of indexes) unwrap(ctx.world.set(ctx.entities[index], MorphWeights, { weights: new Float32Array([0.5 + Math.sin(tick * 0.2 + index) * 0.5]) }));
      return { tick, weights: indexes.length };
    } },
  transparent: { summary: 'half of the rows are blended (params.fraction of N), D pose writes, moving camera',
    kindAt: (index, ctx) => index >= ctx.config.users && index % 2 === 1 ? 'transparent' : 'rigid',
    step(ctx, tick) { cameraSweep(ctx, tick); return moveStep(ctx, tick); } },
  'alpha-mask': { summary: 'every row uses an alphaCutoff material (alpha-tested), D pose writes',
    prepare(ctx) { ctx.mask = unwrap(ctx.assets.create(Materials.standard({ baseColor: [0.3, 0.7, 0.4, 0.7], alphaCutoff: 0.5 }))); },
    pick: (_index, _kind, ctx) => ({ material: ctx.mask }),
    step: moveStep },
  lod: { summary: 'every row uses a three-level LOD mesh; the camera dollies across both thresholds each cycle',
    prepare(ctx) {
      const make = size => unwrap(ctx.assets.create(unwrap(createBoxGeometry(size, 0.12, 0.12))));
      const base = unwrap(createBoxGeometry(0.12, 0.12, 0.12));
      const near = 0.12 / (2 * ctx.cameraDistance * Math.tan(Math.PI / 6));
      ctx.lodMesh = unwrap(ctx.assets.create({ ...base, lods: [{ mesh: make(0.121), screenCoverage: near * 1.1 }, { mesh: make(0.122), screenCoverage: near * 0.8 }] }));
    },
    pick: (_index, _kind, ctx) => ({ mesh: ctx.lodMesh }),
    step(ctx, tick) { unwrap(ctx.world.set(ctx.camera, Transform, { pos: [0, 0, ctx.cameraDistance * (1 + 0.4 * Math.sin(tick * 0.15))] })); return { tick, camera: 1 }; } },
  instancing: { summary: 'N is the instance count: N/8 carriers of 8 instances each; D carriers rewrite their Instances array',
    kindAt: () => 'instances', carriers: ctx => Math.max(Math.ceil(ctx.config.count / 8), Math.min(ctx.config.count, ctx.config.users + 1)),
    step(ctx, tick) {
      const indexes = sparse(ctx.config.dirty, tick, ctx.entities.length);
      for (const index of indexes) {
        const transforms = new Float32Array(8 * 16);
        for (let i = 0; i < 8; i++) { for (const offset of [0, 5, 10, 15]) transforms[i * 16 + offset] = 1; transforms[i * 16 + 12] = i * 0.04 + Math.sin(tick * 0.1) * 0.01; }
        unwrap(ctx.world.set(ctx.entities[index], Instances, { transforms }));
      }
      return { tick, carriers: indexes.length };
    } },
  'materials-many': { summary: 'every row owns a unique Standard material (params.unique default N); D pose writes',
    prepare(ctx) { ctx.unique = Math.min(ctx.config.count, ctx.params.unique ?? ctx.config.count); ctx.uniques = new Array(ctx.unique); },
    pick(index, _kind, ctx) { ctx.uniques[index % ctx.unique] ??= unwrap(ctx.assets.create(Materials.standard({ baseColor: [(index % 97) / 97, (index % 89) / 89, (index % 83) / 83, 1], roughness: (index % 11) / 11 }))); return { material: ctx.uniques[index % ctx.unique] }; },
    step: moveStep },
  'materials-few': { summary: 'rows share four Standard materials; D pose writes',
    prepare(ctx) { ctx.pool = [0.2, 0.4, 0.6, 0.8].map(r => unwrap(ctx.assets.create(Materials.standard({ baseColor: [r, 0.5, 1 - r, 1], roughness: r })))); },
    pick: (index, _kind, ctx) => ({ material: ctx.pool[index % ctx.pool.length] }),
    step: moveStep },
  'hot-texture': { summary: 'a shared texture (K=users consumers) is replaced in place each frame, plus D pose writes',
    prepare(ctx) {
      ctx.hotTexture = unwrap(ctx.assets.create(texture(255)));
      ctx.sharedMaterial = unwrap(ctx.assets.create(Materials.standard({ baseColor: [0.8, 0.3, 0.2, 1], baseColorTexture: { texture: ctx.hotTexture } })));
    },
    step(ctx, tick) { unwrap(ctx.assets.replace(ctx.hotTexture, texture(tick % 2 ? 128 : 255))); return { ...moveStep(ctx, tick), texture: 1 }; } },
  'hot-material': { summary: 'a shared material (K=users) value edit each frame, plus D pose writes',
    step(ctx, tick) { unwrap(ctx.assets.update(ctx.sharedMaterial, { values: { roughness: 0.4 + tick % 2 * 0.2 } })); return { ...moveStep(ctx, tick), material: 1 }; } },
  'hot-mesh': { summary: 'a shared mesh (K=users) replaced each frame, plus D pose writes',
    step(ctx, tick) { unwrap(ctx.assets.replace(ctx.sharedMesh, unwrap(createBoxGeometry(0.12 + tick % 2 * 0.01, 0.12, 0.12)))); return { ...moveStep(ctx, tick), mesh: 1 }; } },
};

export const defaultParams = { cameras: 1, targets: 1, lights: 8, moving: 0, fraction: 0.5 };

// A cell is one scenario plus its parameters and a D rule. Sizes N are chosen by the matrix runner.
// `d` is a function of N; D never exceeds N.
const fixed = n => () => n, pct = f => n => Math.max(1, Math.ceil(n * f));
export const cells = {
  static: { scenario: 'idle', d: fixed(0) },
  'move-d8': { scenario: 'move', d: fixed(8) },
  'move-1pct': { scenario: 'move', d: pct(0.01) },
  'move-10pct': { scenario: 'move', d: pct(0.1) },
  'move-100pct': { scenario: 'move', d: n => n },
  'churn-d8': { scenario: 'churn', d: fixed(8) },
  'churn-1pct': { scenario: 'churn', d: pct(0.01) },
  'material-swap': { scenario: 'material-swap', d: fixed(8) },
  'mesh-swap': { scenario: 'mesh-swap', d: fixed(8) },
  'visibility-toggle': { scenario: 'visibility-toggle', d: fixed(8) },
  'cameras-1': { scenario: 'multi-camera', d: fixed(8), cameras: 1 },
  'cameras-2': { scenario: 'multi-camera', d: fixed(8), cameras: 2 },
  'cameras-4': { scenario: 'multi-camera', d: fixed(8), cameras: 4 },
  'split-screen': { scenario: 'split-screen', d: fixed(8), cameras: 2 },
  'rt-camera': { scenario: 'render-target-camera', d: fixed(8), params: { targets: 1 } },
  'shadow-lights-8': { scenario: 'shadow-lights', d: fixed(8), params: { lights: 8 } },
  'shadow-lights-32': { scenario: 'shadow-lights', d: fixed(8), params: { lights: 32 } },
  'shadow-lights-32-moving': { scenario: 'shadow-lights', d: fixed(8), params: { lights: 32, moving: 1 } },
  skinned: { scenario: 'skinned', d: fixed(8) },
  morph: { scenario: 'morph', d: fixed(8) },
  transparent: { scenario: 'transparent', d: fixed(8) },
  'alpha-mask': { scenario: 'alpha-mask', d: fixed(8) },
  lod: { scenario: 'lod', d: fixed(0) },
  instancing: { scenario: 'instancing', d: fixed(8) },
  'materials-many': { scenario: 'materials-many', d: fixed(8) },
  'materials-few': { scenario: 'materials-few', d: fixed(8) },
  'hot-texture': { scenario: 'hot-texture', d: fixed(8) },
  'hot-material': { scenario: 'hot-material', d: fixed(8) },
  'hot-mesh': { scenario: 'hot-mesh', d: fixed(8) },
  // The stub cannot read pixels back, so the recovery candidate probe only passes on a real device: this cell defaults to dawn.
  recovery: { scenario: 'move', d: fixed(8), loseAt: 30, backend: 'dawn' },
};

// Run-config fragment of one cell at size N: what run.mjs passes to the Worker and validateConfig.
export function cellConfig(id, count) {
  const cell = cells[id];
  assert(cell, `unknown cell ${id}`);
  const dirty = Math.min(count, cell.d(count));
  return { scenario: cell.scenario, count, dirty, users: Math.max(1, Math.min(128, Math.floor(count / 2))),
    ...(cell.cameras === undefined ? {} : { cameras: cell.cameras }),
    params: { ...defaultParams, ...(cell.params ?? {}), ...(cell.cameras === undefined ? {} : { cameras: cell.cameras }) },
    ...(cell.loseAt === undefined ? {} : { loseAt: cell.loseAt }), ...(cell.backend === undefined ? {} : { backend: cell.backend }) };
}

export function createWorkload(assets, config) {
  validateConfig(config);
  const scenario = config.scenario === undefined ? undefined : scenarios[config.scenario];
  const params = { ...defaultParams, ...(config.params ?? {}) };
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const base = unwrap(createBoxGeometry(0.12, 0.12, 0.12));
  const mesh = unwrap(assets.create(base));
  const sharedMesh = unwrap(assets.create(base));
  const morphMesh = unwrap(assets.create({ ...base, morphTargets: [{ position: new Float32Array(base.attributes.position.length).fill(0.01) }] }));
  const vertices = base.attributes.position.length / 3;
  const skinWeight = new Float32Array(vertices * 4);
  for (let i = 0; i < vertices; i++) skinWeight[i * 4] = 1;
  const attributes = { ...base.attributes, skinIndex: new Uint16Array(vertices * 4), skinWeight };
  const packed = unwrap(packInterleavedVertexAttributes(attributes, vertices));
  const skinMesh = unwrap(assets.create({ ...base, attributes, vertices: packed.vertices }));
  const skeleton = unwrap(assets.create({ kind: 'skeleton', jointCount: 1,
    inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    bounds: new Float32Array([-0.2, -0.2, -0.2, 0.2, 0.2, 0.2]) }));
  const sharedMaterial = unwrap(assets.create(Materials.standard({ baseColor: [0.8, 0.3, 0.2, 1], roughness: 0.6 })));
  const standard = unwrap(assets.create(Materials.standard({ baseColor: [0.2, 0.6, 0.4, 1], roughness: 0.5 })));
  const unlit = unwrap(assets.create(Materials.unlit([0.3, 0.4, 0.8, 1])));
  const skinAsset = Materials.standard({ baseColor: [0.4, 0.5, 0.7, 1] });
  const skinMaterial = unwrap(assets.create({ ...skinAsset, passes: skinAsset.passes.filter(p => p.name !== 'deferred').map(p => p.name === 'forward' ? { ...p, program: { module: 'forgeax::pbr-skin', fragmentEntry: 'fs_main' } } : p) }));
  const transparent = unwrap(assets.create(Materials.unlit([0.7, 0.3, 0.6, 0.5], { renderState: { blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  } } })));
  const parents = Array.from({ length: 4 }, () => unwrap(world.spawn({ component: Transform, data: {} })));
  const side = Math.ceil(Math.sqrt(config.count));
  const position = index => [(index % side - (side - 1) / 2) * 0.18, (Math.floor(index / side) - (side - 1) / 2) * 0.18, 0];
  const categories = { rigid: 0, unlit: 0, transparent: 0, skin: 0, morph: 0, instances: 0, descendants: 0 };
  const entities = [];
  const cameraDistance = side * 0.22;
  const ctx = { world, assets, config, params, entities, position, sharedMesh, sharedMaterial, cameraDistance, joints: new Map(), cameras: [] };
  scenario?.prepare?.(ctx);
  // `residuals` bounds the non-batched kinds to a fixed index prefix, so N grows only rigid GPU-batched rows.
  // `transparent` turns the first T rows after the shared users into blended rows (the sorted phase).
  const legacyKind = index => index >= config.users && index < config.users + (config.transparent ?? 0) ? 'transparent' : index < config.users || index >= (config.residuals ?? Infinity) ? 'rigid' : ['skin', 'morph', 'transparent', 'unlit', 'instances'][index % 32] ?? 'rigid';
  const kindAt = scenario === undefined ? legacyKind : scenario.kindAt ? index => scenario.kindAt(index, ctx) : () => 'rigid';
  const rows = scenario?.carriers?.(ctx) ?? config.count;
  const spawn = index => {
    const kind = kindAt(index);
    const picked = scenario?.pick?.(index, kind, ctx) ?? {};
    const shared = index < config.users;
    const entity = unwrap(world.spawn(
      { component: Transform, data: { pos: position(index) } },
      { component: MeshFilter, data: { assetHandle: picked.mesh ?? (shared ? ctx.sharedMesh : kind === 'skin' ? skinMesh : kind === 'morph' ? morphMesh : mesh) } },
      { component: MeshRenderer, data: { materials: [picked.material ?? (shared ? ctx.sharedMaterial : kind === 'skin' ? skinMaterial : kind === 'unlit' ? unlit : kind === 'transparent' ? transparent : standard)] } },
      ...(scenario === undefined && index >= config.users && index < config.users + 32 ? [{ component: ChildOf, data: { parent: parents[index % parents.length] } }] : []),
      ...(kind === 'morph' ? [{ component: MorphWeights, data: { weights: new Float32Array([0.5]) } }] : []),
      ...(scenario?.extra?.(index, kind, ctx) ?? []),
    ));
    if (kind === 'skin') {
      let joint = entity;
      if (scenario?.joints) { joint = unwrap(world.spawn({ component: Transform, data: { pos: position(index) } })); ctx.joints.set(index, joint); }
      unwrap(world.addComponent(entity, { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } }));
    }
    if (kind === 'instances') {
      const per = scenario?.carriers ? 8 : 4;
      const transforms = new Float32Array(per * 16);
      for (let i = 0; i < per; i++) { for (const offset of [0, 5, 10, 15]) transforms[i * 16 + offset] = 1; transforms[i * 16 + 12] = i * 0.04; }
      unwrap(world.addComponent(entity, { component: Instances, data: { transforms } }));
    }
    return entity;
  };
  ctx.spawn = spawn;
  for (let index = 0; index < rows; index++) {
    entities.push(spawn(index)); categories[kindAt(index)] = (categories[kindAt(index)] ?? 0) + 1;
    if (scenario === undefined && index >= config.users && index < config.users + 32) categories.descendants++;
  }
  // `cameras` > 1 composes that many CameraViews in screen quadrants; each is an independent view.
  const cameraCount = config.cameras ?? 1;
  const cameras = Array.from({ length: cameraCount }, (_, index) => unwrap(world.spawn(
    { component: Transform, data: { pos: [index * 0.05, 0, cameraDistance] } },
    { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: cameraDistance * 4 } },
    ...(cameraCount === 1 ? [] : [{ component: CameraView, data: {
      viewport: new Float32Array([(index % 2) * 0.5, Math.floor(index / 2) * 0.5, 0.5, 0.5]), order: index } }]))));
  const camera = cameras[0];
  ctx.cameras = cameras; ctx.camera = camera;
  if (scenario?.lights !== true) {
    unwrap(world.spawn({ component: DirectionalLight, data: { intensity: 2, direction: [-0.3, -0.5, -1], castShadow: true, cascadeCount: 2, mapSize: 256 } }));
    for (let index = 0; index < 8; index++) unwrap(world.spawn({ component: Transform, data: { pos: [index - 4, 1, 2] } },
      { component: PointLight, data: { intensity: 2, range: 10, color: [0.8, 0.9, 1] } }));
  }
  scenario?.setup?.(ctx);
  return {
    world, entities, categories, expectedProjectionRecords: entities.length, sharedMaterial: ctx.sharedMaterial, sharedMesh, camera, targetOwner: ctx.targetOwner,
    apply(phase, tick) {
      if (scenario) return scenario.step(ctx, tick);
      const operation = commands(config, phase, tick);
      for (const index of operation.pose) { const pos = position(index); pos[2] = Math.sin(tick * 0.1 + index) * 0.02; unwrap(world.set(entities[index], Transform, { pos })); }
      for (const index of operation.binding) {
        // Preserve the Skin program; all other kinds change an actual binding.
        unwrap(world.set(entities[index], MeshRenderer, { materials: [kindAt(index) === 'skin' ? skinMaterial : tick % 2 ? standard : unlit], lightingChannels: 1 + tick % 2 }));
      }
      if (operation.camera) unwrap(world.set(camera, Transform, { pos: [Math.sin(tick * 0.01) * 0.1, 0, cameraDistance] }));
      if (operation.material) unwrap(assets.update(sharedMaterial, { values: { roughness: 0.4 + tick % 2 * 0.2 } }));
      if (operation.mesh) unwrap(assets.replace(sharedMesh, unwrap(createBoxGeometry(0.12 + tick % 2 * 0.01, 0.12, 0.12))));
      if (operation.hierarchy) unwrap(world.set(parents[tick % parents.length], Transform, { pos: [0, Math.sin(tick * 0.1) * 0.02, 0] }));
      for (const index of operation.churn) { unwrap(world.despawn(entities[index])); entities[index] = spawn(index); }
      return operation;
    },
  };
}
