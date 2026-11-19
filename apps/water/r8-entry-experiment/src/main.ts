import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { defineSystem, FixedUpdate, Time, Update } from '@forgeax/engine/ecs';
import { mat4, quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { PhysicsWorld } from '@forgeax/engine/physics';
import { PhysicsSimulation, PhysicsSync, PhysicsWorldResource } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  renderFeatureTextureSource,
  ScreenSpaceReflection,
  TONEMAP_ACES_FILMIC,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine/render';
import {
  WATER_SYSTEM_RESOURCE,
  WaterBuoyancy,
  WaterBuoyancyCompletion,
  WaterSceneReconcile,
} from '@forgeax/engine/runtime';
import { Transform, WaterBodyInstance, WaterZoneInstance } from '@forgeax/engine/scene';
import type {
  WaterAdvancedSimulationSource,
  WaterSimulationRecipeAsset,
} from '@forgeax/engine/types';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
import { type WaterSystem, waterOceanPatchOutputNames } from '@forgeax/engine/water';
import { createWaterCameraControls } from '../../camera-controls';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { presentationGuid } from '../../presentation-identity';
import {
  waterEntrySplashDefaults,
  waterEntrySplashParameters,
  waterEntryWaveImpulse,
} from '../../r8-integration-acceptance/assets/entry-splash';
import {
  sampleWaterEntryAttachment,
  type WaterEntryAttachment,
} from '../../r8-integration-acceptance/src/entry-attachment';
import { WATER_R8_PACKAGE } from '../../r8-integration-acceptance/src/identity';
import {
  ironBallPhysics,
  ironBallSubmerged,
  readIronBallParticipation,
  releaseIronBallWaterCollider,
  sampleIronBallEntry,
} from '../../r8-integration-acceptance/src/iron-ball';
import { runtimeForm, runtimeObjectFields } from '../../runtime-form';
import { arrangeWaterSettings, waterQualityControl } from '../../settings-panel';
import { waterStageNavigation } from '../../stage-catalog';
import { entryZone } from './entry-zone';
import '../../observatory.css';
import '../../settings-panel.css';

type Vector = [number, number, number];
async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene'),
    panel = document.querySelector<HTMLElement>('#controls-panel');
  if (!canvas || !panel) throw new Error('R8 requires its canvas and controls');
  let eye: Vector = [12, 5, 16],
    target: Vector = [0, 0, 0];
  let camera: EntityHandle | undefined;
  const vfx = createVfxRuntimeHost({
    camera: {
      read(world) {
        if (camera === undefined) return undefined;
        const pose = world.get(camera, Transform).unwrap(),
          lens = world.get(camera, Camera).unwrap();
        const position = new Float32Array(pose.pos);
        return {
          position,
          right: quat.transformVec3(vec3.create(), pose.quat, [1, 0, 0]),
          up: quat.transformVec3(vec3.create(), pose.quat, [0, 1, 0]),
          viewProjection: mat4.multiply(
            mat4.create(),
            mat4.perspectiveReverseZ(mat4.create(), lens.fov, lens.aspect, lens.near, lens.far),
            mat4.lookAt(mat4.create(), position, target, [0, 1, 0]),
          ),
        };
      },
    },
  });
  const app = (
    await createApp(
      canvas,
      {
        plugins: [physics3d],
        features: [vfx.feature],
        uiRoot: panel,
        pointerLockAllowed: () => false,
        // Full residual and independent FFT captures, including native query
        // regions and four in-flight receipts. Never omit a declared output.
        featureTextureReadbackBudgetBytes: 64 * 1024 * 1024 * 4,
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const { world, assets } = app;
  if (!assets) throw new Error('R8 requires the App asset owner');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, key));
  const zone = (await assets.load(guid('zone/coast'), 'water-zone')).unwrap();
  const bodyHandle = (await assets.load(guid('body/ocean'), 'water-body')).unwrap();
  assets.replace(zone, entryZone(assets.read(zone).unwrap())).unwrap();
  const farMaterialGuid = assets.read(zone).unwrap().farMaterialGuid;
  if (farMaterialGuid) (await assets.load(farMaterialGuid, 'material')).unwrap();
  const body = world
    .spawn(
      { component: Transform, data: {} },
      { component: WaterBodyInstance, data: { body: bodyHandle } },
    )
    .unwrap();
  world
    .spawn({ component: Transform, data: {} }, { component: WaterZoneInstance, data: { zone } })
    .unwrap();
  const recipe = (await assets.load(guid('fluid/coast-local'), 'water-simulation-recipe')).unwrap();
  const authored = assets.read(recipe).unwrap();
  if (authored.system !== 'water-advanced' || !authored.oceanPatchConfig)
    throw new Error('Expected native OceanPatch recipe');
  const noiseGuid = presentationGuid('texture/fft-phase');
  // The FFT producer consumes the admitted Texture revision, not a GUID alone.
  (await assets.load(noiseGuid, 'texture')).unwrap();
  assets
    .replace(recipe, {
      ...authored,
      configurationVersion: 2,
      textureGuids: [...authored.textureGuids, noiseGuid],
      oceanPatchConfig: {
        ...authored.oceanPatchConfig,
        domainLengthM: 64,
        centerXZ: [0, 0],
        fftResolution: 256,
        boundary: { kind: 'absorbing', widthM: 8, dampingPerSecond: 1.5 },
        visualNormalDetailFft: {
          noiseTextureGuid: noiseGuid,
          fftResolution: 128,
          domainLengthM: 64,
          normalDomainSizeM: 64,
          gravityMPerSec2: 9.81,
          phillipsAmplitude: 0.0003,
          windAngleDegrees: 45,
          windSpeedMPerSec: 8,
          windAlignment: 4,
          timeScale: 1,
          slosh: 0.5,
          normalRtFormat: 'rgba16float',
        },
      },
    } as WaterSimulationRecipeAsset)
    .unwrap();
  const material = (await assets.load(guid('material/r8-visual-water'), 'material')).unwrap();
  assets
    .update(bodyHandle, {
      surfaceMaterialGuid: guid('material/r8-visual-water'),
      lodMaterialGuid: guid('material/r8-visual-water'),
    })
    .unwrap();
  const names = waterOceanPatchOutputNames(guid('fluid/coast-local'), world.identity);
  const content = assets.read(material).unwrap();
  assets
    .update(material, {
      values: {
        ...content.values,
        NormalDetailTex: { source: renderFeatureTextureSource(names.visualNormal) },
        BakedWaterSimSize: 64,
        WPOWaveScale: 1,
        waterShallowGridTexture: { source: renderFeatureTextureSource(names.materialGrid) },
        waterShallowNormalTexture: { source: renderFeatureTextureSource(names.materialNormal) },
        waterShallowFoamTexture: { source: renderFeatureTextureSource(names.foam) },
        waterShallowMappingTexture: { source: renderFeatureTextureSource(names.mapping) },
      },
    })
    .unwrap();
  await dressWaterStage(app, [0, 0, 0], 1.1);
  camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: 0.86,
            aspect: canvas.clientWidth / canvas.clientHeight,
            near: 0.08,
            far: 2200,
          }),
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
      {
        component: ScreenSpaceReflection,
        data: { maxDistance: 100, thickness: 0.25, maxRoughness: 0.65, waterTemporal: 1 },
      },
    )
    .unwrap();
  const applyCamera = () => {
    if (camera === undefined) return;
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
  };
  const cameraControls = createWaterCameraControls({
    app,
    canvas,
    readPose: () => ({ eye, target }),
    speedMps: 6,
    writePose: (pose) => {
      eye = [...pose.eye];
      target = [...pose.target];
      applyCamera();
    },
  });
  const setView = (view: 'overview' | 'entry') => {
    cameraControls.reset();
    eye = view === 'entry' ? [6, 3, 8] : [12, 5, 16];
    target = [0, 0, 0];
    applyCamera();
  };
  const views = document.createElement('nav');
  views.className = 'experiment-views';
  views.setAttribute('aria-label', '实验视角');
  for (const [view, label] of [
    ['overview', '实验全景'],
    ['entry', '落水近景'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.view = view;
    button.textContent = label;
    button.addEventListener('click', () => setView(view));
    views.append(button);
  }
  panel.append(views);
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.4, -0.8, -0.3], color: [1, 0.96, 0.86], intensity: 2.5 },
    })
    .unwrap();
  const mesh = (await assets.load(guid('mesh/iron-ball'), 'mesh')).unwrap(),
    iron = (await assets.load(guid('material/iron-ball'), 'material')).unwrap();
  const effect = (await assets.load(guid('effect/iron-ball-entry'), 'particle-effect')).unwrap();
  (await vfx.attachWorld({ world, assets })).unwrap();
  const control = vfx.acquireControl(world).unwrap();
  // Paused admission prepares the same cooked program used by actual entries.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: ParticleEffectPlayer,
        data: { effect, playing: false, preparePipelines: true, seed: 731, timeScale: 1 },
      },
    )
    .unwrap();
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE),
    physics = () => world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const launch = {
    xM: 0,
    zM: 0,
    heightM: 7,
    speedXMps: 0,
    speedYMps: -1,
    radiusM: 0.6,
    densityKgPerM3: 7800,
  };
  const balls: {
    entity: EntityHandle;
    player?: EntityHandle;
    admitted: boolean;
    entry?: unknown;
    entryTime?: number;
    entrySurfaceYM?: number;
    entryLifetime?: number;
    attachment?: WaterEntryAttachment;
    submerged?: boolean;
    position: Vector;
    velocity: Vector;
    radiusM: number;
  }[] = [];
  const operations: unknown[] = [],
    errors: unknown[] = [];
  const launchForm = runtimeForm(
    panel,
    '球体与投放',
    ['radiusM', 'heightM', 'speedYMps', 'speedXMps'].map((key) => {
      const name = key as keyof typeof launch;
      const bounds = {
        radiusM: [0.25, 1.5, 0.05],
        heightM: [1.5, 20, 0.5],
        speedYMps: [-12, 0, 0.5],
        speedXMps: [-8, 8, 0.5],
      }[key] ?? [0, 20, 0.1];
      return {
        name,
        value: launch[name],
        read: () => launch[name],
        label:
          {
            radiusM: '铁球半径',
            heightM: '投放高度',
            speedYMps: '初始垂向速度',
            speedXMps: '水平速度',
          }[key] ?? key,
        unit: key.endsWith('Mps') ? 'm/s' : 'm',
        min: bounds[0] ?? 0,
        max: bounds[1] ?? 20,
        step: bounds[2] ?? 0.1,
        slider: true,
        set: (value: unknown) => {
          const next = Number(value);
          if (!Number.isFinite(next) || next < (bounds[0] ?? 0) || next > (bounds[1] ?? 20))
            throw new Error('Launch setting outside supported range');
          launch[name] = next;
        },
      };
    }),
  );
  const recipeForm = runtimeForm(
    panel,
    '完整波场配方',
    runtimeObjectFields(
      () => ({ ...assets.read(recipe).unwrap() }),
      (value) => {
        assets.replace(recipe, value as unknown as WaterSimulationRecipeAsset).unwrap();
      },
      {
        'oceanPatchConfig.collisions.kind': ['simple', 'distance-field'],
        'oceanPatchConfig.boundary.kind': ['periodic', 'absorbing'],
        'oceanPatchConfig.normalRtFormat': ['rgba16float', 'rgba32float'],
        'oceanPatchConfig.visualNormalDetailFft.normalRtFormat': ['rgba16float', 'rgba32float'],
      },
    ),
  );
  const retire = (ball: (typeof balls)[number]) => {
    if (ball.player !== undefined) {
      world.despawn(ball.player).unwrap();
      delete ball.player;
    }
    world.despawn(ball.entity).unwrap();
  };
  const fire = () => {
    if (balls.length >= 8) {
      const retired = balls.shift();
      if (retired) retire(retired);
    }
    const position: Vector = [launch.xM, launch.heightM, launch.zM],
      velocity: Vector = [launch.speedXMps, launch.speedYMps, 0],
      radiusM = launch.radiusM;
    const entity = world
      .spawn(
        {
          component: Transform,
          data: { pos: position, scale: [radiusM / 0.6, radiusM / 0.6, radiusM / 0.6] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [iron] } },
        { component: Visibility, data: {} },
        ...ironBallPhysics((4 / 3) * Math.PI * radiusM ** 3 * launch.densityKgPerM3, 0.6),
      )
      .unwrap();
    const player = world
      .spawn(
        { component: Transform, data: { pos: position } },
        {
          component: ParticleEffectPlayer,
          data: { effect, playing: false, preparePipelines: true, seed: 731, timeScale: 1 },
        },
      )
      .unwrap();
    balls.push({ entity, player, admitted: false, position, velocity, radiusM });
    operations.push({ kind: 'launch-requested', entity, position, velocity, radiusM });
  };
  const fireButton = document.createElement('button');
  fireButton.id = 'entry-drop';
  fireButton.textContent = '投放炮弹 · 原生落水';
  fireButton.addEventListener('click', fire);
  panel.append(fireButton);
  const reset = document.createElement('button');
  reset.textContent = '清空炮弹 / 重置波场';
  reset.addEventListener('click', () => {
    for (const ball of balls.splice(0)) retire(ball);
    water().oceanPatch()?.reset();
  });
  panel.append(reset);
  const pauseLabel = document.createElement('label'),
    pause = document.createElement('input');
  pause.type = 'checkbox';
  pause.id = 'entry-pause';
  pauseLabel.append(pause, '暂停局部残波与视觉 FFT');
  panel.append(pauseLabel);
  const queryLabel = document.createElement('label'),
    queryEnabled = document.createElement('input');
  queryEnabled.type = 'checkbox';
  queryEnabled.checked = true;
  queryEnabled.id = 'entry-query';
  queryLabel.append(queryEnabled, '将完成的残波读回接入原生查询');
  panel.append(queryLabel);
  const queryPolicy = { maximumAgeSeconds: 0.25 };
  const queryForm = runtimeForm(
    panel,
    '残波查询时效（s）',
    runtimeObjectFields(
      () => ({ ...queryPolicy }),
      (value) => {
        const age = Number(value.maximumAgeSeconds);
        if (!Number.isFinite(age) || age <= 0 || age > 0.5)
          throw new Error('Query age must be in (0, 0.5] seconds');
        queryPolicy.maximumAgeSeconds = age;
      },
    ),
  );
  let recipeRevision = -1;
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR8EntryRecipe',
        after: [WaterSceneReconcile],

        queries: [],
        fn: () => {
          const revision = assets.revision(recipe).unwrap();
          if (revision !== recipeRevision) {
            const value = assets.read(recipe).unwrap();
            if (value.system !== 'water-advanced')
              throw new Error('Expected Water advanced recipe');
            water().removeOceanPatch();
            water()
              .requestOceanPatch({
                guid: guid('fluid/coast-local'),
                contentVersion: String(revision),
                asset: value as WaterAdvancedSimulationSource & { kind: 'water-simulation-recipe' },
              })
              .unwrap();
            recipeRevision = revision;
          }
          const patch = water().oceanPatch();
          patch?.setPaused(pause.checked);
          const snapshot = water().snapshot(`scene-entity:${body}`);
          water()
            .configureOceanPatchQueries(
              queryEnabled.checked && snapshot
                ? {
                    worldIdentity: world.identity,
                    bodyGuid: snapshot.guid,
                    bodyGeneration: snapshot.sceneGeneration,
                    maximumAgeSeconds: queryPolicy.maximumAgeSeconds,
                  }
                : undefined,
            )
            .unwrap();
          patch?.update(world.getResource(Time).delta).unwrap();
          const time = world.getResource(Time).elapsed;
          for (const ball of balls) {
            if (ball.player === undefined || !ball.attachment) continue;
            const values = sampleWaterEntryAttachment(
              water(),
              ball.attachment,
              time,
              physics().getSolverClock?.(),
            );
            if (values) control.patchPlayerParameters({ player: ball.player, values }).unwrap();
          }

          for (const ball of balls)
            if (
              ball.player !== undefined &&
              ball.entryTime !== undefined &&
              time - ball.entryTime >
                (ball.entryLifetime ?? waterEntrySplashDefaults.lifetime) + 0.25
            ) {
              world.despawn(ball.player).unwrap();
              delete ball.player;
            }
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR8EntryLaunch',
        after: [PhysicsSync],
        before: [WaterBuoyancy, PhysicsSimulation],
        queries: [],
        fn: () => {
          for (const ball of balls) {
            if (ball.admitted) continue;
            const accepted = physics().getCommittedBodyDynamics?.(ball.entity);
            const owner = physics();
            if (!accepted?.ok || !owner.setBodyMotion) continue;
            owner
              .setBodyMotion(ball.entity, {
                position: ball.position,
                rotation: [0, 0, 0, 1],
                linearVelocity: ball.velocity,
                angularVelocity: [0, 0, 0],
              })
              .unwrap();
            ball.admitted = true;
          }
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR8EntryContact',
        after: [WaterBuoyancyCompletion],
        queries: [],
        fn: () => {
          const snapshot = water().snapshot(`scene-entity:${body}`),
            clock = physics().getSolverClock?.();
          if (!snapshot || !clock) return;
          for (const ball of balls) {
            if (!ball.admitted) continue;
            const accepted = physics().getCommittedBodyDynamics?.(ball.entity);
            if (!accepted?.ok) continue;
            const dynamics = accepted.value;
            const hideSubmergedBall = () => {
              if (ball.entrySurfaceYM !== undefined) {
                if (
                  !ball.submerged &&
                  ironBallSubmerged(dynamics.positionM, ball.radiusM, ball.entrySurfaceYM)
                ) {
                  world
                    .set(ball.entity, Visibility, { state: VisibilityStateValue.hidden })
                    .unwrap();
                  ball.submerged = true;
                }
                return true;
              }
              return false;
            };
            if (hideSubmergedBall()) continue;
            const query = sampleIronBallEntry(
              water(),
              snapshot,
              dynamics,
              clock,
              Boolean(ball.entry),
            );
            if (query === undefined) continue;
            if (ball.entry || ball.player === undefined) continue;
            if (
              !query.ok ||
              query.value.excluded ||
              !query.value.surfaceM ||
              !query.value.normalYUp ||
              dynamics.positionM[1] - ball.radiusM > query.value.surfaceM[1]
            )
              continue;
            ball.entry = {
              fixedStep: dynamics.completedStep,
              generation: snapshot.sceneGeneration,
              positionM: query.value.surfaceM,
              velocityMps: dynamics.linearVelocityMps,
              query: query.value,
            };
            ball.entrySurfaceYM = query.value.surfaceM[1];
            releaseIronBallWaterCollider(world, ball.entity).unwrap();
            ball.entryTime = world.getResource(Time).elapsed;
            ball.attachment = {
              collision: {
                entryPosition: query.value.surfaceM,
                entryVelocity: dynamics.linearVelocityMps,
                surfaceNormal: query.value.normalYUp,
                entryRadiusM: ball.radiusM,
              },
              bodyGuid: snapshot.guid,
              bodyGeneration: snapshot.sceneGeneration,
              startedAtSeconds: ball.entryTime,
              timeScale: 1,
            };
            const entryParameters = waterEntrySplashParameters({
              entryPosition: query.value.surfaceM,
              entryVelocity: dynamics.linearVelocityMps,
              surfaceNormal: query.value.normalYUp,
              entryRadiusM: ball.radiusM,
            });
            ball.entryLifetime = entryParameters.lifetime;
            const patch = water().oceanPatch();
            if (patch && patch.inspect().state.status !== 'disabled') {
              const impulse = patch.enqueueWaveImpulse({
                ...waterEntryWaveImpulse({
                  entryPosition: query.value.surfaceM,
                  entryVelocity: dynamics.linearVelocityMps,
                  surfaceNormal: query.value.normalYUp,
                  entryRadiusM: ball.radiusM,
                }),
                timeSeconds: clock.simulationTimeSeconds,
                sourceReceiver: { entity: ball.entity, generation: dynamics.generation },
              });
              operations.push({
                kind: 'native-water-entry-wave',
                entity: ball.entity,
                result: impulse,
              });
              if (!impulse.ok && errors.length < 20) errors.push(impulse.error);
            }
            control
              .patchPlayerParameters({
                player: ball.player,
                values: entryParameters,
              })
              .unwrap();
            world.set(ball.player, ParticleEffectPlayer, { playing: true }).unwrap();
            operations.push({ kind: 'native-water-entry', entity: ball.entity, entry: ball.entry });
          }
        },
      }),
    )
    .unwrap();
  stageRuntimePanel(app, panel, 'R8');
  waterStageNavigation('R8');
  let completedFrames = 0;
  const facts = document.createElement('pre');
  const factSection = document.createElement('details'),
    factTitle = document.createElement('summary');
  factTitle.textContent = '原生落水、波场和渲染事实';
  factSection.append(factTitle, facts);
  panel.append(factSection);
  const inspectState = document.createElement('button'),
    fullState = document.createElement('details'),
    fullTitle = document.createElement('summary'),
    fullFacts = document.createElement('pre');
  inspectState.textContent = '检查完整原生与渲染 JSON';
  fullTitle.textContent = '完整实验检查快照';
  fullState.append(fullTitle, fullFacts);
  panel.append(inspectState, fullState);
  const readState = () => ({
    completedFrames,
    balls: balls.map((ball) => ({
      ...ball,
      ...readIronBallParticipation(world, ball.entity, Boolean(ball.entry)),
      dynamics: physics().getCommittedBodyDynamics?.(ball.entity),
    })),
    operations,
    errors,
    body: water().snapshot(`scene-entity:${body}`),
    oceanPatch: water().oceanPatch()?.inspect(),
    paused: pause.checked,
    queryPolicy: { enabled: queryEnabled.checked, ...queryPolicy },
    renderer: app.renderer.inspect(),
  });
  inspectState.addEventListener('click', () => {
    fullFacts.textContent = JSON.stringify(
      readState(),
      (_key, value) => (value instanceof Set ? [...value] : value),
      2,
    );
    fullState.open = true;
  });
  const fps = document.createElement('output');
  fps.className = 'water-entry-fps';
  panel.append(fps);
  const completionTimes: number[] = [];
  let lastHudRefresh = 0;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      if (errors.length < 20) errors.push(event.error);
      return;
    }
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (!result.ok || event.receipt.presentation !== 'ready') return;
      completedFrames++;
      const now = performance.now();
      completionTimes.push(now);
      while ((completionTimes[0] ?? now) < now - 1000) completionTimes.shift();
      if (now - lastHudRefresh > 250) {
        fps.textContent = `${completionTimes.length} FPS · ${balls.filter((ball) => ball.entry).length} 次入水`;
        launchForm.refresh();
        response.refresh();
        lastHudRefresh = now;
      }
      if (factSection.open && completedFrames % 15 === 0)
        facts.textContent = JSON.stringify(
          {
            completedFrames,
            entries: balls.map(({ entity, entry }) => ({ entity, entry })),
            patch: water().oceanPatch()?.inspect(),
            renderer: app.renderer.inspect({ fields: ['state', 'frame', 'surface', 'recovery'] }),
          },
          (_key, value) => (value instanceof Set ? [...value] : value),
          2,
        );
    });
  });
  app.pluginContext.effect(() => unsubscribe);
  const readEntryObservation = () => ({
    camera: { eye, target },
    completedFrames,
    timeSeconds: world.getResource(Time).elapsed,
    clock: physics().getSolverClock?.(),
    entries: balls.map(
      ({ entity, radiusM, entry, entryTime, entrySurfaceYM, submerged, player }) => ({
        entity,
        radiusM,
        ...readIronBallParticipation(world, entity, Boolean(entry)),
        entry,
        entryTime,
        entrySurfaceYM,
        submerged: Boolean(submerged),
        player,
        dynamics: physics().getCommittedBodyDynamics?.(entity),
      }),
    ),
    vfx: vfx.inspect(world),
    rendering: vfx.feature.inspect(),
    errors,
  });
  const quality = waterQualityControl((level) => {
    const source = assets.read(zone).unwrap();
    const resolution = [256, 512, 1024, 2048][level] ?? 512;
    assets
      .replace(zone, {
        ...source,
        tessellationFactor: [3, 5, 6, 7][level] ?? 5,
        waterInfo: {
          ...source.waterInfo,
          resolution: { widthPx: resolution, heightPx: resolution },
        },
      })
      .unwrap();
    const sourceRecipe = assets.read(recipe).unwrap();
    if (sourceRecipe.system !== 'water-advanced' || !sourceRecipe.oceanPatchConfig)
      throw new Error('Expected admitted OceanPatch recipe');
    assets
      .replace(recipe, {
        ...sourceRecipe,
        oceanPatchConfig: {
          ...sourceRecipe.oceanPatchConfig,
          fftResolution: [128, 256, 512, 512][level] ?? 256,
        },
      } as WaterSimulationRecipeAsset)
      .unwrap();
  }, 1);
  const response = runtimeForm(panel, '局部波的恢复速度', [
    {
      name: 'damping',
      label: '残波衰减',
      unit: '1/s',
      min: 0.05,
      max: 2,
      step: 0.05,
      slider: true,
      value: 0.45,
      read: () => {
        const source = assets.read(recipe).unwrap();
        if (
          source.system !== 'water-advanced' ||
          source.oceanPatchConfig?.algorithm !== 'mode-projected-gravity/1'
        )
          throw new Error('Expected admitted dispersive OceanPatch recipe');
        return source.oceanPatchConfig.waveDampingPerSecond ?? 0.35;
      },
      set: (value: unknown) => {
        const source = assets.read(recipe).unwrap();
        if (
          source.system !== 'water-advanced' ||
          source.oceanPatchConfig?.algorithm !== 'mode-projected-gravity/1'
        )
          throw new Error('Expected admitted dispersive OceanPatch recipe');
        const next = Number(value);
        if (!Number.isFinite(next) || next < 0.05 || next > 2) throw new Error('Invalid damping');
        assets
          .replace(recipe, {
            ...source,
            oceanPatchConfig: {
              ...source.oceanPatchConfig,
              waveDampingPerSecond: next,
            },
          } as WaterSimulationRecipeAsset)
          .unwrap();
      },
    },
  ]);
  response.section.open = true;
  launchForm.section.open = true;
  const sourceForms = [launchForm.section, recipeForm.section, queryForm.section];
  const actions = document.createElement('div');
  actions.className = 'water-actions';
  actions.append(fireButton, reset);
  fireButton.classList.add('primary');
  for (const child of [...panel.children])
    if (
      child.tagName === 'H1' ||
      child.tagName === 'SMALL' ||
      (child.tagName === 'P' && child.id !== 'status')
    )
      child.remove();
  panel.prepend(actions);
  arrangeWaterSettings({
    panel,
    title: '铁球入水',
    description: '改变球的半径、投放高度与速度，观察同一次撞击形成的冠幕、水舌、飞滴与局部残波。',
    dimensions: [
      { title: '投放与入水', elements: [actions, ...sourceForms.slice(0, 1)], open: true },
      { title: '相机', elements: [views] },
      { title: '波场与画质', elements: [response.section, pauseLabel, quality] },
      { title: '高级 · 波场配方与查询', elements: [...sourceForms.slice(1), queryLabel] },
      { title: '高级 · 完成帧与物理观测', elements: [factSection, inspectState, fullState] },
    ],
  });
  Object.assign(window, {
    __waterR8Entry: { app, world, assets, fire, readState, readEntryObservation, setView },
  });
  window.addEventListener('resize', () => {
    if (camera !== undefined)
      world.set(camera, Camera, { aspect: canvas.clientWidth / canvas.clientHeight }).unwrap();
  });
  window.addEventListener('beforeunload', () => {
    void app.dispose();
  });
  app.start().unwrap();
}
void main().catch((error) => {
  const status = document.querySelector('#status');
  if (status)
    status.textContent = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
  console.error(error);
});
