import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import {
  defineSystem,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  type InputShapeOf,
  type SchemaOf,
  Update,
} from '@forgeax/engine/ecs';
import { quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Collider,
  PhysicsSimulation,
  PhysicsSync,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
  snapshotCollider,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  createWaterFluidFeature,
  DirectionalLight,
  type FrameReceipt,
  perspective,
  Skylight,
  TONEMAP_ACES_FILMIC,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine/render';
import {
  WATER_BUOYANCY_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  WaterBuoyancy,
  WaterBuoyancyCompletion,
  type WaterBuoyancyState,
  waterSceneSnapshot,
} from '@forgeax/engine/runtime';
import {
  ChildOf,
  readPresentationWorldMatrix,
  sceneEntity,
  Transform,
  WaterBodyInstance,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterPontoonSet,
  worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import { err, ok, type WaterZoneAsset } from '@forgeax/engine/types';
import {
  queryWaterBodySnapshot,
  rotateWaterVector,
  type WaterBuoyancyStep,
  WaterQueryFlags,
  type WaterSystem,
} from '@forgeax/engine/water';
import { createWaterCameraControls } from '../../camera-controls';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { applyBoatControls } from '../../r4-buoyancy-foam/src/boat-controls';
import { requireDemoValue } from '../../runtime-input';
import { arrangeWaterSettings, waterQualityControl } from '../../settings-panel';
import { waterStageNavigation } from '../../stage-catalog';
import {
  CRAFT_LABELS,
  CRAFTS,
  type Craft,
  type PontoonCount,
  pontoonLayout,
  START_POSITIONS,
  WATER_R5_PACKAGE,
} from './identity';
import './style.css';
import '../../settings-panel.css';
import './experience.css';

type Vector = [number, number, number];
type View = 'overview' | 'follow' | 'shore' | 'occlusion' | 'manual';
type PontoonInput = InputShapeOf<SchemaOf<typeof WaterPontoonSet>>;
type PendingBoundary = { kind: 'root' | 'water'; type: Craft } & (
  | { phase: 'retire' }
  | { phase: 'retired'; generation: number; restore: () => void }
  | { phase: 'restored'; generation: number }
);
const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
};
const numberValue = (id: string) => Number(node<HTMLInputElement>(id).value);
const checked = (id: string) => node<HTMLInputElement>(id).checked;
const fixed = (value: number | undefined, digits = 2) =>
  value === undefined ? '--' : value.toFixed(digits);
const facts = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    const error = value as Error & {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
      detail?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: error.detail,
      stack: error.stack,
    };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Map || value instanceof Set) return Array.from(value);
  return value;
};

