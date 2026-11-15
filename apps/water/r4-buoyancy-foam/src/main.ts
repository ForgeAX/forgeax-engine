import { WaterBuoyancyCompletion, WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, FixedTime, FixedUpdate, Update, type EntityHandle, type InputShapeOf, type SchemaOf } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { PhysicsWorldResource, Collider, type PhysicsWorld } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { ANTIALIAS_TAA, Camera, DirectionalLight, type FrameReceipt, MeshFilter, MeshRenderer, perspective, Skylight, TONEMAP_ACES_FILMIC, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { WATER_BUOYANCY_RESOURCE, type WaterBuoyancyState, waterSceneSnapshot } from '@forgeax/engine/runtime';
import { ChildOf, readPresentationWorldMatrix, sceneEntity, Transform, WaterExclusionMode, WaterExclusionVolume, WaterPontoonSet, worldResolveSceneEntity } from '@forgeax/engine/scene';
import { err, ok } from '@forgeax/engine/types';
import { queryWaterParticle, type WaterBuoyancyStep, WaterParticleQueryInstance, type WaterSystem } from '@forgeax/engine/water';
import { FOAM_MATERIAL_MODES, foamMaterialKey, WATER_R4_PACKAGE, pontoonLayout, pontoonRadius, type FoamMaterialMode, type PontoonCount } from './identity';
import './style.css';

const node = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
};
type Body = 'river' | 'lake' | 'ocean';
type View = 'overview' | 'follow' | 'shore' | 'manual';
type Vector = [number, number, number];
const bodyLabels = { river: '河道', lake: '湖面', ocean: '近海' } as const;
const fixed = (value: number | undefined, digits = 2) => value === undefined ? '--' : value.toFixed(digits);
const vector = (value: readonly number[] | undefined) => value ? value.map(v => v.toFixed(2)).join(', ') : '--';
const jsonFacts = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    const failure = value as Error & { code?: unknown; expected?: unknown; hint?: unknown; detail?: unknown };
    return { name: failure.name, message: failure.message, code: failure.code, expected: failure.expected, hint: failure.hint, detail: failure.detail, stack: failure.stack };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number>);
  if (value !== null && typeof value === 'object' && 'size' in value && typeof value.size === 'number' && Symbol.iterator in value && typeof value[Symbol.iterator] === 'function') return Array.from(value as Iterable<unknown>);
  return value;
};

