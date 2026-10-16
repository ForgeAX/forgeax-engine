import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
import { configureRuntimeAssetCatalog, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app';
import { FixedUpdate, FixedTime, World, type EntityHandle } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_CYLINDER, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, PointLight, Skylight } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { GlobalTransform, Transform, scenePlugin } from '@forgeax/engine-scene';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  type VfxValueMap,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { CinderFallCast, type CinderFallPhase } from './cast.js';

const EFFECT_GUID = 'c1de0000-0000-7000-8000-000000000000';
const STANDARD_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000001';
const ADDITIVE_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000002';
const ALPHA_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000003';
const PLATFORM_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000004';
const SCORCH_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000005';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLElement>('#status');
if (canvas === null || status === null) throw new Error('hello-cinder-fall: missing canvas/status');
const targetCanvas = canvas;
const targetStatus = status;

const cast = new CinderFallCast({
  seed: 0xc1de3,
  origin: [0, 8, 0],
  target: [0, 0, 0],
  impactAt: 1.5,
});
const cameraEntities = new WeakMap<World, EntityHandle>();
// Keep the full cast in frame while giving the impact layers enough screen
// area to read as a deliberate effect rather than isolated red pixels. The
// tighter lens still contains the 8-unit fall but makes the meteor and burn
// footprint legible in the same checkpoint images.
const CAMERA_POSITION = [0, 4.9, 10.0] as const;
const CAMERA_TARGET = [0, 3.8, 0] as const;
const CAMERA_QUAT = quat.fromLookAt(quat.create(), CAMERA_POSITION, CAMERA_TARGET, [0, 1, 0]);
const METEOR_QUAT = quat.fromAxisAngle(quat.create(), [0, 0, 1], -0.24);

function cameraSource() {
  return {
    read(world: World) {
      const entity = cameraEntities.get(world);
      if (entity === undefined) return undefined;
      const transform = world.get(entity, Transform);
      const globalTransform = world.get(entity, GlobalTransform);
      const camera = world.get(entity, Camera);
      if (!transform.ok || !globalTransform.ok || !camera.ok) return undefined;
      // VFX must consume the same camera world/projection as Render. The
      // previous lookAt target was an app-local second camera and put the
      // particle layer on a different vertical projection than the ECS
      // scene. GlobalTransform.world is the propagated camera authority; derive
      // view = inverse(world), then compose the same perspective matrix used
      // by the renderer. Basis vectors are normalized so camera scale cannot
      // stretch billboards.
      const cameraWorld = globalTransform.value.world;
      const view = mat4.invert(mat4.create(), cameraWorld);
      const projection = mat4.perspectiveReverseZ(
        mat4.create(),
        camera.value.fov,
        camera.value.aspect,
        camera.value.near,
        camera.value.far,
      );
      const viewProjection = mat4.multiply(mat4.create(), projection, view);
      return {
        position: new Float32Array(transform.value.pos),
        right: new Float32Array(mat4.getRight(vec3.create(), cameraWorld)),
        up: new Float32Array(mat4.getUp(vec3.create(), cameraWorld)),
        viewProjection,
      };
    },
  };
}

async function loadMaterial(world: World, assets: AssetRegistry, guid: string) {
  const loaded = await assets.loadByGuid<MaterialAsset>(assets.parseGuid(guid));
  if (!loaded.ok) throw new Error(`hello-cinder-fall: material ${guid} failed: ${String(loaded.error)}`);
  return world.allocSharedRef('MaterialAsset', loaded.value);
}

function phaseEffects(phase: CinderFallPhase, elapsed: number): readonly string[] {
  switch (phase) {
    case 'release':
    case 'mid-travel':
      return ['cinder.travel'];
    case 'impact':
      return ['cinder.impact', 'cinder.burn'];
    case 'burn':
    case 'fade':
      // Keep the short impact burst alive for its authored 0.8 s lifetime so
      // the +0.35 s checkpoint still reads as an expanding hit. It naturally
      // expires before the long burn footprint becomes the sole layer.
      return elapsed < 2.3 ? ['cinder.impact', 'cinder.burn'] : ['cinder.burn'];
    case 'complete':
      return [];
  }
}