async function main() {
  const canvas = node<HTMLCanvasElement>('scene');
  const app = (
    await createApp(
      canvas,
      {
        plugins: [physics3d],
        features: [
          createWaterFluidFeature({
            contactFoam: { resolution: 512, decayPerSecond: 1.8, strengthPerMps: 0.08 },
          }),
        ],
        uiRoot: node('controls-panel'),
        pointerLockAllowed: () => false,
        ...(__WATER_R5_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R5_SSR_IDENTITY__ }),
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
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R5_PACKAGE, key));
  const scene = (await assets.load(guid('scene/estuary'), 'scene')).unwrap();
  const root = assets.instantiate(scene, world).unwrap();
  const sourceKey = assets.sourceKeyOf(guid('scene/estuary'));
  if (!sourceKey) throw new Error('Saved Scene has no accepted Catalog source key');
  const resolve = (key: string) =>
    worldResolveSceneEntity(world, root, sceneEntity(sourceKey, key)).unwrap();
  const zoneHandle = (await assets.load(guid('zone/estuary'), 'water-zone')).unwrap();
  const crafts = await Promise.all(
    CRAFTS.map(async (type) => ({
      type,
      entity: resolve(`${type}-craft`),
      cargo: resolve(`${type}-craft-cargo`),
      waterEntity: resolve(type),
      bodyHandle: (await assets.load(guid(`body/${type}`), 'water-body')).unwrap(),
      sockets:
        type === 'ocean'
          ? Array.from({ length: 16 }, (_, i) => resolve(`${type}-craft-socket-${i}`))
          : ([] as EntityHandle[]),
    })),
  );
  let selected: Craft = 'lake',
    selectedView: View = 'follow';
  let eye: Vector = [0, 3.5, -3],
    target: Vector = [-5, 1.15, 3];
  let completedFrames = 0,
    updateTicks = 0,
    lastCompletedStep = -1,
    errorCount = 0;
  let receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'> | undefined;
  const errors: unknown[] = [],
    history: { step: number; state: WaterBuoyancyState }[] = [];
  const log: { time: string; message: string }[] = [];
  const eventCounts = { entered: 0, exited: 0, wake: 0 };
  let pendingMotion: { type: Craft; launch: boolean; preset?: 'reentry' | 'head-on' } | undefined;
  const pendingCargoWakes = new Set<EntityHandle>();
  let pendingBoundary: PendingBoundary | undefined;
  const boundaryEvents: {
    kind: 'root' | 'water';
    type: Craft;
    phase: PendingBoundary['phase'];
    tick: number;
    nativePresent: boolean;
    nativeGeneration?: number;
    waterGeneration?: number;
    selection?: WaterBuoyancyState['async']['selections'][number];
  }[] = [];
  let settings = assets.read(zoneHandle).unwrap();
  let gpuSettings = requireDemoValue(settings.gpuMesh, 'accepted authored scene member');
  const physics = () => world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const buoyancy = () => world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
  const craft = () =>
    requireDemoValue(
      crafts.find((value) => value.type === selected),
      'accepted authored scene member',
    );
  const config = () => world.get(craft().entity, WaterPontoonSet).unwrap();
  const stressEntities: EntityHandle[] = [];
  const customEntity = resolve('custom'),
    exclusionEntity = world.spawn({ component: Transform, data: {} }).unwrap();
  let stressMode = 'base';
  const appendLog = (message: string) => {
    log.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message });
    if (log.length > 8) log.pop();
    const list = node('event-log');
    list.replaceChildren(
      ...log.map((item) => {
        const li = document.createElement('li'),
          time = document.createElement('time');
        time.textContent = item.time;
        li.append(time, document.createTextNode(item.message));
        return li;
      }),
    );
  };
  const recordError = (error: unknown) => {
    errorCount++;
    errors.push(error);
    if (errors.length > 32) errors.shift();
    node('render-state').textContent = '运行错误';
    node('live-dot').className = 'live-dot failed';
    console.error(error);
  };
  const report = (result: { ok: boolean; error?: unknown }, success = '已接纳') => {
    node('action-state').textContent = result.ok ? success : JSON.stringify(result.error, facts);
    if (!result.ok) recordError(result.error);
    return result;
  };
  const patch = (data: Partial<PontoonInput>) =>
    report(world.set(craft().entity, WaterPontoonSet, data));
  const cameraData = {
    ...perspective({
      fov: Math.PI / 3.1,
      aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
      near: 0.1,
      far: 600,
    }),
    clearColor: [0.64, 0.79, 0.8, 1] as const,
    antialias: ANTIALIAS_TAA,
    tonemap: TONEMAP_ACES_FILMIC,
  };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      { component: Camera, data: cameraData },
    )
    .unwrap();
  const secondEye: Vector = [-32, 60, 28],
    secondTarget: Vector = [-22, 0, -3];
  const secondCamera = world
    .spawn({
      component: Transform,
      data: {
        pos: secondEye,
        quat: quat.fromLookAt(quat.create(), secondEye, secondTarget, [0, 1, 0]),
      },
    })
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.45, -0.82, -0.3],
        color: [1, 0.96, 0.87],
        intensity: 3,
        castShadow: false,
      },
    })
    .unwrap();
  world
    .spawn({
      component: Skylight,
      data: { color: [0.64, 0.8, 0.88], groundColor: [0.18, 0.25, 0.2], intensity: 1.35 },
    })
    .unwrap();
  let cameraLayoutDirty = true,
    cameraLayoutView: View | undefined;
  const invalidateCameraLayout = () => {
    cameraLayoutDirty = true;
  };
  const updateCameraProjection = () => {
    if (!cameraLayoutDirty && cameraLayoutView === selectedView) return;
    cameraLayoutDirty = false;
    cameraLayoutView = selectedView;
    let projectionOffset: [number, number] = [0, 0];
    if (selectedView === 'follow') {
      const canvasRect = canvas.getBoundingClientRect();
      const viewport = {
        left: canvasRect.left,
        right: canvasRect.left + canvasRect.width * (checked('multiview') ? 0.5 : 1),
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      };
      const blockers = [
        node('controls-panel'),
        node('trace-panel'),
        requireDemoValue(
          document.querySelector<HTMLElement>('.scene-topline'),
          'accepted authored scene member',
        ),
        requireDemoValue(
          document.querySelector<HTMLElement>('.scene-bottomline'),
          'accepted authored scene member',
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getBoundingClientRect())
        .map((rect) => ({
          left: Math.max(viewport.left, rect.left),
          right: Math.min(viewport.right, rect.right),
          top: Math.max(viewport.top, rect.top),
          bottom: Math.min(viewport.bottom, rect.bottom),
        }))
        .filter((rect) => rect.left < rect.right && rect.top < rect.bottom);
      const xs = [
        ...new Set([
          viewport.left,
          viewport.right,
          ...blockers.flatMap((rect) => [rect.left, rect.right]),
        ]),
      ].sort((a, b) => a - b);
      const ys = [
        ...new Set([
          viewport.top,
          viewport.bottom,
          ...blockers.flatMap((rect) => [rect.top, rect.bottom]),
        ]),
      ].sort((a, b) => a - b);
      let available = viewport,
        largestArea = 0;
      // Layout changes are infrequent; select the largest rectangle clear of the measured HUD.
      for (const left of xs)
        for (const right of xs)
          for (const top of ys)
            for (const bottom of ys) {
              const area = (right - left) * (bottom - top);
              if (
                right <= left ||
                bottom <= top ||
                area <= largestArea ||
                blockers.some(
                  (rect) =>
                    left < rect.right &&
                    right > rect.left &&
                    top < rect.bottom &&
                    bottom > rect.top,
                )
              )
                continue;
              available = { left, right, top, bottom };
              largestArea = area;
            }
      if (viewport.right > viewport.left && viewport.bottom > viewport.top)
        projectionOffset = [
          (available.left + available.right - viewport.left - viewport.right) /
            (viewport.right - viewport.left),
          (viewport.top + viewport.bottom - available.top - available.bottom) /
            (viewport.bottom - viewport.top),
        ];
    }
    world.set(camera, Camera, { projectionOffset }).unwrap();
  };
  const cameraLayoutObserver = new ResizeObserver(invalidateCameraLayout);
  for (const element of [
    canvas,
    node('controls-panel'),
    node('trace-panel'),
    requireDemoValue(
      document.querySelector<HTMLElement>('.scene-topline'),
      'accepted authored scene member',
    ),
    requireDemoValue(
      document.querySelector<HTMLElement>('.scene-bottomline'),
      'accepted authored scene member',
    ),
  ])
    cameraLayoutObserver.observe(element);
  window.addEventListener('resize', invalidateCameraLayout);
  const applyCamera = () => {
    updateCameraProjection();
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
    node<HTMLInputElement>('camera-height').value = String(eye[1]);
    node('height-value').textContent = `${eye[1].toFixed(0)} m`;
  };
  const position = (entity: EntityHandle): Vector => {
    const matrix = readPresentationWorldMatrix(world, entity);
    return matrix
      ? [
          requireDemoValue(matrix[12], 'accepted authored scene member'),
          requireDemoValue(matrix[13], 'accepted authored scene member'),
          requireDemoValue(matrix[14], 'accepted authored scene member'),
        ]
      : [...START_POSITIONS[selected]];
  };
  const refreshView = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === selectedView));
  };
  const setView = (view: View) => {
    selectedView = view;
    if (view === 'overview') {
      eye = [51, 45, 66];
      target = [-12, 0, 0];
    }
    if (view === 'shore') {
      eye = [10, 5, 28];
      target = [1, 0, 0];
    }
    if (view === 'occlusion') {
      eye = [50, 4.2, 34];
      target = [43, 0, -15];
    }
    if (view === 'follow') {
      const at = position(craft().entity);
      eye = [at[0] + 5, Math.max(0, at[1]) + 2.8, at[2] - 6];
      target = [at[0], Math.max(0, at[1]) + 0.3, at[2]];
    }
    applyCamera();
    refreshView();
  };
  const applyMesh = (candidate: WaterZoneAsset) => {
    const result = assets.replace(zoneHandle, candidate);
    if (result.ok) {
      settings = candidate;
      node<HTMLSelectElement>('mesh-path').value = candidate.gpuMesh ? 'gpu' : 'cpu';
      appendLog(
        candidate.gpuMesh
          ? `GPU 网格：${candidate.gpuMesh.supersampling}× SS / ${candidate.gpuMesh.msaaSamples}× MSAA / ${candidate.gpuMesh.occlusion}`
          : 'CPU 网格已接纳',
      );
    }
    return report(result, '网格参数已接纳');
  };
  const updateMesh = (patchValue: Partial<WaterZoneAsset>) =>
    applyMesh({ ...settings, ...patchValue });
  const setMeshPath = (path: 'cpu' | 'gpu') => {
    const { gpuMesh: _gpuMesh, ...cpu } = settings;
    return applyMesh(path === 'gpu' ? { ...cpu, gpuMesh: gpuSettings } : cpu);
  };
  const setMeshSettings = (gpu: Partial<NonNullable<WaterZoneAsset['gpuMesh']>>) => {
    gpuSettings = { ...gpuSettings, ...gpu };
    return settings.gpuMesh ? updateMesh({ gpuMesh: gpuSettings }) : ok(undefined);
  };
  node('mesh-path').addEventListener('change', () =>
    setMeshPath(node<HTMLSelectElement>('mesh-path').value as 'cpu' | 'gpu'),
  );
  const setStress = async (mode: string) => {
    for (const entity of stressEntities) world.despawn(entity).unwrap();
    stressEntities.length = 0;
    stressMode = mode;
    const count = mode === 'priorities' ? 9 : mode === '127' ? 124 : mode === '128' ? 125 : 0;
    const handles = await Promise.all(
      Array.from({ length: Math.min(count, 9) }, (_, index) =>
        assets.load(guid(`body/probe-${index}`), 'water-body').then((value) => value.unwrap()),
      ),
    );
    for (let index = 0; index < count; index++)
      stressEntities.push(
        world
          .spawn(
            { component: Transform, data: {} },
            {
              component: WaterBodyInstance,
              data: {
                body: requireDemoValue(
                  handles[mode === 'priorities' ? index : index % handles.length],
                  'accepted authored scene member',
                ),
              },
            },
          )
          .unwrap(),
      );
    appendLog(
      `重叠场景：${mode === 'base' ? '河口' : mode === 'priorities' ? '9 级优先级' : `${count + 3} 个相交水体`}`,
    );
  };
  node('stress').addEventListener('change', () => {
    void setStress(node<HTMLSelectElement>('stress').value).catch(recordError);
  });
  for (const id of ['supersampling', 'msaa', 'occlusion'])
    node(id).addEventListener('change', () =>
      setMeshSettings({
        supersampling: numberValue('supersampling'),
        msaaSamples: numberValue('msaa') as 1 | 4,
        occlusion: node<HTMLSelectElement>('occlusion').value as NonNullable<
          WaterZoneAsset['gpuMesh']
        >['occlusion'],
      }),
    );
  node('lod-scale').addEventListener('input', () => {
    node('lod-value').textContent = fixed(numberValue('lod-scale'), 1);
  });
  node('lod-scale').addEventListener('change', () =>
    updateMesh({ lodScale: numberValue('lod-scale') }),
  );
  node('tessellation').addEventListener('change', () =>
    updateMesh({ tessellationFactor: numberValue('tessellation') }),
  );
  node('camera-height').addEventListener('input', () => {
    eye[1] = numberValue('camera-height');
    selectedView = 'manual';
    refreshView();
    applyCamera();
  });
  node('wire').addEventListener('change', () => water().setMeshEdgeOverlayEnabled(checked('wire')));
  node('multiview').addEventListener('change', () => {
    invalidateCameraLayout();
    if (checked('multiview')) {
      world
        .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } })
        .unwrap();
      world.addComponent(secondCamera, { component: Camera, data: cameraData }).unwrap();
      world
        .addComponent(secondCamera, {
          component: CameraView,
          data: { viewport: [0.5, 0, 0.5, 1], order: 1 },
        })
        .unwrap();
    } else {
      world.removeComponent(camera, CameraView).unwrap();
      world.removeComponent(secondCamera, Camera).unwrap();
      world.removeComponent(secondCamera, CameraView).unwrap();
    }
    appendLog(checked('multiview') ? '双视图已接纳' : '恢复单视图');
  });
  node('waves').addEventListener('change', () => {
    for (const item of crafts)
      report(
        assets.update(item.bodyHandle, {
          waveSetGuid: guid(checked('waves') ? 'waves/estuary' : 'waves/off'),
        }),
      );
  });
  const queryEntity = () =>
    node<HTMLSelectElement>('query-body').value === 'custom' ? customEntity : craft().waterEntity;
  const queryPosition = (): Vector =>
    node<HTMLSelectElement>('query-body').value === 'custom'
      ? [74, 0.5, -50]
      : position(craft().entity);
  const updateQuerySources = () => {
    const entity = queryEntity(),
      snapshot = waterSceneSnapshot(world, entity);
    if (!snapshot) return;
    if (world.hasComponent(exclusionEntity, WaterExclusionVolume))
      world.removeComponent(exclusionEntity, WaterExclusionVolume).unwrap();
    if (checked('query-exclusion'))
      world
        .addComponent(exclusionEntity, {
          component: WaterExclusionVolume,
          data: {
            mode: WaterExclusionMode.addListedBodiesToExclusion,
            waterBodies: [entity],
            centerM: queryPosition(),
            halfExtentsM: [3, 5, 3],
          },
        })
        .unwrap();
    if (checked('query-baked')) {
      const at = queryPosition(),
        samples = new Float32Array(5 * 5 * 4);
      for (let index = 0; index < 25; index++) samples.set([0.9, 1.75, 0.6, -0.25], index * 4);
      report(
        water().publishBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration, {
          kind: 'live-capture',
          enabled: true,
          componentValid: true,
          dataValid: true,
          grid: {
            originXZ: [at[0] - 8, at[2] - 8],
            originY: 0.2,
            spacingXZ: [4, 4],
            width: 5,
            height: 5,
            samples,
          },
        }),
      );
    } else report(water().clearBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration));
  };
  for (const id of ['query-exclusion', 'query-baked', 'query-body'])
    node(id).addEventListener('change', updateQuerySources);
  const compareQueries = () => {
    const snapshot = waterSceneSnapshot(world, queryEntity());
    if (!snapshot) return undefined;
    const time = world.getResource(FixedTime),
      input = {
        positionM: queryPosition(),
        timeSeconds: time.tick * time.delta,
        flags:
          WaterQueryFlags.ComputeLocation |
          WaterQueryFlags.ComputeNormal |
          WaterQueryFlags.ComputeDepth |
          WaterQueryFlags.ComputeImmersionDepth |
          WaterQueryFlags.ComputeVelocity |
          WaterQueryFlags.IncludeWaves,
      };
    const canonical = water().queryBody(snapshot.guid, input);
    const baked = water().bakedQueryGrid(snapshot.guid, snapshot.sceneGeneration);
    const captured = baked ? { ...input, baked } : input;
    const terrain = canonical.ok ? canonical.value.terrainSample : undefined;
    return {
      body: snapshot.asset.type,
      generation: snapshot.sceneGeneration,
      input,
      synchronous: canonical,
      solverSafe: queryWaterBodySnapshot(snapshot, captured, terrain, 'solver-safe'),
      splineDepth: queryWaterBodySnapshot(snapshot, input, undefined, 'solver-safe'),
      terrain,
    };
  };

  const refreshControls = () => {
    const c = config();
    node<HTMLSelectElement>('craft').value = selected;
    node<HTMLInputElement>('cargo-mass').value = String(
      Math.max(0, world.get(craft().entity, RigidBody).unwrap().mass - 125),
    );
    node<HTMLInputElement>('cargo-side').value = String(
      world.get(craft().cargo, Transform).unwrap().pos[2],
    );
    node<HTMLInputElement>('async-component').checked = c.useAsyncPath;
    node<HTMLInputElement>('buoyancy').checked = c.enabled;
    node<HTMLInputElement>('river-force').checked = c.applyRiverForces;
    node<HTMLInputElement>('drag').checked = c.applyDrag;
    node<HTMLSelectElement>('pontoon-count').value = String(c.radiiM.length);
    node<HTMLSelectElement>('anchor').value = c.anchorMode === 1 ? 'socket' : 'relative';
    node<HTMLInputElement>('coefficient').value = String(c.buoyancyCoefficientNPerM3);
    node<HTMLInputElement>('force-cap').value = String(c.maxBuoyantForceN);
  };
  const rebuildPontoons = () => {
    const c = craft(),
      count = numberValue('pontoon-count') as PontoonCount,
      anchors = pontoonLayout(count),
      socket = node<HTMLSelectElement>('anchor').value === 'socket';
    for (const entity of c.sockets) world.despawn(entity).unwrap();
    c.sockets.length = 0;
    anchors.forEach((at) => {
      if (socket)
        c.sockets.push(
          world
            .spawn(
              { component: Transform, data: { pos: at } },
              { component: ChildOf, data: { parent: c.entity } },
            )
            .unwrap(),
        );
    });
    patch({
      anchorsM: socket ? anchors.flatMap(() => [0, 0, 0]) : anchors.flatMap((at) => [...at]),
      radiiM: anchors.map(() => 0.8),
      socketEntities: c.sockets,
      enabledPontoons: [],
      anchorMode: socket ? 1 : 0,
    });
    appendLog(`${CRAFT_LABELS[selected]}：${count} 浮筒 / ${socket ? '层级插槽' : '相对坐标'}`);
  };
  node('craft').addEventListener('change', () => {
    selected = node<HTMLSelectElement>('craft').value as Craft;
    refreshControls();
    if (selectedView === 'follow') setView('follow');
    refresh();
  });
  node('execution-mode').addEventListener('change', () => {
    const asynchronous = node<HTMLSelectElement>('execution-mode').value === 'worker';
    buoyancy().asyncEnabled = asynchronous;
    node<HTMLInputElement>('async-global').checked = asynchronous;
    node<HTMLInputElement>('async-component').checked = asynchronous;
    patch({ useAsyncPath: asynchronous });
    refreshControls();
  });
  node('async-global').addEventListener('change', () => {
    buoyancy().asyncEnabled = checked('async-global');
    appendLog(`全局异步${checked('async-global') ? '开启' : '关闭'}`);
  });
  for (const [id, key] of [
    ['async-component', 'useAsyncPath'],
    ['buoyancy', 'enabled'],
    ['river-force', 'applyRiverForces'],
    ['drag', 'applyDrag'],
  ] as const)
    node(id).addEventListener('change', () => patch({ [key]: checked(id) }));
  for (const id of ['pontoon-count', 'anchor'])
    node(id).addEventListener('change', rebuildPontoons);
  node('coefficient').addEventListener('change', () =>
    patch({ buoyancyCoefficientNPerM3: numberValue('coefficient') }),
  );
  node('force-cap').addEventListener('change', () =>
    patch({ maxBuoyantForceN: numberValue('force-cap') }),
  );
  const cancel = () => {
    patch({ useAsyncPath: false });
    refreshControls();
    appendLog(`取消 ${CRAFT_LABELS[selected]} 的异步任务`);
  };
  const boundary = (kind: 'root' | 'water') => {
    if (pendingBoundary) return;
    pendingBoundary = { kind, type: selected, phase: 'retire' };
    appendLog(`请求重建${kind === 'root' ? '刚体' : '水体'}代际`);
  };
  node('cancel').addEventListener('click', cancel);
  node('recreate-root').addEventListener('click', () => boundary('root'));
  node('rebind-water').addEventListener('click', () => boundary('water'));
  node('reset').addEventListener('click', () => {
    pendingMotion = { type: selected, launch: false };
  });
  node('launch').addEventListener('click', () => {
    pendingMotion = { type: selected, launch: true };
    setView('follow');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.addEventListener('click', () => setView(button.dataset.view as View));
  for (const name of ['mesh', 'solver', 'observe'])
    node(`tab-${name}`).addEventListener('click', () => {
      for (const pane of ['mesh', 'solver', 'observe']) {
        node(`tab-${pane}`).setAttribute('aria-selected', String(name === pane));
        node(`pane-${pane}`).hidden = name !== pane;
      }
    });
  node('panel-toggle').addEventListener('click', () => {
    document.body.classList.toggle('panel-hidden');
    node('panel-toggle').setAttribute(
      'aria-expanded',
      String(!document.body.classList.contains('panel-hidden')),
    );
    invalidateCameraLayout();
  });
  if (matchMedia('(max-width:700px)').matches) {
    document.body.classList.add('panel-hidden');
    node('panel-toggle').setAttribute('aria-expanded', 'false');
  }
  node('trace-toggle').addEventListener('click', () => {
    node('trace-panel').classList.toggle('expanded');
    node('trace-toggle').setAttribute(
      'aria-expanded',
      String(node('trace-panel').classList.contains('expanded')),
    );
    invalidateCameraLayout();
  });
  const setCargo = (massKg: number, sideM: number) => {
    const c = craft();
    report(world.set(c.entity, RigidBody, { mass: 125 + massKg }));
    world.set(c.cargo, Transform, { pos: [-0.9, 0.95, sideM] }).unwrap();
    world
      .set(c.cargo, Visibility, {
        state: massKg > 0 ? VisibilityStateValue.visible : VisibilityStateValue.hidden,
      })
      .unwrap();
    pendingCargoWakes.add(c.entity);
  };
  for (const id of ['cargo-mass', 'cargo-side'])
    node(id).addEventListener('change', () => {
      setCargo(
        Math.max(0, Math.min(180, Number(node<HTMLInputElement>('cargo-mass').value))),
        Math.max(-0.6, Math.min(0.6, Number(node<HTMLInputElement>('cargo-side').value))),
      );
      refreshControls();
    });
  node('boat-stop').addEventListener('click', () => {
    node<HTMLInputElement>('boat-throttle').value = '0';
    node<HTMLInputElement>('boat-steering').value = '0';
  });
  const applyPreset = (preset: 'calm' | 'head-on' | 'reentry' | 'loaded') => {
    selected = preset === 'head-on' ? 'ocean' : 'lake';
    patch({ enabled: true, applyDrag: true, applyRiverForces: true });
    setCargo(preset === 'loaded' ? 25 : 0, preset === 'loaded' ? 0.45 : 0);
    node<HTMLInputElement>('boat-throttle').value = '0';
    node<HTMLInputElement>('boat-steering').value = '0';
    const waves = preset === 'head-on' || preset === 'reentry';
    node<HTMLInputElement>('waves').checked = waves;
    for (const c of crafts)
      report(
        assets.update(c.bodyHandle, { waveSetGuid: guid(waves ? 'waves/estuary' : 'waves/off') }),
      );
    pendingMotion = {
      type: selected,
      launch: false,
      ...(preset === 'reentry' || preset === 'head-on' ? { preset } : {}),
    };
    node('phenomenon-hint').textContent = {
      calm: '平静水面观察水线。增加载荷会加深吃水；推进与船舵施加真实原生力。',
      'head-on':
        '船头迎向传播波。岸线泡沫随真实波面与岸坡交接变化；推进时观察接触尾迹、浮沉和横摇。',
      reentry: '一次把船抬到水面上方，随后自由下落。观察入水冲击、浮力恢复和阻尼。',
      loaded: '25 kg 货物位于右舷。总质量与偏置重力力矩改变两侧吃水，船体不做动画摆动。',
    }[preset];
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-boat-preset]'))
      button.setAttribute('aria-pressed', String(button.dataset.boatPreset === preset));
    refreshControls();
    setView('follow');
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-boat-preset]'))
    button.addEventListener('click', () =>
      applyPreset(button.dataset.boatPreset as Parameters<typeof applyPreset>[0]),
    );
  let nativeCpuMs: number | undefined;
  const releaseTiming = physics().observeNativeStepTiming?.((timing) => {
    nativeCpuMs = timing.timingMs.step;
  });
  app.pluginContext.effect(() => () => releaseTiming?.());
  const cameraControls = createWaterCameraControls({
    app,
    canvas,
    speedMps: 5,
    readPose: () => ({ eye, target }),
    writePose: (pose) => {
      eye = [...pose.eye];
      target = [...pose.target];
      applyCamera();
    },
    onNavigate: () => {
      selectedView = 'manual';
      refreshView();
    },
  });

  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR5MotionCommands',
        after: [PhysicsSync],
        before: [WaterBuoyancy, PhysicsSimulation],
        queries: [],
        fn: () => {
          for (const entity of pendingCargoWakes) {
            if (!physics().hasBody(entity)) continue;
            physics().wakeBody?.(entity).unwrap();
            pendingCargoWakes.delete(entity);
          }
          if (pendingMotion && world.hasResource(PhysicsWorldResource)) {
            const c = requireDemoValue(
                crafts.find(
                  (value) => value.type === requireDemoValue(pendingMotion, 'pendingMotion').type,
                ),
                'accepted authored scene member',
              ),
              initial = START_POSITIONS[c.type];
            const motion = physics().setBodyMotion?.(c.entity, {
              position:
                pendingMotion.launch || pendingMotion.preset === 'reentry'
                  ? [initial[0], 3, initial[2]]
                  : [...initial],
              rotation:
                pendingMotion.preset === 'head-on'
                  ? [0, Math.sqrt(0.9), 0, Math.sqrt(0.1)]
                  : [0, 0, 0, 1],
              linearVelocity:
                pendingMotion.preset === 'head-on'
                  ? [-1.6, 0, -1.2]
                  : pendingMotion.launch
                    ? [6, 0, 0]
                    : [0, 0, 0],
              angularVelocity: [0, 0, 0],
            });
            if (!motion)
              throw new Error('The selected physics backend requires body motion support');
            motion.unwrap();
            appendLog(`${pendingMotion.launch ? '发射' : '重置'} ${CRAFT_LABELS[c.type]}`);
            pendingMotion = undefined;
          }
          for (const c of crafts)
            applyBoatControls(physics(), c.entity, {
              throttle:
                c.type === selected ? Number(node<HTMLInputElement>('boat-throttle').value) : 0,
              steering:
                c.type === selected ? Number(node<HTMLInputElement>('boat-steering').value) : 0,
              cargoKg: Math.max(0, world.get(c.entity, RigidBody).unwrap().mass - 125),
              cargoPositionM: [...world.get(c.cargo, Transform).unwrap().pos] as Vector,
            });
        },
      }),
    )
    .unwrap();
  const debugPontoonCenter = vec3.create();
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR5CameraAndDebug',
        queries: [],
        fn: () => {
          updateTicks++;
          if (selectedView === 'follow') setView('follow');
          else updateCameraProjection();
          if (checked('pontoons'))
            for (const row of buoyancy().steps) {
              if (!row.result.ok) continue;
              for (const pontoon of row.result.value.pontoons) {
                debugPontoonCenter.set(pontoon.centerM);
                app.debugDraw?.sphere(
                  debugPontoonCenter,
                  pontoon.radiusM,
                  pontoon.enabled
                    ? pontoon.inWater
                      ? [0.1, 0.95, 0.65, 0.85]
                      : [1, 0.65, 0.15, 0.85]
                    : [0.45, 0.5, 0.52, 0.6],
                );
              }
            }
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR5CompletedEvidence',
        after: [WaterBuoyancyCompletion],
        queries: [],
        fn: () => {
          const state = buoyancy(),
            step = state.steps.find((value) => value.result.ok)?.result;
          if (step?.ok && step.value.physicsStep !== lastCompletedStep) {
            lastCompletedStep = step.value.physicsStep;
            history.push({ step: lastCompletedStep, state: { ...state } });
            if (history.length > 120) history.shift();
            for (const event of state.splashWakeEvents) eventCounts[event.phase]++;
          }
          if (pendingBoundary) {
            const action = pendingBoundary,
              c = requireDemoValue(
                crafts.find((value) => value.type === action.type),
                'accepted authored scene member',
              );
            const dynamics = physics().getCommittedBodyDynamics?.(c.entity),
              body = waterSceneSnapshot(world, c.waterEntity);
            const recordBoundary = () => {
              const selection = state.async.selections.find((value) => value.entity === c.entity);
              boundaryEvents.push({
                kind: action.kind,
                type: action.type,
                phase: action.phase,
                tick: world.getResource(FixedTime).tick,
                nativePresent: physics().hasBody(c.entity),
                ...(dynamics?.ok ? { nativeGeneration: dynamics.value.generation } : {}),
                ...(body ? { waterGeneration: body.sceneGeneration } : {}),
                ...(selection ? { selection } : {}),
              });
              if (boundaryEvents.length > 32) boundaryEvents.shift();
            };
            if (action.phase === 'retire') {
              recordBoundary();
              if (action.kind === 'root') {
                if (!dynamics?.ok)
                  throw new Error('A live native body is required for replacement');
                const rigidBody = { ...world.get(c.entity, RigidBody).unwrap() },
                  collider = snapshotCollider(world.get(c.entity, Collider).unwrap());
                world.removeComponent(c.entity, Collider).unwrap();
                world.removeComponent(c.entity, RigidBody).unwrap();
                pendingBoundary = {
                  ...action,
                  phase: 'retired',
                  generation: dynamics.value.generation,
                  restore: () => {
                    world
                      .addComponent(c.entity, { component: RigidBody, data: rigidBody })
                      .unwrap();
                    world.addComponent(c.entity, { component: Collider, data: collider }).unwrap();
                  },
                };
              } else {
                if (!body) throw new Error('A live Water body is required for replacement');
                const saved = { ...world.get(c.waterEntity, WaterBodyInstance).unwrap() };
                world.removeComponent(c.waterEntity, WaterBodyInstance).unwrap();
                pendingBoundary = {
                  ...action,
                  phase: 'retired',
                  generation: body.sceneGeneration,
                  restore: () => {
                    world
                      .addComponent(c.waterEntity, { component: WaterBodyInstance, data: saved })
                      .unwrap();
                  },
                };
              }
            } else if (action.phase === 'retired') {
              if (action.kind === 'root' ? physics().hasBody(c.entity) : body !== undefined) return;
              recordBoundary();
              action.restore();
              pendingBoundary = {
                kind: action.kind,
                type: action.type,
                phase: 'restored',
                generation: action.generation,
              };
            } else {
              const generation =
                action.kind === 'root'
                  ? dynamics?.ok
                    ? dynamics.value.generation
                    : undefined
                  : body?.sceneGeneration;
              if (generation === undefined || generation <= action.generation) return;
              recordBoundary();
              pendingBoundary = undefined;
              appendLog(`${action.kind === 'root' ? '刚体' : '水体'}代际已重建`);
            }
          }
        },
      }),
    )
    .unwrap();

  node('trace-rows').addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.index === undefined) return;
    const c = config(),
      enabled = c.enabledPontoons.length
        ? Array.from(c.enabledPontoons)
        : Array<number>(c.radiiM.length).fill(1);
    enabled[Number(input.dataset.index)] = input.checked ? 1 : 0;
    patch({ enabledPontoons: enabled });
  });
  const lastStep = (): WaterBuoyancyStep | undefined => {
    const row = buoyancy().steps.find((value) => value.entity === craft().entity)?.result;
    return row?.ok ? row.value : undefined;
  };
  const readState = () => ({
    completedFrames,
    receipt,
    updateTicks,
    errorCount,
    errors,
    selected,
    selectedView,
    cameraPose: {
      eye: [...eye],
      target: [...target],
      projectionOffset: world.get(camera, Camera).unwrap().projectionOffset,
    },
    settings,
    gpuSettings,
    buoyancy: buoyancy(),
    crafts: crafts.map((c) => ({
      type: c.type,
      entity: c.entity,
      waterEntity: c.waterEntity,
      configuration: world.get(c.entity, WaterPontoonSet).unwrap(),
      dynamics: physics().getCommittedBodyDynamics?.(c.entity),
      water: waterSceneSnapshot(world, c.waterEntity),
    })),
    renderer: app.renderer.inspect(),
    eventCounts: { ...eventCounts },
    log: [...log],
    retainedSteps: history.length,
    stressMode,
    queryComparison: compareQueries(),
    boundaryEvents,
  });
  const exportTrace = () => ({
    schemaVersion: 1,
    mode: 'gpu-water-mesh-worker-solver',
    capturedAt: new Date().toISOString(),
    ...readState(),
    history,
  });
  const exportTraceJson = () => JSON.stringify(exportTrace(), facts, 2);
  node('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportTraceJson()], { type: 'application/json' })),
      link = document.createElement('a');
    link.href = url;
    link.download = `water-r5-step-${lastCompletedStep}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  const refresh = () => {
    if (!world.hasResource(WATER_BUOYANCY_RESOURCE)) return;
    const state = buoyancy(),
      step = lastStep(),
      inspection = app.renderer.inspect({
        fields: ['state', 'capabilities', 'perFramePassNames', 'views', 'featureDiagnostics'],
      });
    const selection = state.async.selections.find((value) => value.entity === craft().entity);
    const dynamics = physics().getCommittedBodyDynamics?.(craft().entity);
    const body = dynamics?.ok ? dynamics.value : undefined;
    const refreshBoatDynamics = () => {
      node('boat-mass').textContent = `${fixed(body?.massKg, 1)} kg`;
      node('boat-speed').textContent =
        `${fixed(body ? Math.hypot(...body.linearVelocityMps) : undefined)} m/s`;
      const support = step?.pontoons.reduce((sum, pontoon) => sum + pontoon.buoyancyForceN[1], 0);
      node('boat-support').textContent =
        `${fixed(support, 0)} / ${fixed(body ? body.massKg * Math.hypot(...physics().getGravity()) : undefined, 0)} N`;
      const roll = body
        ? (Math.asin(Math.max(-1, Math.min(1, rotateWaterVector(body.rotation, [0, 0, 1])[1]))) *
            180) /
          Math.PI
        : undefined;
      node('boat-roll').textContent = `${fixed(roll, 1)} °`;
      node<HTMLSelectElement>('execution-mode').value =
        state.asyncEnabled && config().useAsyncPath ? 'worker' : 'sync';
      node('boat-path').textContent =
        !state.asyncEnabled || !config().useAsyncPath
          ? 'CPU 同步 / 原生 Physics'
          : selection
            ? 'Worker 异步 / 原生 Physics'
            : 'Worker 等待结果';
      node('navigation-speed').textContent = `${cameraControls.speedMps.toFixed(1)} m/s`;
      node('physics-cpu').textContent =
        (state.asyncEnabled && config().useAsyncPath) || nativeCpuMs === undefined
          ? state.asyncEnabled && config().useAsyncPath
            ? 'Worker 不提供'
            : '计时未启用'
          : `${nativeCpuMs.toFixed(2)} ms`;
    };
    refreshBoatDynamics();
    const refreshMeshPublication = () => {
      node('boat-mesh-path').textContent = settings.gpuMesh ? 'GPU 栅格' : 'CPU 四叉树';
      node('grid-size').textContent = '64 × 64';
      node('material-count').textContent = String(
        new Set(
          water()
            .snapshots()
            .flatMap((body) =>
              [
                body.asset.surfaceMaterialGuid,
                body.asset.riverToLakeTransitionMaterialGuid,
                body.asset.riverToOceanTransitionMaterialGuid,
              ].filter(Boolean),
            ),
        ).size,
      );
      node('mesh-passes').textContent = String(
        inspection.perFramePassNames.filter((name) => name.includes('water-gpu-')).length,
      );
      node('view-count').textContent = String(inspection.views?.length || (receipt ? 1 : 0));
      const rasterBodies = water()
        .snapshots()
        .filter(
          (body) =>
            body.asset.flags.affectsWaterMesh && body.asset.renderOptions?.visible !== false,
        );
      const gpuFeature = inspection.featureDiagnostics.find(
        (feature) => feature.identity === 'water-gpu-mesh',
      );
      const gpuPublished =
        gpuFeature?.status === 'active' &&
        !gpuFeature.latestError &&
        Array.isArray(gpuFeature.inspection) &&
        gpuFeature.inspection.length > 0;
      const meshPublished = settings.gpuMesh
        ? gpuPublished
        : rasterBodies.length > 0 &&
          rasterBodies.every((body) => body.outputs.waterMesh === 'ready');
      node('action-state').textContent =
        rasterBodies.length > 127 && settings.gpuMesh
          ? 'GPU 网格已拒绝：超过 127 个相交水体'
          : gpuFeature?.latestError && settings.gpuMesh
            ? JSON.stringify(gpuFeature.latestError, facts)
            : inspection.state !== 'alive'
              ? `渲染器：${inspection.state}`
              : !receipt || !meshPublished
                ? `等待 ${settings.gpuMesh ? 'GPU' : 'CPU'} 网格提交`
                : `${settings.gpuMesh ? 'GPU' : 'CPU'} 网格已提交 · ${receipt.frameId} 帧`;
      node('stress-count').textContent =
        `${rasterBodies.length} / ${new Set(rasterBodies.map((body) => body.asset.overlapPriority)).size}`;
      node('stress-state').textContent =
        rasterBodies.length > 127 ? '拒绝：超过 127' : rasterBodies.length ? '已接纳' : '等待';
    };
    refreshMeshPublication();
    node('execution').textContent =
      state.async.execution === 'worker-solver'
        ? '原生 Worker 求解'
        : state.async.execution === 'disabled'
          ? '同步求解'
          : '后端不支持';
    node('async-count').textContent = `${state.async.submitted} / ${state.async.completed}`;
    node('async-queue').textContent =
      `${state.async.pending} / ${state.async.cancelled} / ${state.async.rejected}`;
    const refreshSolverAndQueryReadout = () => {
      node('solver-step').textContent =
        `${selection?.sourceStep ?? '--'} → ${selection?.solveStep ?? '--'}`;
      node('solver-output').textContent =
        `${selection?.currentTaskId ?? '--'} / ${selection?.nextTaskId ?? '--'}`;
      node('solver-alpha').textContent = fixed(selection?.alpha, 3);
      node('backend').textContent = inspection.capabilities.backendKind;
      node('receipt-frame').textContent = String(receipt?.frameId ?? '--');
      node('receipt-generation').textContent =
        `${receipt?.deviceGeneration ?? '--'} / ${receipt?.graphGeneration ?? '--'}`;
      node('update-count').textContent = String(updateTicks);
      node('physics-step').textContent = String(dynamics?.ok ? dynamics.value.completedStep : '--');
      node('body-generation').textContent = String(dynamics?.ok ? dynamics.value.generation : '--');
      node('water-generation').textContent = String(
        waterSceneSnapshot(world, craft().waterEntity)?.sceneGeneration ?? '--',
      );
      node('velocity').textContent =
        `${fixed(dynamics?.ok ? Math.hypot(...dynamics.value.linearVelocityMps) : undefined)} m/s`;
      node('force').textContent = `${fixed(
        step?.pontoons.reduce((sum, p) => sum + p.buoyancyForceN[1], 0),
        1,
      )} N`;
      node('events').textContent =
        `${eventCounts.entered} / ${eventCounts.exited} / ${eventCounts.wake}`;
      node('error-count').textContent = String(errorCount);
      const advancedOpen = node('experience-advanced').closest<HTMLDetailsElement>('details')?.open;
      const refreshQueryComparison = () => {
        if (advancedOpen) {
          const comparison = compareQueries(),
            sync = comparison?.synchronous,
            safe = comparison?.solverSafe,
            spline = comparison?.splineDepth;
          node('query-source').textContent =
            `${sync?.ok ? sync.value.source : '--'} / ${safe?.ok ? safe.value.source : '--'}`;
          node('query-excluded').textContent =
            `${sync?.ok ? (sync.value.excluded ? '已排除' : '有效') : '--'} / ${safe?.ok ? (safe.value.excluded ? '已排除' : '有效') : '--'}`;
          node('query-height').textContent =
            `${fixed(sync?.ok ? sync.value.surfaceM?.[1] : undefined)} / ${fixed(safe?.ok ? safe.value.surfaceM?.[1] : undefined)}`;
          node('query-depth').textContent =
            `${fixed(sync?.ok ? sync.value.depthM : undefined)} / ${fixed(safe?.ok ? safe.value.depthM : undefined)}`;
          node('query-wave').textContent =
            `${fixed(sync?.ok ? sync.value.waveInfo?.heightM : undefined, 3)} / ${fixed(safe?.ok ? safe.value.waveInfo?.heightM : undefined, 3)}`;
          node('query-depth-source').textContent =
            `${fixed(spline?.ok ? spline.value.depthM : undefined)} / ${fixed(comparison?.terrain?.heightM)}`;
        }
      };
      refreshQueryComparison();
      return advancedOpen;
    };
    const advancedOpen = refreshSolverAndQueryReadout();
    node('frame-count').textContent = `${completedFrames} 帧`;
    node('scene-status').textContent =
      `${CRAFT_LABELS[selected]} · ${config().radiiM.length} 浮筒 · 完成步 ${dynamics?.ok ? dynamics.value.completedStep : '--'}`;
    node('trace-state').textContent =
      `${CRAFT_LABELS[selected]} · 步 ${step?.physicsStep ?? '--'} · 保留 ${history.length} 步`;
    if (advancedOpen) {
      const rows = node<HTMLTableSectionElement>('trace-rows'),
        pontoons = step?.pontoons ?? [];
      while (rows.rows.length > pontoons.length) rows.deleteRow(-1);
      pontoons.forEach((p, index) => {
        let tr = rows.rows[index];
        if (!tr) {
          tr = rows.insertRow();
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.dataset.index = String(index);
          input.setAttribute('aria-label', `启用浮筒 ${index + 1}`);
          tr.insertCell().append(input);
          for (let i = 0; i < 8; i++) tr.insertCell();
        }
        requireDemoValue(
          tr.querySelector<HTMLInputElement>('input'),
          'accepted authored scene member',
        ).checked = p.enabled;
        const body = crafts.find(
          (c) => waterSceneSnapshot(world, c.waterEntity)?.guid === p.selectedBodyGuid,
        )?.type;
        const values = [
          String(index + 1).padStart(2, '0'),
          body ? { river: '河道', lake: '湖面', ocean: '近海' }[body] : '--',
          fixed(p.immersionM),
          fixed(p.volumeM3, 3),
          fixed(p.coefficient, 4),
          fixed(p.dampingN, 1),
          fixed(p.buoyancyForceN[1], 1),
          p.result.ok ? (p.inWater ? '水中' : '离水') : p.result.error.code,
        ];
        values.forEach((value, i) => {
          requireDemoValue(
            requireDemoValue(tr, 'tr').cells[i + 1],
            'accepted authored scene member',
          ).textContent = value;
        });
      });
    }
  };
  let lastRefresh = 0;
  const completionTimes: number[] = [];
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') recordError(event.error);
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed
      .then((result) => {
        if (!result.ok) {
          recordError(result.error);
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
          const span = now - (completionTimes[0] ?? now);
          node('fps').textContent =
            span > 400
              ? `${(((completionTimes.length - 1) * 1000) / span).toFixed(1)} FPS`
              : '-- FPS';
          if (!errorCount) {
            node('render-state').textContent = '实时运行';
            node('live-dot').className = 'live-dot ready';
          }
          refresh();
          lastRefresh = now;
        }
      })
      .catch(recordError);
  });
  app.onError(recordError);
  Object.assign(window, {
    __waterR5: {
      app,
      world,
      assets,
      root,
      camera,
      secondCamera,
      crafts,
      errors,
      readState,
      exportTrace,
      exportTraceJson,
      setView,
      applyPreset,
      cameraControls,
      setMeshPath,
      setMeshSettings,
      updateMesh,
      setStress,
      compareQueries,
      updateQuerySources,
      cancel,
      boundary,
      setCameraPose: (pose: { eye: Vector; target: Vector }) => {
        if (![...pose.eye, ...pose.target].every(Number.isFinite))
          return err({ code: 'water-r5-camera-invalid' });
        eye = [...pose.eye];
        target = [...pose.target];
        selectedView = 'manual';
        applyCamera();
        refreshView();
        return ok(undefined);
      },
    },
  });
  Object.assign(window, { __waterR4: (window as unknown as { __waterR5: unknown }).__waterR5 });
  window.addEventListener('beforeunload', () => {
    cameraLayoutObserver.disconnect();
    void app.dispose();
  });
  refreshControls();
  appendLog('河口场景已接纳');
  const field = (id: string) =>
    requireDemoValue(node(id).closest<HTMLElement>('label'), `source control ${id}`);
  const group = (...ids: string[]) => {
    const section = document.createElement('section');
    section.className = 'toggle-list';
    section.append(...ids.map(field));
    return section;
  };
  const qualityControl = waterQualityControl((level) => {
    const resolution = [128, 256, 512, 1024][level] ?? 256;
    gpuSettings = {
      ...gpuSettings,
      supersampling: [1, 2, 4, 4][level] ?? 2,
      msaaSamples: level === 0 ? 1 : 4,
    };
    updateMesh({
      tessellationFactor: [4, 5, 6, 6][level] ?? 5,
      lodScale: [1.6, 2.4, 3, 4][level] ?? 2.4,
      waterInfo: {
        ...settings.waterInfo,
        resolution: { widthPx: resolution, heightPx: resolution },
      },
      ...(settings.gpuMesh ? { gpuMesh: gpuSettings } : {}),
    });
    node<HTMLSelectElement>('supersampling').value = String(gpuSettings.supersampling);
    node<HTMLSelectElement>('msaa').value = String(gpuSettings.msaaSamples);
    node<HTMLSelectElement>('tessellation').value = String(settings.tessellationFactor);
    node<HTMLInputElement>('lod-scale').value = String(settings.lodScale);
  }, 1);
  for (const [index, option] of [
    ...requireDemoValue(qualityControl.querySelector('select'), 'quality select').options,
  ].entries())
    option.textContent = `Q${index} · ${option.textContent}`;
  const cameraActions = document.createElement('section');
  cameraActions.className = 'water-actions';
  cameraActions.append(...document.querySelectorAll<HTMLButtonElement>('[data-view]'));
  const nativeActions = document.createElement('section');
  nativeActions.className = 'water-actions';
  nativeActions.append(node('reset'));
  const primaryBoat = group('craft', 'buoyancy', 'drag');
  primaryBoat.append(node('experience-boat'), nativeActions);
  const waterControls = group('waves', 'river-force');
  const qualityControls = document.createElement('section');
  qualityControls.append(
    qualityControl,
    field('mesh-path'),
    field('execution-mode'),
    field('pontoon-count'),
    field('multiview'),
  );
  const panel = node('controls-panel');
  const actionState = node('action-state');
  const oldControls = [...panel.children].filter(
    (element) => !['experience-presets', 'experience-readouts'].includes(element.id),
  );
  const advanced = document.createElement('section');
  advanced.id = 'experience-advanced';
  advanced.append(...oldControls, node('trace-panel'));
  arrangeWaterSettings({
    panel,
    title: '船艇航行',
    description:
      '操纵船艇、迎浪与装载货物。Worker 异步是同一船艇的求解设置；GPU/CPU 切换水面网格。泡沫来自水面材质与真实接触。',
    dimensions: [
      {
        title: '展示预设',
        elements: [node('experience-presets'), node('experience-readouts'), actionState],
        open: true,
      },
      {
        title: '船体与载荷',
        description: '质量、偏置货物、推进和舵直接参与固定步原生求解。',
        elements: [primaryBoat],
      },
      { title: '水况', elements: [waterControls] },
      {
        title: '画质与运行模式',
        description: '同一场景切换 Worker / 同步浮力与 GPU / CPU 网格。Q0–Q3 调整真实画质。',
        elements: [qualityControls],
      },
      { title: '相机', elements: [cameraActions] },
      { title: '高级 · 数值与诊断', elements: [advanced] },
    ],
  });
  invalidateCameraLayout();
  await dressWaterStage(app, [0, 0, 0], 1.4);
  stageRuntimePanel(
    app,
    requireDemoValue(document.getElementById('controls-panel'), 'accepted authored scene member'),
    'R5',
  );
  waterStageNavigation('R5');
  applyPreset('head-on');
  app.start().unwrap();
  applyCamera();
}
void main().catch((error: unknown) => {
  Object.assign(window, { __waterR4StartupError: error, __waterR5StartupError: error });
  node('render-state').textContent = '启动失败';
  node('live-dot').className = 'live-dot failed';
  node('scene-status').textContent =
    error instanceof Error ? error.message : JSON.stringify(error, facts);
  console.error(error);
});