async function main() {
  const canvas = node<HTMLCanvasElement>('scene');
  const app = (await createApp(canvas, {
    plugins: [physics3d], uiRoot: node('controls-panel'), pointerLockAllowed: () => false,
    ...(__WATER_R4_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R4_SSR_IDENTITY__ }),
    ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
  }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) })).unwrap();
  const { world, assets } = app;
  if (!assets) throw new Error('Asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R4_PACKAGE, key));
  const scene = (await assets.load(guid('scene/harbor'), 'scene')).unwrap();
  const root = assets.instantiate(scene, world).unwrap();
  const sceneSourceKey = assets.sourceKeyOf(guid('scene/harbor'));
  if (!sceneSourceKey) throw new Error('Saved Scene has no accepted Catalog source key');
  const resolve = (key: string) => worldResolveSceneEntity(world, root, sceneEntity(sceneSourceKey, key)).unwrap();
  const sphere = (await assets.load(guid('mesh/sphere'), 'mesh')).unwrap();
  const white = (await assets.load(guid('material/white'), 'material')).unwrap();
  const centeredCollider = (await assets.load(guid('mesh/collider-centered'), 'mesh')).unwrap();
  const eccentricCollider = (await assets.load(guid('mesh/collider-eccentric'), 'mesh')).unwrap();
  const crafts = await Promise.all((['river', 'lake', 'ocean'] as const).map(async (type) => {
    const initialCount: PontoonCount = type === 'river' ? 4 : type === 'lake' ? 1 : 16;
    return { type, entity: resolve(`${type}-craft`), initialPosition: (type === 'river' ? [-24, .8, -1] : type === 'lake' ? [4, .8, 1] : [27, .8, -2]) as Vector,
      waterEntity: resolve(type), body: (await assets.load(guid(`body/${type}`), 'water-body')).unwrap(), count: initialCount,
      material: (await assets.load(guid(`material/${type === 'river' ? 'red' : type === 'lake' ? 'yellow' : 'teal'}`), 'material')).unwrap(),
      visuals: Array.from({ length: initialCount }, (_, i) => resolve(`${type}-craft-pontoon-${i}`)),
      sockets: type === 'ocean' ? Array.from({ length: initialCount }, (_, i) => resolve(`${type}-craft-socket-${i}`)) : [] as EntityHandle[],
    };
  }));
  const craft = () => crafts.find(c => c.type === selected)!;
  const physics = () => world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const buoyancy = () => world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
  let selected: Body = 'river';
  let selectedView: View = 'overview';
  let eye: Vector = [37, 30, 46], target: Vector = [-2, 0, 0];
  let completedFrames = 0, completedReceipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'> | undefined;
  const errors: unknown[] = [];
  let errorCount = 0;
  const recordError = (error: unknown) => { errorCount++; errors.push(error); if (errors.length > 64) errors.shift(); node('render-state').textContent = '运行错误'; console.error(error); };
  let pendingReset: { type: Body; preset?: 'river-lake' | 'lake-ocean' | 'reentry' } | undefined;
  let lastTraceStep = -1, droppedSteps = 0;
  const completedSteps: { physicsStep: number; steps: WaterBuoyancyState['steps']; splashWakeEvents: WaterBuoyancyState['splashWakeEvents'] }[] = [];
  let lastStep: WaterBuoyancyStep | undefined;
  const eventCounts = { entered: 0, exited: 0, wake: 0 };
  let lastEventStep: number | undefined;
  const particles: { entity: EntityHandle; positionM: Vector; velocityMps: Vector; age: number; sourcePhysicsStep: number }[] = [];
  const particleInstances = new Map<string, WaterParticleQueryInstance>();
  let droppedParticleSamples = 0;
  const exclusion = world.spawn({ component: Transform, data: {} }).unwrap();
  const queryMarker = world.spawn({ component: Transform, data: { scale: [.18, .18, .18] } },
    { component: MeshFilter, data: { assetHandle: sphere } }, { component: MeshRenderer, data: { materials: [white] } },
    { component: Visibility, data: { state: VisibilityStateValue.hidden } }).unwrap();
  const camera = world.spawn({ component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3.2, aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight), near: .08, far: 400 }),
      clearColor: [.66, .8, .84, 1], antialias: ANTIALIAS_TAA, tonemap: TONEMAP_ACES_FILMIC } }).unwrap();
  world.spawn({ component: DirectionalLight, data: { direction: [-.45, -.8, -.3], color: [1, .96, .86], intensity: 2.8, castShadow: false } }).unwrap();
  world.spawn({ component: Skylight, data: { color: [.65, .82, .92], intensity: 1.3 } }).unwrap();

  const applyCamera = () => world.set(camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) }).unwrap();
  const position = (entity: EntityHandle): Vector => {
    const matrix = readPresentationWorldMatrix(world, entity);
    return matrix ? [matrix[12]!, matrix[13]!, matrix[14]!] : [...craft().initialPosition];
  };
  const particleQueryAt = (bodyGuid: string, bodyGeneration: number, at: readonly [number, number, number], rootEntity: EntityHandle) => {
    const dynamics = physics().getCommittedBodyDynamics?.(rootEntity);
    if (!dynamics?.ok) return undefined;
    const key = `${rootEntity}:${bodyGuid}`;
    let instance = particleInstances.get(key);
    if (!instance) { instance = new WaterParticleQueryInstance(); particleInstances.set(key, instance); }
    const time = world.getResource(FixedTime), timeSeconds = time.tick * time.delta;
    const systemTick = { tick: time.tick, bodyGuid, bodyGeneration, systemPositionM: [...dynamics.value.positionM] as Vector, timeSeconds,
      evaluateSystemDepth: node<HTMLInputElement>('di-system-depth').checked, evaluateSystemDepthPerFrame: node<HTMLInputElement>('di-system-depth-frame').checked };
    const request = { simulation: node<HTMLSelectElement>('di-mode').value as 'cpu' | 'gpu', tick: time.tick, bodyGuid, bodyGeneration, positionM: [...at] as Vector, timeSeconds,
      executeQuery: node<HTMLInputElement>('di-execute').checked, includeDepth: node<HTMLInputElement>('di-depth').checked,
      includeWaves: node<HTMLInputElement>('di-waves').checked, simpleWaves: node<HTMLInputElement>('di-simple').checked,
      depthQueryMode: node<HTMLSelectElement>('di-depth-mode').value as 'system-instance' | 'particle' };
    const tick = instance.tick(water(), systemTick);
    return { systemTick, request, result: tick.ok ? queryWaterParticle(water(), { ...request, instance }) : err(tick.error) };
  };
  const particleSamples: { sourcePhysicsStep: number; query: NonNullable<ReturnType<typeof particleQueryAt>> }[] = [];
  const refreshView = () => { for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === selectedView)); };
  const setView = (view: Exclude<View, 'manual'>) => {
    selectedView = view;
    if (view === 'overview') { eye = [37, 30, 46]; target = [-2, 0, 0]; }
    else if (view === 'shore') { eye = [14, 3.5, 25]; target = [19, .1, -2]; }
    else { const p = position(craft().entity); eye = [p[0] + 8, p[1] + 5, p[2] + 10]; target = [p[0], p[1] + .6, p[2]]; }
    refreshView(); applyCamera();
  };
  const report = (result: { ok: boolean; error?: unknown }) => {
    node('action-state').textContent = result.ok ? '变更已提交' : String((result.error as { code?: string })?.code ?? result.error);
    if (!result.ok) recordError(result.error);
  };
  const patch = (data: Partial<InputShapeOf<SchemaOf<typeof WaterPontoonSet>>>) => report(world.set(craft().entity, WaterPontoonSet, data));
  const updateExclusion = () => {
    const present = world.hasComponent(exclusion, WaterExclusionVolume);
    if (!node<HTMLInputElement>('exclusion').checked) { if (present) world.removeComponent(exclusion, WaterExclusionVolume).unwrap(); return; }
    const data = { mode: WaterExclusionMode.addListedBodiesToExclusion, waterBodies: [craft().waterEntity], centerM: position(craft().entity), halfExtentsM: [5, 8, 5] };
    report(present ? world.set(exclusion, WaterExclusionVolume, data) : world.addComponent(exclusion, { component: WaterExclusionVolume, data }));
  };
  const rebuildPontoons = () => {
    const c = craft(), count = Number(node<HTMLSelectElement>('pontoon-count').value) as PontoonCount;
    const socket = node<HTMLSelectElement>('anchor-mode').value === 'socket', points = pontoonLayout(count), radius = pontoonRadius(count);
    for (const entity of [...c.visuals, ...c.sockets]) world.despawn(entity).unwrap();
    c.visuals = []; c.sockets = []; c.count = count;
    for (const p of points) {
      if (socket) c.sockets.push(world.spawn({ component: Transform, data: { pos: p } }, { component: ChildOf, data: { parent: c.entity } }).unwrap());
      c.visuals.push(world.spawn({ component: Transform, data: { pos: p, scale: [radius, radius, radius] } },
        { component: ChildOf, data: { parent: c.entity } }, { component: MeshFilter, data: { assetHandle: sphere } },
        { component: MeshRenderer, data: { materials: [c.material] } },
        { component: Visibility, data: { state: node<HTMLInputElement>('pontoons').checked ? VisibilityStateValue.visible : VisibilityStateValue.hidden } }).unwrap());
    }
    patch({ anchorMode: socket ? 1 : 0, anchorsM: points.flatMap(p => socket ? [0, 0, 0] : [...p]), socketEntities: c.sockets, radiiM: points.map(() => radius), enabledPontoons: [] });
    pendingReset = { type: selected };
  };
  const refreshCraftControls = () => {
    const data = world.get(craft().entity, WaterPontoonSet).unwrap();
    node<HTMLSelectElement>('pontoon-count').value = String(data.radiiM.length);
    node<HTMLSelectElement>('anchor-mode').value = data.anchorMode === 0 ? 'relative' : 'socket';
    node<HTMLInputElement>('coefficient').value = String(data.buoyancyCoefficientNPerM3);
    node<HTMLInputElement>('force-cap').value = String(data.maxBuoyantForceN);
    node<HTMLInputElement>('buoyancy').checked = data.enabled;
    node<HTMLInputElement>('drag').checked = data.applyDrag;
    node<HTMLInputElement>('river-force').checked = data.applyRiverForces;
    node<HTMLInputElement>('eccentric').checked = world.get(craft().entity, Collider).unwrap().mesh === eccentricCollider;
    node<HTMLSelectElement>('di-body').value = selected;
  };
  node('craft').addEventListener('change', () => { selected = node<HTMLSelectElement>('craft').value as Body; refreshCraftControls(); updateExclusion(); if (selectedView === 'follow') setView('follow'); refresh(); });
  for (const id of ['pontoon-count', 'anchor-mode']) node(id).addEventListener('change', rebuildPontoons);
  node('coefficient').addEventListener('change', () => patch({ buoyancyCoefficientNPerM3: Number(node<HTMLInputElement>('coefficient').value) }));
  node('force-cap').addEventListener('change', () => patch({ maxBuoyantForceN: Number(node<HTMLInputElement>('force-cap').value) }));
  for (const [id, key] of [['buoyancy', 'enabled'], ['drag', 'applyDrag'], ['river-force', 'applyRiverForces']] as const) node(id).addEventListener('change', () => patch({ [key]: node<HTMLInputElement>(id).checked }));
  node('eccentric').addEventListener('change', () => { report(world.set(craft().entity, Collider, { mesh: node<HTMLInputElement>('eccentric').checked ? eccentricCollider : centeredCollider })); pendingReset = { type: selected }; });
  node('reset').addEventListener('click', () => { pendingReset = { type: selected }; });
  node('launch').addEventListener('click', () => { pendingReset = { type: selected, preset: node<HTMLSelectElement>('launch-preset').value as 'river-lake' | 'lake-ocean' | 'reentry' }; setView('follow'); });
  node('exclusion').addEventListener('change', updateExclusion);
  node('waves').addEventListener('change', () => { const on = node<HTMLInputElement>('waves').checked; for (const c of crafts) report(assets.update(c.body, { waveSetGuid: guid(on ? 'waves/harbor' : 'waves/off') })); });
  const foamMaterial = () => {
    const mode = node<HTMLSelectElement>('foam-material-mode').value as FoamMaterialMode;
    return { mode, values: FOAM_MATERIAL_MODES[mode], enabled: node<HTMLInputElement>('foam').checked };
  };
  const updateFoamMaterial = () => {
    const on = node<HTMLInputElement>('foam').checked;
    const mode = node<HTMLSelectElement>('foam-material-mode').value as FoamMaterialMode;
    report(assets.update(crafts.find(c => c.type === 'ocean')!.body, { surfaceMaterialGuid: guid(foamMaterialKey(mode, on)), lodMaterialGuid: guid(foamMaterialKey(mode, on, true)) }));
  };
  node('foam').addEventListener('change', updateFoamMaterial);
  node('foam-material-mode').addEventListener('change', updateFoamMaterial);
  node('pontoons').addEventListener('change', () => { for (const c of crafts) for (const entity of c.visuals) {
    const data = { state: node<HTMLInputElement>('pontoons').checked ? VisibilityStateValue.visible : VisibilityStateValue.hidden };
    report(world.hasComponent(entity, Visibility) ? world.set(entity, Visibility, data) : world.addComponent(entity, { component: Visibility, data }));
  } });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view as Exclude<View, 'manual'>));
  node('panel-toggle').addEventListener('click', () => { document.body.classList.toggle('panel-hidden'); node('panel-toggle').setAttribute('aria-expanded', String(!document.body.classList.contains('panel-hidden'))); });
  node('trace-toggle').addEventListener('click', () => { document.body.classList.toggle('trace-hidden'); node('trace-toggle').setAttribute('aria-expanded', String(!document.body.classList.contains('trace-hidden'))); });
  if (window.matchMedia('(max-width:620px)').matches) { document.body.classList.add('panel-hidden'); node('panel-toggle').setAttribute('aria-expanded', 'false'); }
  let dragPointer: { id: number; x: number; y: number } | undefined;
  canvas.addEventListener('pointerdown', event => { canvas.focus(); canvas.setPointerCapture(event.pointerId); dragPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointerup', () => { dragPointer = undefined; });
  canvas.addEventListener('pointercancel', () => { dragPointer = undefined; });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointermove', event => {
    if (!dragPointer || dragPointer.id !== event.pointerId) return;
    const dx = event.clientX - dragPointer.x, dy = event.clientY - dragPointer.y; dragPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const d = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    const yaw = Math.atan2(eye[0] - target[0], eye[2] - target[2]) - dx * .006;
    const pitch = Math.max(.035, Math.min(1.48, Math.asin((eye[1] - target[1]) / d) + dy * .006));
    eye = [target[0] + d * Math.cos(pitch) * Math.sin(yaw), target[1] + d * Math.sin(pitch), target[2] + d * Math.cos(pitch) * Math.cos(yaw)];
    selectedView = 'manual'; refreshView(); applyCamera();
  });
  canvas.addEventListener('wheel', event => { event.preventDefault(); const factor = Math.exp(Math.max(-.5, Math.min(.5, event.deltaY * .001))); const distance = Math.hypot(...eye.map((v, i) => v - target[i]!)); const scale = Math.max(2, Math.min(150, distance * factor)) / distance; eye = eye.map((v, i) => target[i]! + (v - target[i]!) * scale) as Vector; selectedView = 'manual'; refreshView(); applyCamera(); }, { passive: false });

  world.addSystem(Update, defineSystem({ name: 'waterR4CameraAndReset', queries: [], fn: () => {
    if (pendingReset && world.hasResource(PhysicsWorldResource)) {
      const c = crafts.find(value => value.type === pendingReset!.type)!;
      if (physics().hasBody(c.entity)) {
        const preset = pendingReset.preset;
        const start: Vector = preset === 'river-lake' ? [-4, .6, -1] : preset === 'lake-ocean' ? [18, .6, 0] : preset === 'reentry' ? position(c.entity) : [...c.initialPosition];
        if (preset === 'reentry') start[1] = 4;
        const reset = physics().setBodyMotion?.(c.entity, { position: start, rotation: [0, 0, 0, 1], linearVelocity: preset === 'river-lake' || preset === 'lake-ocean' ? [5, 0, 0] : [0, 0, 0], angularVelocity: [0, 0, 0] });
        if (reset) report(reset);
        pendingReset = undefined;
      }
    }
    if (selectedView === 'follow') { const p = position(craft().entity); eye = [p[0] + 8, p[1] + 5, p[2] + 10]; target = [p[0], p[1] + .6, p[2]]; applyCamera(); }
  } })).unwrap();
  world.addSystem(FixedUpdate, defineSystem({ name: 'waterR4CompletedEvidence', after: [WaterBuoyancyCompletion], queries: [], fn: () => {
    const state = buoyancy();
    const step = state.steps.find(value => value.result.ok)?.result;
    if (!step?.ok || step.value.physicsStep === lastTraceStep) return;
    const completed = physics().getCommittedBodyDynamics?.(step.value.rootEntity);
    if (!completed?.ok || completed.value.completedStep !== step.value.physicsStep) return;
    lastTraceStep = step.value.physicsStep;
    completedSteps.push({ physicsStep: lastTraceStep, steps: state.steps, splashWakeEvents: state.splashWakeEvents });
    if (completedSteps.length > 240) { completedSteps.shift(); droppedSteps++; }
    const time = world.getResource(FixedTime);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!; p.age += time.delta;
      if (p.age > .7) { world.despawn(p.entity).unwrap(); particles.splice(i, 1); continue; }
      p.velocityMps[1] -= time.delta * .8;
      p.positionM = p.positionM.map((v, axis) => v + p.velocityMps[axis]! * time.delta) as Vector;
      world.set(p.entity, Transform, { pos: p.positionM, scale: [.05 * (1 - p.age), .035, .05 * (1 - p.age)] }).unwrap();
    }
    for (const event of state.splashWakeEvents) {
      eventCounts[event.phase]++; lastEventStep = event.sourcePhysicsStep;
      if (!event.bodyGuid || event.bodyGeneration === undefined || event.phase === 'exited' || (event.phase === 'wake' && event.sourcePhysicsStep % 8 !== 0)) continue;
      const at: Vector = [...event.positionM];
      const query = particleQueryAt(event.bodyGuid, event.bodyGeneration, at, event.rootEntity as EntityHandle);
      if (!query) continue;
      const { result } = query;
      particleSamples.push({ sourcePhysicsStep: event.sourcePhysicsStep, query });
      if (particleSamples.length > 64) { particleSamples.shift(); droppedParticleSamples++; }
      if (!result.ok || !result.value.valid || particles.length >= 64) continue;
      const sample = result.value, surface = sample.surfacePositionM;
      if (sample.excluded) continue;
      const p: Vector = [surface[0], surface[1] + .055, surface[2]];
      const entity = world.spawn({ component: Transform, data: { pos: p, scale: [.05, .035, .05] } },
        { component: MeshFilter, data: { assetHandle: sphere } }, { component: MeshRenderer, data: { materials: [white] } }).unwrap();
      particles.push({ entity, positionM: p, velocityMps: [sample.waterVelocityMps[0] * .2, .22, sample.waterVelocityMps[2] * .2], age: 0, sourcePhysicsStep: event.sourcePhysicsStep });
    }
  } })).unwrap();

  const queryParticle = () => {
    const type = node<HTMLSelectElement>('di-body').value as Body, c = crafts.find(value => value.type === type)!;
    const snapshot = waterSceneSnapshot(world, c.waterEntity);
    if (!snapshot) return undefined;
    const dynamics = physics().getCommittedBodyDynamics?.(craft().entity);
    const offset = ['x', 'y', 'z'].map(axis => Number(node<HTMLInputElement>(`di-offset-${axis}`).value));
    if (!dynamics?.ok || !offset.every(Number.isFinite)) return undefined;
    const at = dynamics.value.positionM.map((value, axis) => value + offset[axis]!) as Vector;
    return particleQueryAt(snapshot.guid, snapshot.sceneGeneration, at, craft().entity);
  };
  const readState = () => ({ completedFrames, completedReceipt, errorCount, errors, selected, selectedView, cameraPose: { eye: [...eye], target: [...target] },
    sceneRoot: root, crafts: crafts.map(c => ({ type: c.type, entity: c.entity, waterEntity: c.waterEntity, config: world.get(c.entity, WaterPontoonSet).unwrap(), dynamics: physics().getCommittedBodyDynamics?.(c.entity), snapshot: waterSceneSnapshot(world, c.waterEntity) })),
    buoyancy: buoyancy(), particleQuery: queryParticle(), particles: { active: particles, samples: particleSamples, droppedSamples: droppedParticleSamples }, events: { counts: eventCounts, sourcePhysicsStep: lastEventStep }, foamMaterial: foamMaterial(), renderer: app.renderer.inspect(), trace: { retainedSteps: completedSteps.length, droppedSteps, oldestStep: completedSteps[0]?.physicsStep, latestStep: completedSteps.at(-1)?.physicsStep } });
  const exportTrace = () => ({ schemaVersion: 1, mode: 'ue-synchronous-buoyancy', capturedAt: new Date().toISOString(), retainedSteps: completedSteps.length, droppedSteps,
    crafts: crafts.map(c => ({ entity: c.entity, type: c.type, configuration: world.get(c.entity, WaterPontoonSet).unwrap() })),
    completedFrames, completedReceipt, errorCount, errors, steps: completedSteps, particleQuery: queryParticle(), particles: { samples: particleSamples, droppedSamples: droppedParticleSamples }, events: { counts: eventCounts, sourcePhysicsStep: lastEventStep }, foamMaterial: foamMaterial(), renderer: app.renderer.inspect() });
  const exportTraceJson = () => JSON.stringify(exportTrace(), jsonFacts, 2);
  node('trace-rows').addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.pontoonIndex === undefined) return;
    const config = world.get(craft().entity, WaterPontoonSet).unwrap();
    const enabledPontoons = config.enabledPontoons.length === 0 ? Array<number>(config.radiiM.length).fill(1) : Array.from(config.enabledPontoons);
    enabledPontoons[Number(input.dataset.pontoonIndex)] = input.checked ? 1 : 0;
    patch({ enabledPontoons });
  });
  node('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportTraceJson()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `water-r4-step-${lastTraceStep}.json`; link.click(); URL.revokeObjectURL(url);
  });
  const refresh = () => {
    const state = buoyancy(); const read = state.steps.find(value => value.entity === craft().entity)?.result;
    lastStep = read?.ok ? read.value : undefined;
    const d = lastStep?.dynamics;
    node('physics-step').textContent = `步 ${lastStep?.physicsStep ?? '--'} · 代 ${d?.generation ?? '--'}`;
    node('mass').textContent = `${fixed(d?.massKg)} kg`; node('com').textContent = vector(d?.localCenterOfMassM);
    node('velocity').textContent = `${fixed(d ? Math.hypot(...d.linearVelocityMps) : undefined)} m/s`;
    node('overlap-count').textContent = String(lastStep?.overlaps.current.length ?? '--');
    const collision = waterSceneSnapshot(world, craft().waterEntity)?.asset.geometrySnapshot?.collisionDescriptor;
    node('sensor-y').textContent = collision ? `${fixed(collision.minimumYM)} ~ ${fixed(collision.maximumYM)} m` : '--';
    node('total-force').textContent = `${fixed(lastStep?.pontoons.reduce((sum, p) => sum + p.buoyancyForceN[1], 0), 1)} N`;
    node('angular-torque').textContent = `${vector(lastStep?.angularDragTorqueNm)} N·m`;
    node('trace-state').textContent = `保留 ${completedSteps.length} 步 · 丢弃 ${droppedSteps} · 掩码 ${lastStep?.coefficientCache.enabledMask.toString(16) ?? '--'} / ${lastStep?.coefficientCache.hit ? '命中' : '首次'}`;
    const rows = node<HTMLTableSectionElement>('trace-rows'), pontoons = lastStep?.pontoons ?? [];
    while (rows.rows.length > pontoons.length) rows.deleteRow(-1);
    pontoons.forEach((p, index) => {
      let tr = rows.rows[index];
      if (!tr) {
        tr = rows.insertRow();
        const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.dataset.pontoonIndex = String(index); enabled.setAttribute('aria-label', `启用浮筒 ${index + 1}`);
        tr.insertCell().append(enabled);
        for (let cell = 0; cell < 10; cell++) tr.insertCell();
      }
      tr.querySelector<HTMLInputElement>('input')!.checked = p.enabled;
      const selectedBody = crafts.find(c => waterSceneSnapshot(world, c.waterEntity)?.guid === p.selectedBodyGuid)?.type;
      const values = [p.pontoonId, selectedBody ? bodyLabels[selectedBody] : '--', fixed(p.immersionM), fixed(p.volumeM3, 3), fixed(p.coefficient, 4), fixed(p.dampingN, 1), fixed(p.preCapForceN, 1), fixed(p.postCapForceN, 1), fixed(p.buoyancyForceN[1], 1), p.result.ok ? p.inWater ? '水中' : '离水' : p.result.error.code];
      values.forEach((value, cell) => { tr!.cells[cell + 1]!.textContent = value; });
    });
    const refreshParticleReadout = () => {
      const diQuery = queryParticle(),
        di = diQuery?.result;
      world
        .set(queryMarker, Visibility, {
          state: diQuery ? VisibilityStateValue.visible : VisibilityStateValue.hidden,
        })
        .unwrap();
      if (diQuery) world.set(queryMarker, Transform, { pos: diQuery.request.positionM }).unwrap();
      node('di-generation').textContent = di?.ok
        ? `${bodyLabels[node<HTMLSelectElement>('di-body').value as Body]} / ${di.value.bodyGeneration}`
        : '--';
      node('di-time').textContent = `${fixed(di?.ok ? di.value.timeSeconds : undefined, 3)} s`;
      node('di-system-position').textContent = vector(diQuery?.systemTick.systemPositionM);
      node('di-position').textContent = vector(diQuery?.request.positionM);
      node('di-source-tick').textContent = String(
        di?.ok ? (di.value.systemDepth?.sourceTick ?? '--') : '--',
      );
      node('di-flags').textContent = di?.ok ? `0x${di.value.queryFlags.toString(16)}` : '--';
      node('di-height').textContent =
        `${fixed(di?.ok ? di.value.surfacePositionM[1] : undefined, 3)} m`;
      node('di-depth-value').textContent =
        `${fixed(di?.ok ? di.value.waterDepthM : undefined, 3)} m / ${di?.ok ? (di.value.depthSource === 'particle' ? '逐粒子' : di.value.depthSource === 'system-instance' ? '系统实例' : '关闭') : '--'}`;
      node('di-result').textContent =
        di === undefined
          ? '等待接纳'
          : di.ok
            ? di.value.valid
              ? 'CPU 查询有效'
              : '无效默认值'
            : di.error.code;
      node('particle-count').textContent = `${particles.length} / 64`;
      node('event-count').textContent =
        `${eventCounts.entered} / ${eventCounts.exited} / ${eventCounts.wake}`;
      node('event-step').textContent = String(lastEventStep ?? '--');
    };
    refreshParticleReadout();

    const refreshFoamReadout = () => {
      const inspection = app.renderer.inspect();
      const ocean = crafts.find((c) => c.type === 'ocean')!;
      const foam = inspection.meshMaterialBindings
        .find((binding) => binding.entityKey === ocean.waterEntity)
        ?.waterFoamInputs?.find((value) => value !== undefined);
      node('foam-static').textContent = foam
        ? `${foam.inputs.staticTexture ? '已绑定' : '缺失'} / ${foam.inputs.staticNormalTexture ? '已绑定' : '缺失'}`
        : '待绘制';
      node('foam-volume').textContent = foam?.inputs.volumeNoiseTexture ? '已绑定' : '待绘制';
      node('foam-rt').textContent = foam
        ? `${foam.foamRt.initialized ? '已初始化' : '未初始化'} · 图 ${foam.foamRt.graphGeneration}`
        : '待绘制';
      node('foam-consumer').textContent = foam
        ? `${foam.inputs.materialSwitches.waterOceanFoam ? '开启' : '关闭'} / ${foam.foamRtConsumer ? '已绑定' : '未绑定'}`
        : '待绘制';
      node('foam-producer').textContent = foam
        ? `${foam.inputs.fluidRt === undefined ? '未启用' : '已绑定'} / ${foam.bakedSource.status === 'disabled' ? '未启用' : '来源未暴露'}`
        : '--';
      const calibration = foamMaterial();
      node('foam-bias').textContent =
        `${calibration.values.foamHeightBias} / ${calibration.values.foamScatterBias}`;
    };
    refreshFoamReadout();

    node('frame-count').textContent = `${completedFrames} 帧`;
    node('status').textContent = `${bodyLabels[selected]} · ${craft().count} 浮筒 · ${completedReceipt ? `完成帧 ${completedReceipt.frameId}` : '等待 GPU 完成'}${errorCount ? ` · ${errorCount} 个错误` : ''}${read?.ok === false ? ` · ${read.error.code}` : ''}`;
  };
  let lastRefresh = 0; const completionTimes: number[] = [];
  app.renderer.subscribe(event => {
    if (event.kind === 'error') recordError(event.error);
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then(result => {
      if (!result.ok) { recordError(result.error); return; }
      if (event.receipt.presentation !== 'ready') return;
      completedFrames++;
      completedReceipt = { frameId: event.receipt.frameId, deviceGeneration: event.receipt.deviceGeneration, ...(event.receipt.graphGeneration === undefined ? {} : { graphGeneration: event.receipt.graphGeneration }) };
      const now = performance.now(); completionTimes.push(now); while ((completionTimes[0] ?? now) < now - 1000) completionTimes.shift();
      const span = now - (completionTimes[0] ?? now);
      if (now - lastRefresh > 200) { node('fps').textContent = span > 400 ? `${((completionTimes.length - 1) * 1000 / span).toFixed(1)} FPS` : '-- FPS'; node('render-state').textContent = '实时渲染'; refresh(); lastRefresh = now; }
    }).catch(recordError);
  });
  app.onError(recordError);
  Object.assign(window, { __waterR4: { app, world, assets, root, camera, queryMarker, crafts, errors, readState, exportTrace, exportTraceJson, setView,
    setCameraPose: (pose: { eye: Vector; target: Vector }) => {
      if (![...pose.eye, ...pose.target].every(Number.isFinite)) return err({ code: 'water-r4-camera-invalid' });
      eye = [...pose.eye]; target = [...pose.target]; selectedView = 'manual'; refreshView(); applyCamera(); return ok(undefined);
    } } });
  window.addEventListener('beforeunload', () => { void app.dispose(); });
  refreshCraftControls(); app.start().unwrap(); applyCamera();
}
void main().catch((error: unknown) => {
  Object.assign(window, { __waterR4StartupError: error });
  node('render-state').textContent = '启动失败';
  node('status').textContent = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  console.error(error);
});