async function bootstrap(): Promise<void> {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });
  const camera = world.spawn(
    { component: Transform, data: { pos: CAMERA_POSITION, quat: CAMERA_QUAT } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 3,
        aspect: targetCanvas.width / targetCanvas.height,
        near: 0.1,
        far: 100,
        clearColor: [0.012, 0.018, 0.032, 1],
      },
    },
  ).unwrap();
  cameraEntities.set(world, camera);
  const host = createVfxRuntimeHost({
    camera: cameraSource(),
    // Camera/depth/noise are supplied by the renderer's prepared generation
    // resources. Keeping the provider list closed and empty makes a missing
    // explicit provider fail closed while the feature consumes those real
    // renderer-owned resources at plan time.
    providers: [],
  });
  const constructed = await constructRuntimeRendererHost(targetCanvas, { features: [host.feature] }, forgeaxBundlerAdapter());
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const leaseResult = renderer.attach(world);
  if (!leaseResult.ok) throw leaseResult.error;
  const lease = leaseResult.value;
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) throw new Error(`hello-cinder-fall: VFX host attach failed: ${attached.error.hint}`);

  const [standard, additive, alpha, platformMaterial, scorchMaterial] = await Promise.all([
    loadMaterial(world, assets, STANDARD_MATERIAL_GUID),
    loadMaterial(world, assets, ADDITIVE_MATERIAL_GUID),
    loadMaterial(world, assets, ALPHA_MATERIAL_GUID),
    loadMaterial(world, assets, PLATFORM_MATERIAL_GUID),
    loadMaterial(world, assets, SCORCH_MATERIAL_GUID),
  ]);
  const meteor = world.spawn(
    { component: Transform, data: { pos: [0, 8, 0], quat: METEOR_QUAT, scale: [0.5, 0.68, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [standard] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, -0.12, 0], scale: [4.5, 0.1, 4.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [platformMaterial] } },
  ).unwrap();
  // A single ordinary scene-mesh proxy anchors the long-lived burn. It is
  // intentionally separate from the particle layer: no decal or second VFX
  // path is needed for a flat, world-aligned scorch mark.
  const scorch = world.spawn(
    { component: Transform, data: { pos: [0, -100, 0], scale: [0.35, 0.025, 0.35] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CYLINDER } },
    { component: MeshRenderer, data: { materials: [scorchMaterial] } },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [1, 0.68, 0.42], intensity: 2.2, castShadow: true },
  }).unwrap();
  // A small warm ambient floor keeps the standard scene mesh from collapsing
  // to a flat red silhouette while leaving the point light as the impact cue.
  world.spawn({
    component: Skylight,
    data: { color: [0.06, 0.08, 0.14], intensity: 0.72 },
  }).unwrap();
  // One warm, bounded light follows the gameplay meteor. This keeps the
  // authored mesh and GPU wake in the same lighting story without adding a
  // second presentation system or an unbounded bloom source.
  const meteorLight = world
    .spawn(
      { component: Transform, data: { pos: [0, 8, 0] } },
      {
        component: PointLight,
        data: { color: [1, 0.34, 0.08], intensity: 9, range: 4.5 },
      },
    )
    .unwrap();

  const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID);
  if (!loaded.ok) throw new Error(`hello-cinder-fall: GPU effect failed: ${String(loaded.error)}`);
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  const player = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: ParticleEffectPlayer, data: { effect, playing: true, seed: cast.snapshot().seed, timeScale: 1 } },
  ).unwrap();
  const controlResult = host.acquireControl(world);
  if (!controlResult.ok) throw new Error(`hello-cinder-fall: control failed: ${controlResult.error.hint}`);
  const control = controlResult.value;
  let initialParametersPatched = false;
  let impactChannelSubmitted = false;
  const setPhase = (phase: CinderFallPhase): void => {
    const snapshot = cast.snapshot();
    const active = new Set(phaseEffects(phase, snapshot.elapsed));
    for (const emitter of loaded.value.program.emitters) {
      const result = control.setEmitterSessionEnabled({ player, emitterId: emitter.id, enabled: active.has(emitter.id) });
      if (!result.ok) throw new Error(`hello-cinder-fall: phase control failed: ${result.error.hint}`);
    }
    const amount = Math.min(1, snapshot.elapsed / 1.5);
    // The scene mesh is the travel actor, not the impact actor. Retiring it at
    // the impact boundary leaves the GPU burst and its debris readable instead
    // of hiding the ring behind a stationary sphere.
    const meteorVisible = phase === 'release' || phase === 'mid-travel';
    const meteorPosition: [number, number, number] = meteorVisible
      ? [0, 0.68 + 7.32 * (1 - amount), 0]
      : [0, -100, 0];
    const transform = world.get(meteor, Transform);
    if (transform.ok) world.set(meteor, Transform, { ...transform.value, pos: meteorPosition }).unwrap();
    const lightTransform = world.get(meteorLight, Transform);
    if (lightTransform.ok) {
      world.set(meteorLight, Transform, { ...lightTransform.value, pos: meteorVisible ? meteorPosition : [0, 0.05, 0] }).unwrap();
    }
    const light = world.get(meteorLight, PointLight);
    if (light.ok) {
      const lightIntensity =
          phase === 'impact' ? 18 : phase === 'burn' ? 0.18 : phase === 'fade' ? 0.05 : phase === 'complete' ? 0 : 7;
      world.set(meteorLight, PointLight, { ...light.value, intensity: lightIntensity }).unwrap();
    }
    const scorchVisible = phase !== 'release' && phase !== 'mid-travel' && phase !== 'complete';
    const scorchTransform = world.get(scorch, Transform);
    if (scorchTransform.ok) {
      const scorchScale =
        phase === 'impact'
          ? Math.min(0.72, 0.42 + Math.max(0, snapshot.elapsed - 1.5) * 0.6)
          : phase === 'burn'
            ? 0.92
            : phase === 'fade'
              ? 0.96
              : 0;
      world.set(scorch, Transform, {
        ...scorchTransform.value,
        pos: scorchVisible ? [0, -0.058, 0] : [0, -100, 0],
        scale: [scorchScale, 0.012, scorchScale],
      }).unwrap();
    }
    if (snapshot.impactCount > 0 && !impactChannelSubmitted) {
      const anchor = snapshot.impactAnchor ?? cast.target;
      const patched = control.patchPlayerParameters({
        player,
        values: { targetPosition: anchor },
      });
      if (!patched.ok) throw new Error(`hello-cinder-fall: impact parameters failed: ${patched.error.hint}`);
      const submitted = control.submitChannel({
        player,
        channel: 'impact',
        payload: { position: [0, 0, 0], strength: 1 },
        sequence: 1,
      });
      if (!submitted.ok) throw new Error(`hello-cinder-fall: impact channel failed: ${submitted.error.hint}`);
      impactChannelSubmitted = true;
    }
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    targetStatus.textContent = JSON.stringify({ ...snapshot, renderer: 'engine.vfx-render', gpu: runtime.inspectPlayers() }, null, 2);
  };
  world.addSystem(FixedUpdate, {
    name: 'cinder-fall-gameplay',
    queries: [],
    fn: (world) => {
      if (!initialParametersPatched) {
        const patched = control.patchPlayerParameters({
          player,
          values: { intensity: 1, targetPosition: cast.target },
        });
        if (!patched.ok) throw new Error(`hello-cinder-fall: initial parameters failed: ${patched.error.hint}`);
        initialParametersPatched = true;
      }
      setPhase(cast.advanceFixed(world.getResource(FixedTime).delta).phase);
    },
  }).unwrap();
  const platform = createBrowserPlatform(targetCanvas).unwrap();
  const appResult = await createApp({ platform,  renderer, assets, world, plugins: [{ name: 'browser-platform', apply(ctx) { ctx.effect(() => () => platform.dispose()); } }, scenePlugin()] });
  if (!appResult.ok) throw new Error(`hello-cinder-fall: app assembly failed: ${appResult.error.hint}`);
  const app = appResult.value;
  app.start();
  setPhase(cast.snapshot().phase);
  const dispose = async (): Promise<void> => {
    app.stop();
    await app.dispose();
    await host.detachWorld({ world });
    lease.dispose();
    await renderer.dispose();
  };
  const replay = (): unknown => {
    const result = control.replay({ player });
    if (result.ok) {
      cast.replay();
      impactChannelSubmitted = false;
      setPhase('release');
    }
    return result;
  };
  const step = async (frames = 1): Promise<unknown> => {
    if (!Number.isInteger(frames) || frames < 1 || frames > 600) {
      return { ok: false, error: { code: 'cinder-step-invalid', hint: 'frames must be 1..600' } };
    }
    app.pause();
    for (let index = 0; index < frames; index += 1) {
      let stepped = app.stepFrame(1 / 60);
      for (let retry = 0; !stepped.ok && retry < 100; retry += 1) {
        if (stepped.error.code !== 'app-frame-step-invalid') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
        stepped = app.stepFrame(1 / 60);
      }
      if (!stepped.ok) {
        return {
          ok: false,
          error: {
            name: stepped.error.name,
            code: stepped.error.code,
            hint: stepped.error.hint,
            ...('detail' in stepped.error ? { detail: stepped.error.detail } : {}),
            message: String(stepped.error),
          },
        };
      }
      // The App's one-credit frame receipt settles asynchronously after the
      // renderer records the frame. Yield before asking for the next credit;
      // callers still use the same public App.stepFrame path.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { ok: true, frames, status: { snapshot: cast.snapshot(), inspect: host.inspect(world) } };
  };
  Object.assign(globalThis, {
    __forgeaxCinderFall: {
      app,
      world,
      renderer,
      feature: host.feature,
      player,
      effectAsset: loaded.value,
      cast,
      materials: { standard, additive, alpha },
      inspect: () => host.inspect(world),
      status: () => ({ snapshot: cast.snapshot(), inspect: host.inspect(world) }),
      replay,
      step,
      patchParameters: (values: Partial<VfxValueMap>) =>
        control.patchPlayerParameters({ player, values }),
      submitChannel: (input: { channel: string; payload: { position: [number, number, number]; strength: number }; sequence: number }) =>
        control.submitChannel({ player, ...input }),
      dispose,
    },
  });
}

void bootstrap().catch((error: unknown) => {
  targetStatus.textContent = String(error instanceof Error ? error.stack ?? error.message : error);
  console.error('[hello-cinder-fall] bootstrap failed', error);
});
