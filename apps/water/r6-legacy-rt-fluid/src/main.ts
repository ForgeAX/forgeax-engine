import { defineSystem } from '@forgeax/engine/ecs';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { Time, Update } from '@forgeax/engine/ecs';
import { quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  DirectionalLight,
  type FrameReceipt,
  perspective,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { waterSceneSnapshot } from '@forgeax/engine/runtime';
import {
  sceneEntity,
  Transform,
  WaterFluidSimulation,
  worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import { err, ok } from '@forgeax/engine/types';
import { type WaterFluidImpulse, WaterQueryFlags, type WaterSystem } from '@forgeax/engine/water';
import { createWaterCameraControls } from '../../camera-controls';
import { dressWaterMuseum } from '../../museum-presentation';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { requireDemoValue } from '../../runtime-input';
import { arrangeWaterSettings, waterQualityControl } from '../../settings-panel';
import { waterStageNavigation } from '../../stage-catalog';
import { BASIN_CENTERS, BASINS, type Basin, fluidRecipe, WATER_R6_PACKAGE } from './identity';
import './style.css';
import '../../settings-panel.css';

type Vector = [number, number, number];
const node = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};
const input = (id: string) => node<HTMLInputElement>(id);
const select = (id: string) => node<HTMLSelectElement>(id);
const json = (_key: string, value: unknown): unknown =>
  value instanceof Error
    ? { ...value, name: value.name, message: value.message, stack: value.stack }
    : ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? Array.from(value as unknown as ArrayLike<number>)
      : value instanceof Map
        ? [...value]
        : value instanceof Set
          ? [...value]
          : value;

async function main() {
  const canvas = node<HTMLCanvasElement>('scene');
  const app = (
    await createApp(
      canvas,
      {
        plugins: [physics3d],
        uiRoot: node('controls-panel'),
        pointerLockAllowed: () => false,
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const { world, assets } = app;
  if (!assets) throw new Error('Asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R6_PACKAGE, key));
  const sceneGuid = guid('scene/basins'),
    scene = (await assets.load(sceneGuid, 'scene')).unwrap();
  const root = assets.instantiate(scene, world).unwrap(),
    source = assets.sourceKeyOf(sceneGuid);
  if (!source) throw new Error('Saved Scene Catalog source key unavailable');
  const resolve = (key: string) =>
    worldResolveSceneEntity(world, root, sceneEntity(source, key)).unwrap();
  const basins = await Promise.all(
    BASINS.map(async (key) => ({
      key,
      body: resolve(key),
      simulation: resolve(`fluid-${key}`),
      injector: resolve(`injector-${key}`),
      recipe: (await assets.load(guid(`fluid/${key}`), 'water-simulation-recipe')).unwrap(),
    })),
  );
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  let completedFrames = 0,
    errorCount = 0,
    receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'> | undefined;
  let paused = false,
    moving = false,
    follow = false,
    waveFollow = false,
    phase = 0,
    lastInjection = -1,
    pulse = 0;
  let selectedView = 'overview',
    eye: Vector = [27, 20, 31],
    target: Vector = [0, -1, 0];
  const errors: unknown[] = [],
    trace: unknown[] = [];
  const fail = (error: unknown) => {
    errorCount++;
    errors.push(error);
    if (errors.length > 40) errors.shift();
    console.error(error);
    node('errors').textContent = JSON.stringify(error, json);
  };
  const report = (result: { ok: boolean; error?: unknown }, label = '已提交') => {
    node('action-state').textContent = result.ok ? label : '变更失败';
    if (!result.ok) fail(result.error);
    return result;
  };
  const cameraSettings = {
    ...perspective({
      fov: Math.PI / 3.25,
      aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
      near: 0.08,
      far: 240,
    }),
    clearColor: [0.63, 0.75, 0.7, 1],
    antialias: ANTIALIAS_TAA,
    tonemap: TONEMAP_ACES_FILMIC,
  };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      { component: Camera, data: cameraSettings },
      { component: CameraView, data: {} },
    )
    .unwrap();
  const closeEye: Vector = [26, 18, 18],
    closeTarget: Vector = [14, 0, 0];
  const secondCamera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: closeEye,
          quat: quat.fromLookAt(quat.create(), closeEye, closeTarget, [0, 1, 0]),
        },
      },
      { component: Camera, data: cameraSettings },
      {
        component: CameraView,
        data: { viewport: [0.66, 0.08, 0.32, 0.4], order: 1, enabled: false },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.45, -0.7, -0.55],
        color: [1, 0.96, 0.85],
        intensity: 3.1,
        castShadow: false,
      },
    })
    .unwrap();
  world
    .spawn({ component: Skylight, data: { color: [0.63, 0.8, 0.72], intensity: 1.35 } })
    .unwrap();
  const chosen = () =>
    basins.filter(
      (basin) => select('basin').value === 'both' || select('basin').value === basin.key,
    );
  const instanceId = (entity: number) => `scene-entity:${entity}`;
  const applyCamera = () =>
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
  const setView = (view: string) => {
    selectedView = view;
    if (view === 'overview') {
      eye = [27, 20, 31];
      target = [0, -1, 0];
    } else if (view === 'top') {
      eye = [0, 65, 0.1];
      target = [0, 0, 0];
    } else {
      const x = BASIN_CENTERS[view as Basin];
      eye = [x + 10, 8, 17];
      target = [x, -0.2, 0];
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    applyCamera();
  };
  const configuration = () => {
    for (const basin of chosen()) {
      const mode =
        select('solver').value === 'original' ? basin.key : (select('solver').value as Basin);
      const terrain =
        select('terrain').value === 'original'
          ? mode === 'shallow'
            ? 'water-info'
            : 'constant-depth'
          : (select('terrain').value as 'water-info' | 'constant-depth');
      report(
        assets.replace(
          basin.recipe,
          fluidRecipe(
            mode,
            Number(select('quality').value),
            input('foam').checked,
            terrain,
            {
              resolution: Number(select('wave-quality').value),
              gridExtentM: Number(input('wave-extent').value),
            },
            select('wave-preset').value === 'crests' ? 'crests' : 'calm',
          ),
        ),
        '配置已提交',
      );
      node(basin.key === 'ripple' ? 'left-mode' : 'right-mode').textContent =
        mode === 'ripple' ? '涟漪' : '浅水';
    }
  };
  const waveCenter = (
    basin: Basin,
    offsetX = Number(input('wave-x').value),
    offsetZ = Number(input('wave-z').value),
  ): Vector => [BASIN_CENTERS[basin] + offsetX, 0, offsetZ];
  const updateWaveCenters = () => {
    for (const basin of chosen())
      report(
        world.set(basin.simulation, WaterFluidSimulation, {
          waveFoamCenterM: waveCenter(basin.key),
        }),
      );
  };
  const inject = (offsetZ = 0, atPhase?: number, strength?: number) => {
    const results = [];
    for (const basin of chosen()) {
      const x = atPhase === undefined ? Number(input('force-x').value) : Math.cos(atPhase) * 6;
      const z =
        offsetZ + (atPhase === undefined ? Number(input('force-z').value) : Math.sin(atPhase) * 4);
      const force: WaterFluidImpulse = {
        kind: 'direct',
        positionM: [BASIN_CENTERS[basin.key] + x, 0, z],
        radiusM: Number(input('radius').value),
        heightDeltaM: strength ?? Number(input('height').value),
        lifetimeSeconds: 0,
        foamStrength: Number(input('foam-force').value),
      };
      const result = water().fluid.enqueueImpulse(instanceId(basin.simulation), force);
      report(result, `冲击 ${result.ok ? result.value : '--'}`);
      results.push(result);
      world
        .set(basin.injector, Transform, { pos: [force.positionM[0], 0.65, force.positionM[2]] })
        .unwrap();
    }
    return results;
  };
  const reset = () => {
    for (const basin of chosen()) {
      const old = world.get(basin.simulation, WaterFluidSimulation).unwrap();
      report(
        world.set(basin.simulation, WaterFluidSimulation, { resetRevision: old.resetRevision + 1 }),
        '已重置',
      );
    }
  };
  const inspectState = () => ({
    completedFrames,
    receipt,
    errorCount,
    errors,
    paused,
    moving,
    follow,
    waveFollow,
    phase,
    selectedView,
    cameraPose: { eye, target },
    instances: world.hasResource(WATER_SYSTEM_RESOURCE) ? water().fluid.inspect() : {},
    basins: basins.map((basin) => ({
      ...basin,
      component: world.get(basin.simulation, WaterFluidSimulation).unwrap(),
      recipeSource: assets.read(basin.recipe),
      bodySnapshot: waterSceneSnapshot(world, basin.body),
    })),
    renderer: app.renderer.inspect(),
    trace,
  });
  const refresh = () => {
    if (!world.hasResource(WATER_SYSTEM_RESOURCE)) return;
    const states = water().fluid.inspect(),
      values = basins.map((basin) => states[instanceId(basin.simulation)]);
    node('completed').textContent = String(completedFrames);
    node('steps').textContent = values
      .map((value) => (value?.kind === 'active' ? value.fixedStep : '--'))
      .join(' / ');
    node('generation').textContent = values
      .map((value) => value?.simulationGeneration ?? '--')
      .join(' / ');
    node('queue').textContent = values.map((value) => value?.queuedImpulses ?? '--').join(' / ');
    node('roles').textContent = values
      .map(
        (value, index) =>
          `${index === 0 ? 'L' : 'R'} ${value?.kind ?? '--'}${value?.kind === 'active' ? ` · ${value.virtualTimeSeconds.toFixed(3)} s\n  H ${value.roles.current}/${value.roles.previous}/${value.roles.freeTarget} · V ${value.roles.velocityReadSide} · F ${value.roles.foamReadSide}` : ''}`,
      )
      .join('\n');
    const cpu = basins.map((basin) => {
      const snapshot = waterSceneSnapshot(world, basin.body);
      if (!snapshot) return '--';
      const result = water().queryBody(snapshot.guid, {
        positionM: [BASIN_CENTERS[basin.key] - 5, 0, 0],
        flags: WaterQueryFlags.ComputeLocation,
        timeSeconds: world.getResource(Time).elapsed,
      });
      return result.ok ? (result.value.surfaceM?.[1]?.toFixed(3) ?? '--') : result.error.code;
    });
    node('cpu-height').textContent = `${cpu.join(' / ')} m`;
    const inspection = app.renderer.inspect();
    const fluid = inspection.featureDiagnostics.find(
      (feature) => feature.identity === 'water-fluid-simulation',
    );
    node('producer').textContent = fluid?.status ?? '等待';
    node('status').textContent = errorCount
      ? `${errorCount} 个错误`
      : paused
        ? '已暂停'
        : '实时渲染';
    node('frame-receipt').textContent = receipt
      ? `帧 ${receipt.frameId} · 设备 ${receipt.deviceGeneration} · 图 ${receipt.graphGeneration ?? '--'}`
      : '--';
  };
  for (const id of [
    'solver',
    'quality',
    'terrain',
    'foam',
    'wave-preset',
    'wave-quality',
    'wave-extent',
  ])
    node(id).addEventListener('change', configuration);
  input('enabled').addEventListener('change', () => {
    for (const basin of chosen())
      report(
        world.set(basin.simulation, WaterFluidSimulation, { enabled: input('enabled').checked }),
      );
  });
  for (const id of ['wave-x', 'wave-z']) node(id).addEventListener('change', updateWaveCenters);
  for (const [id, output, suffix] of [
    ['height', 'height-value', ' m'],
    ['radius', 'radius-value', ' m'],
    ['foam-force', 'foam-value', ''],
  ] as const)
    input(id).addEventListener('input', () => {
      node(output).textContent =
        `${Number(input(id).value).toFixed(id === 'foam-force' ? 1 : 2)}${suffix}`;
    });
  node('impulse').addEventListener('click', () => {
    inject();
  });
  node('pulse').addEventListener('click', () => {
    pulse = 3;
  });
  node('reset').addEventListener('click', reset);
  input('moving').addEventListener('change', () => {
    moving = input('moving').checked;
  });
  input('follow').addEventListener('change', () => {
    follow = input('follow').checked;
    if (!follow)
      for (const basin of basins)
        world.set(basin.simulation, Transform, { pos: [BASIN_CENTERS[basin.key], 0, 0] }).unwrap();
  });
  input('wave-follow').addEventListener('change', () => {
    waveFollow = input('wave-follow').checked;
    if (!waveFollow) updateWaveCenters();
  });
  const pause = (value: boolean) => {
    paused = value;
    input('paused').checked = value;
    report(value ? app.pause() : app.resume(), value ? '已暂停' : '继续模拟');
    refresh();
  };
  input('paused').addEventListener('change', () => pause(input('paused').checked));
  node('step').addEventListener('click', () => {
    pause(true);
    report(app.stepFrame(1 / 60), '单帧推进');
    refresh();
  });
  input('multi-view').addEventListener('change', () => {
    const enabled = input('multi-view').checked;
    report(world.set(secondCamera, CameraView, { enabled }));
  });
  input('compact').addEventListener('change', () =>
    document.body.classList.toggle('compact', input('compact').checked),
  );
  node('recover').addEventListener('click', async () => {
    node<HTMLButtonElement>('recover').disabled = true;
    const result = await app.renderer.recover();
    report(result, '设备已恢复');
    if (result.ok) node('errors').textContent = '';
    node<HTMLButtonElement>('recover').disabled = app.renderer.state() !== 'device-lost';
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.addEventListener('click', () =>
      setView(requireDemoValue(button.dataset.view, 'accepted authored scene member')),
    );
  node('panel-toggle').addEventListener('click', () => {
    document.body.classList.toggle('panel-hidden');
    node('panel-toggle').setAttribute(
      'aria-expanded',
      String(!document.body.classList.contains('panel-hidden')),
    );
  });
  if (matchMedia('(max-width:700px)').matches) document.body.classList.add('panel-hidden');
  const exportState = () => {
    const data = JSON.stringify(inspectState(), json, 2),
      url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `water-r6-${receipt?.frameId ?? 0}.json`;
    link.click();
    URL.revokeObjectURL(url);
    return data;
  };
  node('export').addEventListener('click', exportState);
  const capture = async () => {
    if (!app.rhiCapture) return err({ code: 'capture-unavailable' });
    const artifact = await app.rhiCapture.captureFrame();
    if (!artifact.ok) return artifact;
    const uploaded = await app.rhiCapture.upload(artifact.value);
    report(uploaded, 'RHI 帧已保存');
    return uploaded;
  };
  node('capture').addEventListener('click', () => {
    void capture();
  });
  createWaterCameraControls({
    app,
    canvas,
    readPose: () => ({ eye, target }),
    writePose: (pose) => {
      eye = [...pose.eye];
      target = [...pose.target];
      applyCamera();
    },
    speedMps: 8,
  });
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR6ForcesAndGrid',
        queries: [],
        fn: () => {
          const time = world.getResource(Time);
          phase += time.delta * 0.8;
          if (
            (moving || pulse > 0) &&
            time.elapsed - lastInjection > (moving ? 0.07 : 0.25) &&
            world.hasResource(WATER_SYSTEM_RESOURCE)
          ) {
            inject(
              pulse > 0 ? (pulse - 2) * 3 : 0,
              moving ? phase : undefined,
              moving ? -0.025 : undefined,
            );
            lastInjection = time.elapsed;
            pulse = Math.max(0, pulse - 1);
          }
          if (follow)
            for (const basin of basins)
              world
                .set(basin.simulation, Transform, {
                  pos: [
                    BASIN_CENTERS[basin.key] + Math.cos(phase * 0.5) * 3,
                    0,
                    Math.sin(phase * 0.5) * 2,
                  ],
                })
                .unwrap();
          if (waveFollow)
            for (const basin of chosen())
              world
                .set(basin.simulation, WaterFluidSimulation, {
                  waveFoamCenterM: waveCenter(
                    basin.key,
                    Number(input('wave-x').value) + Math.cos(phase * 0.35) * 4,
                    Number(input('wave-z').value) + Math.sin(phase * 0.35) * 3,
                  ),
                })
                .unwrap();
          if (input('grid').checked && app.debugDraw)
            for (const basin of basins) {
              const center = world.get(basin.simulation, Transform).unwrap().pos,
                x = requireDemoValue(center[0], 'accepted authored scene member'),
                z = requireDemoValue(center[2], 'accepted authored scene member');
              const source = assets.read(basin.recipe);
              if (!source.ok || source.value.system !== 'fluid-simulation') continue;
              const extent = source.value.gridExtentM,
                halfX = extent[0] / 2,
                halfZ = extent[1] / 2;
              const corners = [
                vec3.create(x - halfX, 0.04, z - halfZ),
                vec3.create(x + halfX, 0.04, z - halfZ),
                vec3.create(x + halfX, 0.04, z + halfZ),
                vec3.create(x - halfX, 0.04, z + halfZ),
              ];
              corners.forEach((value, index) => {
                requireDemoValue(app.debugDraw, 'accepted authored scene member').line(
                  value,
                  requireDemoValue(corners[(index + 1) % 4], 'accepted authored scene member'),
                  basin.key === 'ripple' ? [0.25, 0.8, 0.85, 1] : [1, 0.8, 0.2, 1],
                );
              });
              if (source.value.foamEnabled) {
                const wave = world
                    .get(basin.simulation, WaterFluidSimulation)
                    .unwrap().waveFoamCenterM,
                  half = source.value.waveFoam.gridExtentM / 2;
                const bounds = [
                  vec3.create(
                    requireDemoValue(wave[0], 'accepted authored scene member') - half,
                    0.08,
                    requireDemoValue(wave[2], 'accepted authored scene member') - half,
                  ),
                  vec3.create(
                    requireDemoValue(wave[0], 'accepted authored scene member') + half,
                    0.08,
                    requireDemoValue(wave[2], 'accepted authored scene member') - half,
                  ),
                  vec3.create(
                    requireDemoValue(wave[0], 'accepted authored scene member') + half,
                    0.08,
                    requireDemoValue(wave[2], 'accepted authored scene member') + half,
                  ),
                  vec3.create(
                    requireDemoValue(wave[0], 'accepted authored scene member') - half,
                    0.08,
                    requireDemoValue(wave[2], 'accepted authored scene member') + half,
                  ),
                ];
                bounds.forEach((value, index) => {
                  requireDemoValue(app.debugDraw, 'accepted authored scene member').line(
                    value,
                    requireDemoValue(bounds[(index + 1) % 4], 'accepted authored scene member'),
                    [0.9, 0.35, 0.6, 1],
                  );
                });
              }
            }
        },
      }),
    )
    .unwrap();
  const completionTimes: number[] = [];
  let lastRefresh = 0;
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') fail(event.error);
    if (event.kind === 'state-changed')
      node<HTMLButtonElement>('recover').disabled = event.current !== 'device-lost';
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed
      .then((result) => {
        if (!result.ok) {
          fail(result.error);
          return;
        }
        if (event.receipt.presentation !== 'ready') return;
        completedFrames++;
        receipt = {
          frameId: event.receipt.frameId,
          deviceGeneration: event.receipt.deviceGeneration,
          ...(event.receipt.graphGeneration === undefined
            ? {}
            : { graphGeneration: event.receipt.graphGeneration }),
        };
        const now = performance.now();
        completionTimes.push(now);
        while ((completionTimes[0] ?? now) < now - 1000) completionTimes.shift();
        if (now - lastRefresh > 200) {
          node('fps').textContent = `${completionTimes.length} FPS`;
          node('live-dot').classList.add('active');
          refresh();
          lastRefresh = now;
          trace.push({ receipt, states: water().fluid.inspect() });
          if (trace.length > 120) trace.shift();
        }
      })
      .catch(fail);
  });
  app.onError(fail);
  Object.assign(window, {
    __waterR6: {
      app,
      world,
      assets,
      root,
      basins,
      camera,
      secondCamera,
      errors,
      inspectState,
      readState: inspectState,
      setView,
      configuration,
      updateWaveCenters,
      inject,
      reset,
      pause,
      capture,
      exportState,
      step: (delta = 1 / 60) => {
        pause(true);
        return app.stepFrame(delta);
      },
      setCameraPose: (pose: { eye: Vector; target: Vector }) => {
        eye = pose.eye;
        target = pose.target;
        applyCamera();
        return ok(undefined);
      },
    },
  });
  window.addEventListener('beforeunload', () => {
    void app.dispose();
  });
  await dressWaterStage(app, [0, 0, 0], 1.2, 'laboratory');
  await dressWaterMuseum(app, [0, -4.8, 0], [86, 15, 74]);
  stageRuntimePanel(
    app,
    requireDemoValue(document.getElementById('controls-panel'), 'accepted authored scene member'),
    'R6',
  );
  const quality = waterQualityControl((level) => {
    select('quality').value = String([128, 128, 256, 512][level]);
    select('wave-quality').value = String([64, 128, 256, 512][level]);
    configuration();
  }, 1);
  const panel = node('controls-panel');
  const sections = [...panel.querySelectorAll<HTMLElement>(':scope > section')];
  arrangeWaterSettings({
    panel,
    title: '局部水面反应',
    description:
      '向双池施加同一次冲击，观察涟漪与浅水的传播差异；移动水源，观察泡沫和模拟区域的响应。',
    dimensions: [
      { title: '冲击与水面反应', elements: sections.slice(1, 2), open: true },
      { title: '水池与画质', elements: [quality, ...sections.slice(0, 1)] },
      { title: '泡沫与波峰', elements: sections.slice(4, 5) },
      { title: '播放与观察', elements: sections.slice(2, 3) },
      { title: '高级 · 已完成模拟', elements: sections.slice(3, 4) },
    ],
  });
  waterStageNavigation('R6');
  app.start().unwrap();
  applyCamera();
}
void main().catch((error: unknown) => {
  Object.assign(window, { __waterR6StartupError: error });
  node('status').textContent = '启动失败';
  node('errors').textContent = JSON.stringify(error, json);
  console.error(error);
});
