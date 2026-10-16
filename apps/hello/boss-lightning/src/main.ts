import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { createWorldContext, World, type EntityHandle } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { Context } from '@forgeax/engine-plugin';
import { Camera, type RenderWorldLease } from '@forgeax/engine-render';
import { GlobalTransform, Transform, scenePlugin } from '@forgeax/engine-scene';
import { type Handle, type MaterialAsset } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createVfxEffectContract,
  loadVfxGpuEffect,
  ParticleEffectInstance,
  ParticleEffectPlayer,
  type VfxEffectReflection,
  type VfxGpuEffectAsset,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
  observeStagePlan,
  validatedStagePlan,
} from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { BOSS_ATTACK_TARGET, createBossScene, type BossSceneMaterials } from './scene';

const EFFECT_GUID = '019e9c00-0000-7000-8000-000000000000';
const BOSS_BODY_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000003';
const BOSS_ACCENT_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000004';
const GROUND_WARNING_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000005';
const STRIKE_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000006';
const MOUTH_MATERIAL_GUID = '019e9c00-0000-7000-8000-000000000001';
const cameraEntities = new WeakMap<World, EntityHandle>();

export type BossLightningValues = {
  readonly intensity: number;
  readonly tint: readonly [number, number, number, number];
};

export function createBossLightningInstance(
  reflection: VfxEffectReflection,
): ParticleEffectInstance<BossLightningValues> {
  const contract = createVfxEffectContract<BossLightningValues>(reflection);
  return new ParticleEffectInstance(contract, {
    initialValues: { intensity: 1, tint: [0.2, 0.5, 1, 1] },
  });
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('boss-lightning: missing canvas');

const validationErrors: Array<{ code: string; hint: string; detail: unknown }> = [];
let cameraReady = false;
let cameraEntity = 0 as EntityHandle;

function cameraSource() {
  return {
    read(world: World) {
      const owner = cameraEntities.get(world) ?? cameraEntity;
      const transform = world.get(owner, Transform);
      const globalTransform = world.get(owner, GlobalTransform);
      const camera = world.get(owner, Camera);
      if (!transform.ok || !globalTransform.ok || !camera.ok) return undefined;
      cameraReady = true;
      // Keep VFX projection on the same ECS camera authority as the scene
      // renderer. The former fixed basis/lookAt path could diverge from the
      // camera Transform (and made particles appear detached from the boss).
      const cameraWorld = globalTransform.value.world;
      const view = mat4.invert(mat4.create(), cameraWorld);
      const projection = mat4.perspectiveReverseZ(
        mat4.create(),
        camera.value.fov,
        camera.value.aspect,
        camera.value.near,
        camera.value.far,
      );
      return {
        position: new Float32Array(transform.value.pos),
        right: new Float32Array(mat4.getRight(vec3.create(), cameraWorld)),
        up: new Float32Array(mat4.getUp(vec3.create(), cameraWorld)),
        viewProjection: mat4.multiply(mat4.create(), projection, view),
      };
    },
  };
}

function stageEvidence(
  effect: VfxGpuEffectAsset,
  falsifyMode: string | null,
  active: boolean,
) {
  const stages = effect.program.emitters.flatMap((emitter) => emitter.reflection.stages ?? []);
  const lastKnownGood = validatedStagePlan(stages, 1);
  const candidate = stageCandidatePlan(lastKnownGood, falsifyMode);
  const observation = observeStagePlan(
    candidate,
    falsifyMode?.startsWith('stage-') ? 2 : 1,
    lastKnownGood.ok ? lastKnownGood.value : undefined,
  );
  return {
    stageReadiness: observation.stageReadiness,
    stageOutput: active ? observation.stageOutput : 'empty',
    stageDependencies: lastKnownGood.ok
      ? lastKnownGood.value.stages.map((stage) => ({ id: stage.id, dependsOn: stage.dependsOn }))
      : [],
    stageDispatch: lastKnownGood.ok ? lastKnownGood.value.stages.map((stage) => stage.entryPoint) : [],
    lastKnownGoodStage: observation.lastKnownGoodStage,
  };
}

function stageCandidatePlan(
  lastKnownGood: ReturnType<typeof validatedStagePlan>,
  falsifyMode: string | null,
) {
  if (!lastKnownGood.ok || !falsifyMode?.startsWith('stage-')) return lastKnownGood;
  const source = lastKnownGood.value.stages.map((stage) => ({
    ...stage,
    ...(falsifyMode === 'stage-cycle' ? { dependsOn: [stage.id] } : {}),
    ...(falsifyMode === 'stage-hazard'
      ? { resources: [...stage.resources, ...(stage.resources[0] === undefined ? [] : [stage.resources[0]])] }
      : {}),
    ...(falsifyMode === 'stage-budget' ? { iterationBudget: 65 } : {}),
  }));
  return validatedStagePlan(source, 2);
}

async function loadMaterial(
  world: World,
  assets: AssetRegistry,
  guid: string,
): Promise<Handle<'MaterialAsset', 'shared'>> {
  const loaded = await assets.loadByGuid<MaterialAsset>(assets.parseGuid(guid));
  if (!loaded.ok) throw new Error(`boss-lightning: material load failed ${guid}: ${loaded.error.hint}`);
  return world.allocSharedRef('MaterialAsset', loaded.value);
}

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const searchParams = new URLSearchParams(globalThis.location.search);
  const falsifyMode = searchParams.get('boss-lightning-falsify');
  const m35Mode = searchParams.get('boss-lightning-m35') === '1';
  if (runtimeBinding === undefined) {
    throw new Error('boss-lightning: virtual bundler did not provide a runtime asset binding');
  }
  const host = createVfxRuntimeHost({
    camera: cameraSource(),
    ...(m35Mode ? { maxQueuedTicks: 1 } : {}),
    providers: [
      createCameraProvider({ available: () => cameraReady }),
      createSceneDepthProvider({ available: () => cameraReady && falsifyMode !== 'missing-depth' }),
    ],
  });
  // Let App own renderer construction so optional RHI capture can attach at
  // the backend seam before this custom RenderFeature creates GPU resources.
  // The old assemble path constructed the renderer first, which made
  // `window.__forgeax.captureFrame` permanently unavailable for this demo.
  const appResult = await createApp(
    target,
    {
      features:
        falsifyMode === 'disable-vfx' || falsifyMode === 'billboard-fallback'
          ? []
          : [host.feature],
      plugins: [scenePlugin()],
      assetRuntimeBinding: runtimeBinding,
    },
    forgeaxBundlerAdapter(),
  );
  if (!appResult.ok) throw new Error(`boss-lightning: app assembly failed: ${String(appResult.error)}`);
  const renderer = appResult.value.renderer;
  const assets = appResult.value.assets;
  if (assets === undefined) throw new Error('boss-lightning: App did not expose its AssetRegistry');
  const world = appResult.value.world;
  renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    const error = event.error;
    if (validationErrors.length >= 32) return;
    validationErrors.push({
      code: error.code,
      hint: error.hint,
      detail: 'detail' in error ? JSON.parse(JSON.stringify(error.detail, (_key, value) =>
        value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value,
      )) : undefined,
    });
  });
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) throw new Error(`boss-lightning: VFX host attach failed: ${attached.error.hint}`);

  const [body, accent, mouth, groundWarning, strike] = await Promise.all([
    loadMaterial(world, assets, BOSS_BODY_MATERIAL_GUID),
    loadMaterial(world, assets, BOSS_ACCENT_MATERIAL_GUID),
    loadMaterial(world, assets, MOUTH_MATERIAL_GUID),
    loadMaterial(world, assets, GROUND_WARNING_MATERIAL_GUID),
    loadMaterial(world, assets, STRIKE_MATERIAL_GUID),
  ]);
  const materials: BossSceneMaterials = { body, accent, mouth, groundWarning, strike };
  const scene = createBossScene(world, materials);
  cameraEntity = scene.camera;
  cameraEntities.set(world, cameraEntity);
  const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID);
  if (!loaded.ok) throw new Error(`boss-lightning: GPU effect load failed: ${String(loaded.error)}`);
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  world.addComponent(scene.player, {
    component: ParticleEffectPlayer,
    data: {
      effect,
      playing: falsifyMode !== 'emitter-zero' && falsifyMode !== 'material-empty',
      seed: 42,
      timeScale: 1,
    },
  }).unwrap();
  let m35World: World | undefined;
  let m35Player: EntityHandle | undefined;
  let m35Context: Context | undefined;
  let mainLease: RenderWorldLease | undefined;
  let m35Lease: RenderWorldLease | undefined;
  if (m35Mode) {
    const attachedMainRendererWorld = renderer.attach(world);
    if (!attachedMainRendererWorld.ok) throw attachedMainRendererWorld.error;
    mainLease = attachedMainRendererWorld.value;
    m35World = new World();
    const m35Camera = m35World
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 7.5] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: target.width / target.height, near: 0.1, far: 100 },
        },
      )
      .unwrap();
    cameraEntities.set(m35World, m35Camera);
    const m35Effect = m35World.allocSharedRef('ParticleEffectAsset', loaded.value);
    m35Player = m35World
      .spawn(
        { component: Transform, data: { pos: [0, -0.2, 0] } },
        {
          component: ParticleEffectPlayer,
          data: { effect: m35Effect, playing: true, seed: 43, timeScale: 1 },
        },
      )
      .unwrap();
    m35Context = await createWorldContext(m35World, [scenePlugin()]);
    const attachedM35RendererWorld = renderer.attach(m35World);
    if (!attachedM35RendererWorld.ok) throw attachedM35RendererWorld.error;
    m35Lease = attachedM35RendererWorld.value;
    const attachedM35HostWorld = await host.attachWorld({ world: m35World, assets });
    if (!attachedM35HostWorld.ok) {
      throw new Error(`boss-lightning: M35 VFX host attach failed: ${attachedM35HostWorld.error.hint}`);
    }
  }
  appResult.value.start();
  let nextImpactSequence = 1;
  const m35 =
    m35World === undefined || m35Player === undefined
      ? undefined
      : {
          world: m35World,
          player: m35Player,
          pause: () => appResult.value.pause(),
          resume: () => appResult.value.resume(),
          inspect: () => ({ affected: host.inspect(m35World), sibling: host.inspect(world) }),
          control: () => host.acquireControl(m35World),
          step: () => {
            const siblingUpdate = world.update(1 / 60);
            const affectedUpdate = m35World.update(1 / 60);
            if (!siblingUpdate.ok || !affectedUpdate.ok) {
              return { siblingUpdate, affectedUpdate, draw: undefined };
            }
            if (mainLease === undefined || m35Lease === undefined) {
              throw new Error('boss-lightning: M35 render leases unavailable');
            }
            const draw = renderer.draw({
              leases: [mainLease, m35Lease],
              camera: { lease: mainLease },
              environment: { lease: mainLease },
            });
            return { siblingUpdate, affectedUpdate, draw };
          },
          cleanup: async () => {
            const stopped = appResult.value.stop();
            await m35Context?.fiber.dispose();
            await appResult.value.dispose();
            const detachAffected = await host.detachWorld({ world: m35World });
            const detachAffectedAgain = await host.detachWorld({ world: m35World });
            const detachSibling = await host.detachWorld({ world });
            const detachSiblingAgain = await host.detachWorld({ world });
            m35Lease?.dispose();
            mainLease?.dispose();
            await renderer.dispose();
            await renderer.dispose();
            return {
              stopped,
              detachAffected,
              detachAffectedAgain,
              detachSibling,
              detachSiblingAgain,
              rendererDisposedTwice: true,
            };
          },
        };
  Object.assign(globalThis, {
    __forgeaxBossLightning: {
      app: appResult.value,
      world,
      player: scene.player,
      renderer,
      feature: host.feature,
      effectAsset: loaded.value,
      scene,
      status: () => {
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const eventCounters = runtime.eventCounters(scene.player);
        const stage = stageEvidence(loaded.value, falsifyMode, runtime.hasPlayer(scene.player));
        return {
          queuedIntents: runtime.snapshot().length,
          renderGeneration: runtime.renderGeneration,
          diagnostics: runtime.diagnostics(),
          hasPlayer: runtime.hasPlayer(scene.player),
          renderFeatureEnabled:
            falsifyMode !== 'disable-vfx' && falsifyMode !== 'billboard-fallback',
          eventCounters,
          gpuLocalEvents: eventCounters.consumed > 0,
          eventQueueCleared: eventCounters.queued === 0,
          dataInterfaceSnapshot: host.dataInterfaces.snapshot,
          ...stage,
        };
      },
      inspect: () => host.inspect(world),
      visualEvidence: () => {
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        const status = runtime.eventCounters(scene.player);
        const committed = runtime.lastCommitted(scene.player);
        const stage = stageEvidence(loaded.value, falsifyMode, runtime.hasPlayer(scene.player));
        const renderers = loaded.value.program.emitters.flatMap((emitter) =>
          emitter.renderers.map((renderer) => renderer.kind),
        );
        return {
          expectations: [
            {
              id: 'advanced-renderers-visible',
              observed: `renderers=${renderers.join(',')}`,
              verdict: renderers.includes('ribbon') && renderers.includes('trail') && renderers.includes('beam') ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'live-patch-continuity',
              observed: `generation=${committed?.instanceGeneration ?? 0}`,
              verdict: committed !== undefined && committed.instanceGeneration > 0 ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'event-sub-emitter-visible',
              observed: `consumed=${status.consumed} fanOut=${status.fanOut}`,
              verdict: status.consumed > 0 ? 'pass' : 'fail',
              confidence: 1,
            },
            {
              id: 'hmr-last-known-good-visible',
              observed: `stage=${stage.stageOutput} lkg=${stage.lastKnownGoodStage !== undefined}`,
              verdict:
                stage.stageOutput !== 'empty' && stage.lastKnownGoodStage !== undefined
                  ? 'pass'
                  : 'fail',
              confidence: 1,
            },
          ],
        };
      },
      publicApi: {
        create: createBossLightningInstance,
        inspect: () => host.inspect(world),
        recover: () => renderer.recover(),
        ...(m35 === undefined
          ? {}
          : {
              replay: () => {
                const control = host.acquireControl(m35.world);
                return control.ok ? control.value.replay({ player: m35.player }) : control;
              },
            }),
      },
      m35,
      m11: {
        holdStaleInstance: () => {
          const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
          const instance = runtime.getInstance(scene.player);
          Object.assign(globalThis, { __forgeaxBossLightningM11Stale: instance });
          return instance === undefined ? { ok: false, reason: 'instance-unavailable' } : { ok: true };
        },
        patchStaleInstance: () => {
          const instance = (globalThis as typeof globalThis & {
            __forgeaxBossLightningM11Stale?: ParticleEffectInstance;
          }).__forgeaxBossLightningM11Stale;
          return instance?.patch({ intensity: 1.75 });
        },
        patchCurrentInstance: () => {
          const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
          return runtime.getInstance(scene.player)?.patch({ intensity: 1.5 });
        },
      },
      submitImpact: () => {
        const control = host.acquireControl(world);
        if (!control.ok) return control;
        const patch =
          falsifyMode === 'freeze-generation'
            ? undefined
            : control.value.patchPlayerParameters({
                player: scene.player,
                values: { intensity: 1.25 },
              });
        if (patch !== undefined && !patch.ok) return patch;
        const submitted = control.value.submitChannel({
          player: scene.player,
          channel: 'impact',
          payload: { position: [...BOSS_ATTACK_TARGET], strength: 1 },
          sequence: nextImpactSequence++,
        });
        if (!submitted.ok) return submitted;
        return { patch, submitted };
      },
      validationErrors,
      get cameraReady() {
        return cameraReady;
      },
    },
  });
}

void bootstrap(canvas).catch((error: unknown) => {
  console.error('[boss-lightning] bootstrap failed', error);
});
