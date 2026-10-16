import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { subscribeBrowserFrameSubmitted } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, type FrameReceipt } from '@forgeax/engine-render';
import { GlobalTransform, Transform, propagateTransforms, scenePlugin } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { loadVfxGpuEffect, ParticleEffectPlayer, createParticleEffectInstance, createVfxEffectContract,
  VFX_GPU_RUNTIME_RESOURCE_KEY, type VfxGpuRuntime } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { sdfGuid } from './sdf-guids';
import cases from './sdf-cases.json';
import { replaySdfEvidence } from './sdf-evidence';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null || runtimeBinding === undefined) throw new Error('SDF fixture host unavailable');
const query = new URLSearchParams(location.search);
const collision = query.get('collision') !== '0';
const recoveryProbe = query.get('recovery') === '1';
let signalLoss: (() => void) | undefined;
const scenario = cases.find(item => item.id === (query.get('case') ?? 'default'));
if (scenario === undefined) throw new Error('Unknown SDF case');
let cameraEntity = 0 as EntityHandle;
const vfx = createVfxRuntimeHost({
  camera: { read(world) {
    const transform = world.get(cameraEntity, GlobalTransform);
    const camera = world.get(cameraEntity, Camera);
    if (!transform.ok || !camera.ok) return undefined;
    const matrix = transform.value.world;
    return {
      position: new Float32Array([matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0]),
      right: mat4.getRight(vec3.create(), matrix), up: mat4.getUp(vec3.create(), matrix),
      viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(),
        camera.value.fov, camera.value.aspect, camera.value.near, camera.value.far),
        mat4.invert(mat4.create(), matrix)),
    };
  } },
  sceneSdf: { read: () => ({ origin: [-4, -4, -4], dimensions: [65, 65, 65],
    spacing: 0.125, maxDistance: 2, maxInstances: 16, maxFieldBytes: 1024 * 1024 }) },
});
const assembled = await createApp(canvas, {
  plugins: [scenePlugin()], features: [vfx.feature], assetRuntimeBinding: runtimeBinding,
  ...(recoveryProbe ? { rhiInstrumentation: {
    // Exercise the existing host-loss seam on real GPU generations. A projected
    // unexpected loss is a recovery fixture, not evidence of a driver reset.
    deviceLost: (device) => Promise.race([device.lost, new Promise<Awaited<typeof device.lost>>((resolve) => {
      signalLoss = () => resolve({ reason: 'unknown', message: 'SDF recovery fixture host loss' });
    })]),
  } } : {}),
}, forgeaxBundlerAdapter());
if (!assembled.ok) throw assembled.error;
const app = assembled.value;
const { world, renderer, assets } = app;
if (assets === undefined) throw new Error('SDF fixture asset host unavailable');
const errors: unknown[] = [];
renderer.subscribe(event => { if (event.kind === 'error') errors.push(JSON.parse(JSON.stringify(event.error))); });
(await vfx.attachWorld({ world, assets })).unwrap();
cameraEntity = world.spawn(
  { component: Transform, data: { pos: scenario.camera, quat: scenario.cameraTarget === undefined
    ? quat.create() : quat.fromLookAt(quat.create(), scenario.camera, scenario.cameraTarget, [0, 1, 0]) } },
  { component: Camera, data: { fov: Math.PI / 3, aspect: canvas.width / canvas.height,
    near: 0.1, far: 50, clearColor: [0.01, 0.02, 0.04, 1], tonemap: 0 } },
).unwrap();
const mesh = (await assets.loadByGuid<MeshAsset>(assets.parseGuid(sdfGuid(`mesh/${scenario.mesh}`)))).unwrap();
const material = (await assets.loadByGuid<MaterialAsset>(assets.parseGuid(sdfGuid('material/obstacle')))).unwrap();
const meshHandle = world.allocSharedRef('MeshAsset', mesh);
const materialHandle = world.allocSharedRef('MaterialAsset', material);
const obstacles = scenario.obstacles.map(transform => world.spawn(
  { component: Transform, data: transform },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
).unwrap());
const loaded = await loadVfxGpuEffect(assets, sdfGuid(collision ? 'effect/collision' : 'effect/free'));
if (!loaded.ok) throw loaded.error;
const player = world.spawn({ component: ParticleEffectPlayer, data: {
  effect: world.allocSharedRef('ParticleEffectAsset', loaded.value), playing: true, seed: 15, timeScale: 1,
} }).unwrap();
const emitter = loaded.value.program.emitters[0];
if (emitter === undefined) throw new Error('Cooked SDF fixture has no emitter');
world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY).attachInstance(player,
  createParticleEffectInstance(createVfxEffectContract(emitter.reflection.layout),
    { initialValues: scenario.parameters }));
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const lease = attached.value;
const probe = {
  app, world, renderer, assets, vfx, mesh, effect: loaded.value, obstacles, player, collision, scenario, errors,
  async step(ticks = 1) {
    for (let i = 0; i < ticks; i++) world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) throw drawn.error;
    const completed = await drawn.value.completed;
    if (!completed.ok) throw completed.error;
    return drawn.value;
  },
  inspect: () => ({ host: vfx.inspect(world), renderer: renderer.inspect(), errors: [...errors] }),
  loseDevice() {
    if (!recoveryProbe || signalLoss === undefined) throw new Error('Enable the explicit SDF recovery fixture');
    signalLoss();
  },
  moveWall() {
    const wall = obstacles[1];
    if (scenario.moveWall && wall !== undefined) world.set(wall, Transform, { pos: [2.1, 0.65, 0] }).unwrap();
  },
  revealWorld() {
    if (scenario.id !== 'off-frustum') throw new Error('Only the off-frustum fixture needs a reveal');
    world.set(cameraEntity, Transform, { pos: [0, 1, 8], quat: quat.create() }).unwrap();
  },
  async capture(ticks = 1) {
    for (let i = 0; i < ticks; i++) world.update(1 / 60).unwrap();
    if (app.rhiCapture === undefined) throw new Error('Enable FORGEAX_ENGINE_RHI_DEBUG=1 for capture');
    const previous = renderer.inspect().frame;
    let receipt: FrameReceipt | undefined;
    const release = subscribeBrowserFrameSubmitted(canvas, event => { receipt = event.receipt; });
    try {
      const captured = await app.rhiCapture.captureFrame();
      if (!captured.ok) return captured;
      if (receipt === undefined || receipt.frameId !== previous.frameId + 1 ||
        receipt.deviceGeneration !== previous.deviceGeneration) {
        throw new Error('SDF capture has no matching original frame receipt');
      }
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      return captured;
    } finally {
      release();
    }
  },
  async replayCapture(
    artifact: Awaited<ReturnType<NonNullable<typeof app.rhiCapture>['captureFrame']>>,
    offFrustumArtifact?: Awaited<ReturnType<NonNullable<typeof app.rhiCapture>['captureFrame']>>,
  ) {
    const captured = artifact.unwrap();
    if (app.rhiCapture === undefined) throw new Error('RHI capture capability lost');
    const uploaded = (await app.rhiCapture.upload(captured, { runId: `roi15-${scenario.id}-${collision ? 'collision' : 'free'}` })).unwrap();
    const offFrustum = offFrustumArtifact?.unwrap();
    const offFrustumUploaded = offFrustum === undefined ? undefined
      : (await app.rhiCapture.upload(offFrustum, { runId: `roi15-off-frustum-${collision ? 'collision' : 'free'}` })).unwrap();
    await probe.dispose();
    return { uploaded, replay: await replaySdfEvidence(captured.bytes, collision),
      ...(offFrustum === undefined ? {} : { offFrustumUploaded,
        offFrustumReplay: await replaySdfEvidence(offFrustum.bytes, collision) }) };

  },
  replayEvidence: replaySdfEvidence,
  async dispose() { app.stop(); lease.dispose(); await vfx.detachWorld({ world }); await app.dispose(); },
};
Object.assign(window, { __sdf: probe });
app.start().unwrap();
if (query.get('manual') === '1') app.pause().unwrap();
