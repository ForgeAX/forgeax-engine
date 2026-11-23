import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, FixedUpdate, Time, Update } from '@forgeax/engine/ecs';
import { prepareRuntimePackContent } from '@forgeax/engine/import';
import { quat } from '@forgeax/engine/math';
import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  PhysicsSimulation,
  PhysicsSync,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { createProfiler } from '@forgeax/engine/profiler';
import {
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  perspective,
  renderFeatureTextureSource,
  ScreenSpaceReflection,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import {
  publishWaterRiverBake,
  WATER_SYSTEM_RESOURCE,
  WaterBuoyancy,
  WaterSceneReconcile,
  waterSceneSnapshot,
} from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterPontoonSet,
  WaterShallowCollider,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import type {
  AssetHandle,
  AssetPublicationEnvelope,
  WaterAdvancedSimulationSource,
} from '@forgeax/engine/types';
import {
  decodeWaterRiverBake,
  prepareWaterRiverBake,
  type WaterAdvancedRecipe,
  type WaterAdvancedSimulation,
  type WaterAdvancedTextureReadback,
  type WaterBakedQueryGrid,
  type WaterOceanPatchTextureReadback,
  WaterQueryFlags,
  type WaterSystem,
  waterAdvancedOutputNames,
  waterOceanPatchOutputNames,
} from '@forgeax/engine/water';
import { createWaterCameraControls } from '../../camera-controls';
import { dressWaterMuseum } from '../../museum-presentation';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { runtimeForm, runtimeObjectFields } from '../../runtime-form';
import { requireDemoValue } from '../../runtime-input';
import { arrangeWaterSettings, waterQualityControl } from '../../settings-panel';
import { waterStageNavigation } from '../../stage-catalog';
import { WATER_R7_BAKE_PACKAGE, WATER_R7_PACKAGE, WATER_R7_SCOPE } from './identity';
import { loadBakeSnapshot, saveBakeSnapshot } from './storage';
import './style.css';
import '../../settings-panel.css';

type Mode = 'shallow' | 'river' | 'ocean';
type Vector = [number, number, number];
type Recipe = WaterAdvancedSimulationSource & { readonly kind: 'water-simulation-recipe' };
const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing ${id}`);
  return value as T;
};
const checked = (id: string) => node<HTMLInputElement>(id).checked;
const worldWaterHeight = () => Number(node<HTMLSelectElement>('water-height').value);
const fixed = (value: number | undefined, digits = 2) =>
  value === undefined ? '--' : value.toFixed(digits);
const labels = { shallow: '浅水交互', river: '河流烘焙', ocean: '海面 FFT' };
const stageLabels: Record<string, string> = {
  'Create Vertices': '创建顶点',
  'Create Triangles': '创建三角形',
  Init: '初始化',
  'Init Foam': '初始化泡沫',
  'Pre Sim': '预模拟',
  'River Source and Sink': '源汇注入',
  'Distribute Overlap Volume': '分配排水体积',
  'Extrapolate Velocities': '速度外推',
  'Advect Water': '水体平流',
  'Extrapolate Height': '高度外推',
  'Update Velocity': '更新速度',
  'Update Depth': '更新深度',
  'Post Sim': '后模拟',
  'Compute Normals': '计算法线',
  'Prep Debug': '准备调试场',
  'Prep Debug Beauty': '准备表面场',
  Foam: '更新泡沫',
  'Live Sim - Blur Normals': '平滑法线',
};
const textureLabel = (name: string) => {
  const suffix = name.replace(/^water-(advanced|ocean)-[a-f0-9]{64}-/, '');
  const outputs: Record<string, string> = {
    grid: '最终高度与流速',
    normal: '最终法线',
    foam: '最终泡沫',
    mapping: '世界映射',
    ocean: '海面法线与高度',
    'river-bake': '河流烘焙场',
    'fft-frequency-complex': '初始频谱',
  };
  if (outputs[suffix]) return outputs[suffix];
  const shallow = /^shallow-(\d+)-(.+?)-(render-grid|grid|field|foam|normal)$/.exec(suffix);
  if (shallow) {
    const stage = Object.entries(stageLabels).find(
      ([key]) => key.toLowerCase().replaceAll(' ', '-') === shallow[2],
    );
    return `${Number(shallow[1]) + 1} · ${stage?.[1] ?? '模拟阶段'} · ${{ grid: '水体', field: '碰撞', foam: '泡沫', normal: '法线', 'render-grid': '渲染水体' }[requireDemoValue(shallow[3], 'accepted authored scene member')]}`;
  }
  const fft = /^fft-waves-pt[12]-([xy])-radix-(\d+)-complex$/.exec(suffix);
  return fft
    ? `${requireDemoValue(fft[1], 'accepted authored scene member').toUpperCase()} 轴 · 蝶形跨度 ${fft[2]}`
    : '已完成纹理';
};
const centers = { shallow: -32, river: 0, ocean: 32 };
const jsonFacts = (_key: string, value: unknown) =>
  value instanceof Set
    ? [...value]
    : value instanceof Map
      ? Object.fromEntries(value)
      : ArrayBuffer.isView(value)
        ? Array.from(value as unknown as ArrayLike<number>)
        : value;

async function main() {
  const canvas = node<HTMLCanvasElement>('scene');
  const diagnostics = new URLSearchParams(location.search);
  const profiler = diagnostics.has('cpu-profile') ? createProfiler() : undefined;
  const app = (
    await createApp(
      canvas,
      {
        // The accepted 249-observation 64² River + 128² FFT roster is
        // 17,629,184 aligned bytes per flight. Reserve for at most four overlapping
        // retained flights; no roster may allocate before this aggregate cap.
        featureTextureReadbackBudgetBytes: 17_629_184 * 4,
        ...(profiler ? { profiler } : {}),
        ...(diagnostics.has('gpu-timing') ? { gpuPassTiming: {} } : {}),
        plugins: [physics3d],
        pointerLockAllowed: () => false,
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
        ...(__WATER_R7_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R7_SSR_IDENTITY__ }),
        pluginPrograms: {
          sessionId: crypto.randomUUID(),
          contextId: 'water-r7',
          sessionGeneration: 1,
          target: 'engine',
          tools: new Map(),
          definitions: new Map(),
          programs: new Map(),
        },
        runtimePacks: { scopeId: runtimeBinding?.scopeId ?? WATER_R7_SCOPE },
        time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const { world } = app,
    assets = app.assets;
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  if (!assets) throw new Error('Assets unavailable');
  const runtime = app.pluginContext.get('runtimePacks');
  if (!runtime) throw new Error('Runtime Pack owner unavailable');
  const errors: unknown[] = [];
  const message = (text: string) => {
    const element = node('message');
    element.textContent = text;
    element.hidden = false;
  };
  const report = (error: unknown) => {
    errors.push(error);
    if (errors.length > 32) errors.shift();
    console.error(error);
    message(
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : String(error),
    );
  };
  app.onError(report);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R7_PACKAGE, key));
  const bakeGuid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R7_BAKE_PACKAGE, key));
  const version = (handle: AssetHandle) => {
    const source = assets.source(handle).unwrap();
    return (
      source?.publication?.outputs.find((output) => output.guid === source.guid)?.digest ??
      String(assets.revision(handle).unwrap())
    );
  };
  const bindSimulationMaterial = (
    material: AssetHandle<'material'>,
    mode: Mode,
    bodyIdentity: string,
    oceanDetail = false,
  ) => {
    const names = waterAdvancedOutputNames(
      bodies.find((body) => body.mode === mode)?.recipeGuid ?? guid(`recipe/${mode}`),
      bodyIdentity,
      world.identity,
    );
    const source = (name: string) => ({ source: renderFeatureTextureSource(name) });
    const oceanNames = waterOceanPatchOutputNames(
      water().oceanPatch()?.recipe.guid ?? guid('recipe/ocean'),
      world.identity,
    );
    const oceanSources = { waterOceanPatchTexture: source(oceanNames.materialNormal) };
    assets
      .update(material, {
        values: {
          ...assets.read(material).unwrap().values,
          ...(mode === 'ocean'
            ? oceanSources
            : {
                waterShallowGridTexture: source(names.materialGrid),
                waterShallowNormalTexture: source(names.materialNormal),
                waterShallowFoamTexture: source(names.foam),
                waterShallowMappingTexture: source(names.mapping),
              }),
          ...(oceanDetail ? oceanSources : {}),
        },
      })
      .unwrap();
  };
  let restored = false,
    bakeOrigin = '实时场',
    bakeVersion = '--',
    bakeStatus = '尚未烘焙';
  try {
    const saved = await loadBakeSnapshot();
    if (saved !== undefined) {
      (
        await runtime.producer.restore(saved as Parameters<typeof runtime.producer.restore>[0])
      ).unwrap();
      restored = true;
      bakeOrigin = '冷启动恢复';
      bakeStatus = '已恢复';
    }
  } catch (error) {
    report(error);
  }
  const meshes = Object.fromEntries(
    await Promise.all(
      ['box', 'sphere', 'capsule', 'df-sphere', 'ring'].map(async (key) => [
        key,
        (await assets.load(guid(`mesh/${key}`), 'mesh')).unwrap(),
      ]),
    ),
  ) as Record<string, AssetHandle<'mesh'>>;
  const materials = Object.fromEntries(
    await Promise.all(
      ['stone', 'edge', 'red', 'yellow', 'teal', 'white', 'metal', 'wood', 'brass'].map(
        async (key) => [key, (await assets.load(guid(`material/${key}`), 'material')).unwrap()],
      ),
    ),
  ) as Record<string, AssetHandle<'material'>>;
  const spawn = (
    mesh: string,
    material: string,
    pos: Vector,
    scale: Vector,
    rotation: Vector | undefined = undefined,
  ) =>
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos,
            scale,
            ...(rotation ? { quat: quat.fromEuler(quat.create(), ...rotation, 'XYZ') } : {}),
          },
        },
        {
          component: MeshFilter,
          data: { assetHandle: requireDemoValue(meshes[mesh], 'accepted authored scene member') },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [requireDemoValue(materials[material], 'accepted authored scene member')],
          },
        },
      )
      .unwrap();
  const terrain = (await assets.load(guid('terrain/reach/terrain'), 'terrain')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [-56, 0, -28] } },
      { component: Terrain, data: { asset: terrain } },
      { component: WaterTerrainProvider, data: { terrain } },
    )
    .unwrap();
  const zone = (await assets.load(guid('zone/reach'), 'water-zone')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterZoneInstance, data: { zone } },
    )
    .unwrap();
  const bodies = await Promise.all(
    (['shallow', 'river', 'ocean'] as const).map(async (mode) => {
      const body = (await assets.load(guid(`body/${mode}`), 'water-body')).unwrap();
      const material = (await assets.load(guid(`material/water/${mode}`), 'material')).unwrap();
      const recipe = (
        await assets.load(guid(`recipe/${mode}`), 'water-simulation-recipe')
      ).unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [centers[mode], 0, 0] } },
          { component: WaterBodyInstance, data: { body } },
        )
        .unwrap();
      for (const side of [-1, 1]) {
        spawn('box', 'stone', [centers[mode] + side * 13.8, -0.8, 0], [1.4, 3.4, 32]);
        spawn('box', 'edge', [centers[mode] + side * 13.8, 0.95, 0], [1.6, 0.14, 32]);
        spawn('box', 'stone', [centers[mode], -0.8, side * 15.8], [26, 3.4, 1.4]);
        spawn('box', 'edge', [centers[mode], 0.95, side * 15.8], [26, 0.14, 1.6]);
      }
      for (let i = 0; i < 9; i++) {
        spawn('box', 'edge', [centers[mode] - 10 + i * 2.5, -2.45, 0], [0.035, 0.035, 28]);
        spawn('box', 'edge', [centers[mode], -2.45, -12 + i * 3], [24, 0.035, 0.035]);
      }
      for (let i = 0; i < 4; i++) {
        const x = centers[mode] - 8 + i * 5.2;
        spawn('box', 'stone', [x, 1.2, -11], [0.7, 4.8, 0.7]);
        spawn('box', 'brass', [x, 3.65, -11], [0.82, 0.1, 0.82]);
        spawn('box', i % 2 === 0 ? 'red' : 'yellow', [x, 2.5, -10.63], [0.3, 0.5, 0.035]);
        for (let tick = 0; tick < 12; tick++)
          spawn(
            'box',
            'brass',
            [x, -0.6 + tick * 0.28, -10.63],
            [tick % 3 === 0 ? 0.4 : 0.2, 0.025, 0.04],
          );
        spawn('box', 'white', [x, 0.2, -11], [0.74, 0.3, 0.74]);
      }
      for (let j = 0; j < 22; j++)
        spawn('box', 'wood', [centers[mode] + 8, 0.9, 2 + j * 0.36], [3, 0.18, 0.3]);
      for (let j = 0; j < 12; j++) {
        spawn('box', 'brass', [centers[mode] - 13, 0.98, -13 + j * 2.4], [0.45, 0.05, 0.08]);
        spawn('box', 'wood', [centers[mode] + 13.8, 1.55, -13 + j * 2.4], [0.12, 1.1, 0.12]);
      }
      spawn('box', 'brass', [centers[mode] + 13.8, 2.1, 0], [0.07, 0.07, 29]);
      return {
        mode,
        entity,
        asset: body,
        material,
        recipe,
        recipeGuid: guid(`recipe/${mode}`),
        simulation: undefined as WaterAdvancedSimulation | undefined,
        bindingKey: mode as string,
        materialBindingIdentity: '',
        restoredGeneration: 0,
      };
    }),
  );
  const rigidRecipes = new Map(
    await Promise.all(
      ['simple', 'accurate', 'distance-field', 'water-height', 'disabled'].map(async (path) => {
        const recipeGuid = guid(path === 'simple' ? 'recipe/shallow' : `recipe/shallow-${path}`);
        return [
          path,
          {
            guid: recipeGuid,
            handle: (await assets.load(recipeGuid, 'water-simulation-recipe')).unwrap(),
          },
        ] as const;
      }),
    ),
  );
  const shallowConfig = requireDemoValue(
    (
      assets
        .read(
          requireDemoValue(
            bodies.find((body) => body.mode === 'shallow'),
            "bodies.find((body) => body.mode === 'shallow')",
          ).recipe,
        )
        .unwrap() as Recipe
    ).shallowStageConfig,
    'accepted authored scene member',
  );
  const shallowCellM = shallowConfig.extentM[0] / shallowConfig.gridResolution[0];
  const rigidDefinitions = [
    {
      group: 'rotation',
      mesh: 'box',
      material: 'red',
      position: [-35, -0.1, -2] as Vector,
      scale: [3, 1.2, 0.9] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'rotation',
      mesh: 'capsule',
      material: 'yellow',
      position: [-29, -0.1, 2] as Vector,
      scale: [1, 1, 1] as Vector,
      shape: ColliderShapeValue.capsule,
      radius: 0.5,
      halfHeight: 1,
    },
    {
      group: 'bounds',
      mesh: 'box',
      material: 'teal',
      position: [-36, 0.1, 4] as Vector,
      scale: [1.5, 1.8, 2] as Vector,
    },
    {
      group: 'distance-field',
      mesh: 'df-sphere',
      material: 'teal',
      position: [-28, 0, -4] as Vector,
      scale: [1.8, 0.75, 1.25] as Vector,
      shape: ColliderShapeValue.sphere,
      radius: 1,
    },
    {
      group: 'distance-field',
      mesh: 'box',
      material: 'yellow',
      position: [-32, 0, -5] as Vector,
      scale: [1.2, 1.5, 1.2] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'ties',
      mesh: 'sphere',
      material: 'white',
      position: [-32, 0, 5] as Vector,
      scale: [0.7, 0.7, 0.7] as Vector,
      shape: ColliderShapeValue.sphere,
      radius: 1,
    },
    {
      group: 'ties',
      mesh: 'capsule',
      material: 'red',
      position: [-32, 0, 5] as Vector,
      scale: [1.4, 1, 1.4] as Vector,
      shape: ColliderShapeValue.capsule,
      radius: 0.5,
      halfHeight: 1,
    },
    {
      group: 'ties',
      mesh: 'box',
      material: 'metal',
      position: [-32, 0, 5] as Vector,
      scale: [1.4, 1.4, 1.4] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'height',
      mesh: 'box',
      material: 'teal',
      position: [-36, 4, 0] as Vector,
      scale: [0.4, 0.4, 0.4] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'height',
      mesh: 'box',
      material: 'yellow',
      position: [-32, 2.5, 0] as Vector,
      scale: [0.4, 0.4, 0.4] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'height',
      mesh: 'box',
      material: 'red',
      position: [-28, 7, 0] as Vector,
      scale: [0.4, 0.4, 0.4] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
    {
      group: 'height',
      mesh: 'box',
      material: 'white',
      position: [-34, 4 + shallowCellM / 4, 3] as Vector,
      scale: [1, shallowCellM / 8, 1] as Vector,
      shape: ColliderShapeValue.cuboid,
      halfExtents: [0.5, 0.5, 0.5] as Vector,
    },
  ];
  const rigidFixtures = rigidDefinitions.map((definition) => {
    const entity = spawn(
      definition.mesh,
      definition.material,
      definition.position,
      definition.scale,
    );
    world
      .addComponent(entity, {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.kinematic, gravityScale: 0 },
      })
      .unwrap();
    if (definition.shape !== undefined)
      world
        .addComponent(entity, {
          component: Collider,
          data: {
            shape: definition.shape,
            ...('radius' in definition ? { radius: definition.radius } : {}),
            ...('halfHeight' in definition ? { halfHeight: definition.halfHeight } : {}),
            ...('halfExtents' in definition ? { halfExtents: definition.halfExtents } : {}),
          },
        })
        .unwrap();
    world
      .addComponent(entity, {
        component: WaterShallowCollider,
        data: { enabled: definition.group === 'rotation' },
      })
      .unwrap();
    return { ...definition, entity };
  });
  const pawn = spawn('sphere', 'yellow', [-32, 0.15, 0], [1.2, 1.2, 1.2]);
  // The motion specimen remains kinematic; a button launch hands the same
  // ordinary body to native dynamics instead of injecting a fictitious hit.
  world
    .addComponent(pawn, {
      component: RigidBody,
      data: {
        type: RigidBodyTypeValue.kinematic,
        mass: 9000,
        ccdEnabled: true,
      },
    })
    .unwrap();
  world
    .addComponent(pawn, {
      component: Collider,
      data: {
        shape: ColliderShapeValue.sphere,
        radius: 1,
        restitution: 0.25,
      },
    })
    .unwrap();
  world.addComponent(pawn, { component: CollidingEntities, data: { entities: [] } }).unwrap();
  world.addComponent(pawn, { component: WaterShallowCollider, data: { enabled: true } }).unwrap();
  world
    .addComponent(pawn, {
      component: WaterPontoonSet,
      data: {
        enabled: false,
        anchorsM: [0, 0, 0],
        radiiM: [1.2],
        buoyancyCoefficientNPerM3: 9810,
        maxBuoyantForceN: 100000,
        dampingNPerMps: 1200,
        applyDrag: true,
      },
    })
    .unwrap();
  const basinFloor = world
    .spawn(
      { component: Transform, data: { pos: [-32, -2.8, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [13, 0.2, 15] },
      },
    )
    .unwrap();
  let pawnDynamic = false;
  let pawnRadiusM = 1.2;
  let pendingPawnLaunch: Vector | undefined;
  let pawnImpactStep = -1;
  let pawnPriorBottom: number | undefined;
  let pawnContactBodies: number[] = [];
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'waterR7NativePawnLaunch',
        after: [PhysicsSync],
        before: [WaterBuoyancy, PhysicsSimulation],
        queries: [],
        fn: () => {
          if (!pendingPawnLaunch) return;
          const owner = world.getResource<PhysicsWorld>(PhysicsWorldResource);
          if (!owner.getCommittedBodyDynamics?.(pawn).ok || !owner.setBodyMotion) return;
          owner
            .setBodyMotion(pawn, {
              position: pendingPawnLaunch,
              rotation: [0, 0, 0, 1],
              linearVelocity: [1.5, -2, 0],
              angularVelocity: [0, 0, 0],
            })
            .unwrap();
          pendingPawnLaunch = undefined;
        },
      }),
    )
    .unwrap();
  const sourceMarker = spawn('ring', 'teal', [0, 0.25, -10], [1.1, 1.1, 1.1], [Math.PI / 2, 0, 0]);
  const sinkMarker = spawn('ring', 'red', [0, 0.25, 10], [1.1, 1.1, 1.1], [Math.PI / 2, 0, 0]);
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.45, -0.8, -0.3],
        color: [1, 0.96, 0.88],
        intensity: 2.8,
        castShadow: false,
      },
    })
    .unwrap();
  world
    .spawn({ component: Skylight, data: { color: [0.65, 0.82, 0.92], intensity: 1.25 } })
    .unwrap();
  let mode: Mode = 'shallow',
    selectedView = 'middle';
  let eye: Vector = [-18, 9, 18],
    target: Vector = [-32, 0, 0];
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 3.3,
            aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
            near: 0.08,
            far: 350,
          }),
          clearColor: [0.67, 0.81, 0.83, 1],
          antialias: ANTIALIAS_TAA,
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
      {
        component: ScreenSpaceReflection,
        data: { maxDistance: 80, thickness: 0.25, maxRoughness: 0.7 },
      },
    )
    .unwrap();
  const applyCamera = () =>
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
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
  const setView = (view: string) => {
    selectedView = view;
    const x = centers[mode],
      height = mode === 'shallow' ? worldWaterHeight() : 0;
    target = [x, height + (view === 'near' ? 0.1 : 0), 0];
    eye =
      view === 'near'
        ? [x + 7, height + 2.3, 10]
        : view === 'far'
          ? [x + 32, height + 32, 44]
          : [x + 12, height + 7.5, 17];
    applyCamera();
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    });
  };
  const active = () =>
    requireDemoValue(
      bodies.find((value) => value.mode === mode),
      'accepted authored scene member',
    );
  const readbacks = (selected: Mode = mode) =>
    selected === 'ocean'
      ? (water().oceanPatch()?.textureReadbacks() ?? [])
      : (bodies.find((body) => body.mode === selected)?.simulation?.textureReadbacks() ?? []);
  let completedFrames = 0,
    receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'> | undefined;
  let impactId = 1,
    time = 0,
    lastMovingImpact = -1,
    bakePublishing = false;
  const operations: {
    name: string;
    mode: Mode;
    requestedFrame: number;
    requestedSequence: number;
    completion?: unknown;
  }[] = [];
  const operation = (name: string, selected: Mode = mode) => {
    const owner =
      selected === 'ocean'
        ? water().oceanPatch()
        : bodies.find((value) => value.mode === selected)?.simulation;
    operations.push({
      name,
      mode: selected,
      requestedFrame: receipt?.frameId ?? 0,
      requestedSequence: owner?.inspect().submittedSequence ?? 0,
    });
    if (operations.length > 64) operations.shift();
  };
  const noiseHandle = (await assets.load(guid('texture/ocean-phase'), 'texture')).unwrap();
  const materialVariants = new Map(
    await Promise.all(
      (
        [
          'shallow',
          'shallow-off',
          'river',
          'river-off',
          'river-fft',
          'ocean',
          'ocean-active',
        ] as const
      ).map(async (name) => {
        const existing = bodies.find((body) => body.mode === name)?.material;
        const handle =
          existing ?? (await assets.load(guid(`material/water/${name}`), 'material')).unwrap();
        return [name, handle] as const;
      }),
    ),
  );
  let acceptedBake: AssetPublicationEnvelope | undefined = runtime.producer.rows()[0]?.publication;
  let loadedBake: Recipe | undefined;
  const publishBaked = async () => {
    const body = requireDemoValue(
      bodies.find((value) => value.mode === 'river'),
      'accepted authored scene member',
    );
    const handle = (await assets.load(bakeGuid('river/baked'), 'water-simulation-recipe')).unwrap();
    try {
      const accepted = assets.source(handle).unwrap()?.publication,
        current = assets.catalogEntry(bakeGuid('river/baked'))?.publication;
      if (
        accepted?.generation !== current?.generation ||
        accepted?.digest !== current?.digest ||
        accepted?.outputSetDigest !== current?.outputSetDigest
      )
        (await assets.reload(handle, { conflict: 'overwrite' })).unwrap();
      const recipe = assets.read(handle).unwrap() as Recipe;
      const metadata = recipe.riverBakeConfig?.bakedGrid;
      if (!metadata) throw new Error('Published Bake metadata unavailable');
      const gridTextureHandle = (await assets.load(metadata.textureGuid, 'texture')).unwrap();
      let normalTextureHandle: typeof gridTextureHandle | undefined;
      try {
        const gridTextureSource = assets.source(gridTextureHandle).unwrap();
        if (!gridTextureSource)
          throw new Error('Loaded River Bake grid texture has no Runtime source identity');
        const loadedGrid = {
          kind: 'loaded-texture-asset' as const,
          handle: gridTextureHandle,
          guid: gridTextureSource.guid,
          revision: assets.revision(gridTextureHandle).unwrap(),
          asset: assets.read(gridTextureHandle).unwrap(),
        };
        let grid: WaterBakedQueryGrid;
        if (metadata.version === 'water-river-bake/2') {
          normalTextureHandle = (await assets.load(metadata.normalTextureGuid, 'texture')).unwrap();
          const normalTextureSource = assets.source(normalTextureHandle).unwrap();
          if (!normalTextureSource)
            throw new Error(
              'Loaded River Bake solver-normal texture has no Runtime source identity',
            );
          const loadedNormal = {
            kind: 'loaded-texture-asset' as const,
            handle: normalTextureHandle,
            guid: normalTextureSource.guid,
            revision: assets.revision(normalTextureHandle).unwrap(),
            asset: assets.read(normalTextureHandle).unwrap(),
          };
          grid = decodeWaterRiverBake(recipe, {
            version: 'water-river-bake/2',
            grid: loadedGrid,
            normal: loadedNormal,
          }).unwrap();
        } else
          grid = decodeWaterRiverBake(recipe, {
            version: 'water-river-bake/1',
            grid: loadedGrid,
          }).unwrap();
        const snapshot = waterSceneSnapshot(world, body.entity);
        if (!snapshot) return;
        const published = normalTextureHandle
          ? publishWaterRiverBake(
              world,
              snapshot.guid,
              snapshot.sceneGeneration,
              grid,
              normalTextureHandle,
            )
          : water().publishBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration, {
              kind: 'durable-pack',
              enabled: true,
              componentValid: true,
              dataValid: true,
              grid,
            });
        published.unwrap();
        loadedBake = recipe;
        body.restoredGeneration = snapshot.sceneGeneration;
        bakeVersion = normalTextureHandle
          ? `${version(gridTextureHandle)} / ${version(normalTextureHandle)}`
          : version(gridTextureHandle);
      } finally {
        if (normalTextureHandle) assets.release(normalTextureHandle).unwrap();
        assets.release(gridTextureHandle).unwrap();
      }
    } finally {
      assets.release(handle).unwrap();
    }
  };
  const persistBake = async () => {
    bakePublishing = true;
    node('retry-save').hidden = true;
    let saved = false;
    try {
      bakeStatus = '已发布，正在保存';
      await saveBakeSnapshot(runtime.producer.snapshot());
      saved = true;
      await publishBaked();
      bakeStatus = '已持久化';
      bakeOrigin = restored ? '恢复后重新烘焙' : 'GPU 烘焙';
      restored = false;
    } catch (error) {
      bakeStatus = saved ? '已保存，查询仍旧版' : '已发布，保存失败，查询仍旧版';
      node('retry-save').hidden = false;
      report(error);
    } finally {
      bakePublishing = false;
    }
  };
  const publishCapture = async (simulation: WaterAdvancedSimulation) => {
    bakePublishing = true;
    bakeStatus = '正在发布';
    const request = simulation.inspect().bake.request;
    try {
      const candidate = prepareWaterRiverBake(simulation, WATER_R7_BAKE_PACKAGE).unwrap();
      const body = requireDemoValue(
        bodies.find((value) => value.mode === 'river'),
        'accepted authored scene member',
      );
      const bodySource = assets.source(body.asset).unwrap();
      const bodyDigest = bodySource?.publication?.outputs.find(
        (output) => output.guid === guid('body/river'),
      )?.digest;
      if (!bodyDigest) throw new Error('Body publication evidence unavailable');
      const content = (
        await prepareRuntimePackContent(
          PackageId.format(WATER_R7_BAKE_PACKAGE),
          {
            [candidate.sourceKey]: candidate.recipe,
            [candidate.gridTextureSourceKey]: candidate.gridTexture,
            [candidate.normalTextureSourceKey]: candidate.normalTexture,
          },
          { dependencies: { [guid('body/river')]: bodyDigest } },
        )
      ).unwrap();
      const previous = runtime.producer
        .rows()
        .find((row) => row.guid === bakeGuid(candidate.sourceKey))?.publication;
      const published = (
        await (previous
          ? runtime.producer.replace(content, {
              generation: previous.generation,
              digest: previous.digest,
            })
          : runtime.producer.admit(content))
      ).unwrap();
      acceptedBake = published.publication;
      simulation.finishBake(request);
      operation('Bake publication', 'river');
      await persistBake();
      body.restoredGeneration = waterSceneSnapshot(world, body.entity)?.sceneGeneration ?? 0;
    } catch (error) {
      simulation.finishBake(
        request,
        simulation.failure(
          'water-advanced-bake-unavailable',
          'validated durable Pack publication before changing the query source',
          error,
        ),
      );
      bakeStatus = '发布失败';
      report(error);
    } finally {
      bakePublishing = false;
    }
  };
  let restoring = false;
  const waterR7SimulationInputs = defineSystem({
    name: 'waterR7SimulationInputs',
    after: [WaterSceneReconcile],
    queries: [],
    fn: () => {
      const clock = world.getResource(Time);
      time = clock.elapsed;
      for (const body of bodies) {
        const snapshot = waterSceneSnapshot(world, body.entity);
        if (!snapshot) continue;
        const reconcileSimulationBinding = () => {
          if (
            body.mode === 'shallow' &&
            body.simulation?.inspect().status === 'retired' &&
            checked('pawn-contact') &&
            checked('shallow-enabled')
          ) {
            water().removeAdvancedSimulation(body.simulation);
            body.simulation = undefined;
          }
          if (
            body.mode !== 'ocean' &&
            (body.simulation?.body.generation !== snapshot.sceneGeneration ||
              body.simulation?.recipe.contentVersion !== version(body.recipe))
          ) {
            if (body.simulation) water().removeAdvancedSimulation(body.simulation);
            const asset = assets.read(body.recipe).unwrap() as Recipe;
            const recipe: WaterAdvancedRecipe = {
              guid: body.recipeGuid,
              contentVersion: version(body.recipe),
              asset,
            };
            body.simulation = water().createAdvancedSimulation(recipe, snapshot.guid).unwrap();
          }
          const selectSimulationVariant = () => {
            const variant =
              body.mode === 'ocean'
                ? water().oceanPatch() && checked('ocean-enabled')
                  ? 'ocean-active'
                  : 'ocean'
                : !checked(`${body.mode}-enabled`)
                  ? `${body.mode}-off`
                  : body.mode === 'river' &&
                      checked('river-detail') &&
                      water().oceanPatch() &&
                      checked('ocean-enabled')
                    ? 'river-fft'
                    : body.mode;
            return variant;
          };
          const variant = selectSimulationVariant();
          const bindingIdentity = `${snapshot.guid}:${body.recipeGuid}:${variant}:${variant === 'ocean-active' || variant === 'river-fft' ? (water().oceanPatch()?.recipe.guid ?? '') : ''}`;
          if (body.materialBindingIdentity !== bindingIdentity) {
            const selected = requireDemoValue(
              materialVariants.get(variant as Parameters<typeof materialVariants.get>[0]),
              'accepted authored scene member',
            );
            if (!variant.endsWith('-off') && variant !== 'ocean')
              bindSimulationMaterial(selected, body.mode, snapshot.guid, variant === 'river-fft');
            body.materialBindingIdentity = bindingIdentity;
          }
          if (body.bindingKey !== variant) {
            assets
              .update(body.asset, {
                surfaceMaterialGuid: guid(`material/water/${variant}`),
                lodMaterialGuid: guid(`material/water/${variant}`),
              })
              .unwrap();
            body.bindingKey = variant;
          }
        };
        reconcileSimulationBinding();
        if (body.mode === 'ocean') {
          water().oceanPatch()?.update(clock.delta).unwrap();
          continue;
        }
        const simulation = requireDemoValue(body.simulation, 'accepted authored scene member');
        simulation.setEnabled(checked(`${body.mode}-enabled`));
        if (simulation.inspect().status === 'retired') continue;
        const updatePawnSimulation = () => {
          const contact = checked('pawn-contact');
          const scriptedPawnPosition: Vector = [
            -32 + 4 * Math.sin(time * 0.45),
            worldWaterHeight() + (contact ? 0.15 : 4),
            3 * Math.cos(time * 0.45),
          ];
          const nativePawn = world
            .getResource<PhysicsWorld>(PhysicsWorldResource)
            .getCommittedBodyDynamics?.(pawn);
          const pawnPosition: Vector =
            pawnDynamic && nativePawn?.ok ? [...nativePawn.value.positionM] : scriptedPawnPosition;
          const pawnVelocity: Vector =
            pawnDynamic && nativePawn?.ok
              ? [...nativePawn.value.linearVelocityMps]
              : checked('pawn-motion')
                ? [1.8 * Math.cos(time * 0.45), 0, -1.35 * Math.sin(time * 0.45)]
                : [0, 0, 0];
          const moving = pawnDynamic || checked('pawn-motion');
          const centerXZ: readonly [number, number] =
            body.mode === 'shallow' && checked('patch-follow')
              ? [pawnPosition[0], pawnPosition[2]]
              : [centers[body.mode], 0];
          simulation
            .update({
              deltaSeconds: clock.delta,
              timeSeconds: time,
              centerXZ,
              yawRadians: 0,
              ...(body.mode === 'shallow'
                ? {
                    pawn: {
                      positionM:
                        pawnDynamic || checked('patch-follow')
                          ? pawnPosition
                          : [-32, pawnPosition[1], 0],
                      velocityMPerSec: pawnVelocity,
                      touchingWater:
                        contact &&
                        (!pawnDynamic || pawnPosition[1] - pawnRadiusM <= worldWaterHeight()),
                    },
                  }
                : {}),
            })
            .unwrap();
          return { contact, nativePawn, pawnPosition, pawnVelocity, moving };
        };
        const { contact, nativePawn, pawnPosition, pawnVelocity, moving } = updatePawnSimulation();
        const updateShallowContacts = () => {
          if (body.mode === 'shallow') {
            if (!pawnDynamic)
              world
                .set(pawn, Transform, { pos: moving ? pawnPosition : [-32, pawnPosition[1], 0] })
                .unwrap();
            if (pawnDynamic && nativePawn?.ok) {
              const bottom = pawnPosition[1] - pawnRadiusM;
              const nativeContacts = world.get(pawn, CollidingEntities);
              if (nativeContacts.ok && nativeContacts.value.entities.length > 0)
                pawnContactBodies = [
                  ...new Set([...pawnContactBodies, ...nativeContacts.value.entities]),
                ];
              if (
                pawnPriorBottom !== undefined &&
                pawnPriorBottom > worldWaterHeight() &&
                bottom <= worldWaterHeight() &&
                pawnImpactStep !== nativePawn.value.completedStep
              ) {
                simulation
                  .enqueueImpact({
                    id: impactId++,
                    positionM: [pawnPosition[0], worldWaterHeight(), pawnPosition[2]],
                    velocityMPerSec: pawnVelocity,
                    radiusM: pawnRadiusM,
                    timeSeconds:
                      world.getResource<PhysicsWorld>(PhysicsWorldResource).getSolverClock?.()
                        .simulationTimeSeconds ?? time,
                  })
                  .unwrap();
                pawnImpactStep = nativePawn.value.completedStep;
                operation('Native sphere water entry', 'shallow');
              }
              pawnPriorBottom = bottom;
            }
            if (
              checked('ndc-enabled') &&
              moving &&
              !pawnDynamic &&
              contact &&
              checked('shallow-enabled') &&
              time - lastMovingImpact > 0.065 &&
              simulation.inspect().queuedImpacts < 128
            ) {
              simulation
                .enqueueImpact({
                  id: impactId++,
                  positionM: pawnPosition,
                  velocityMPerSec: [1.8 * Math.cos(time * 0.45), 0, -1.35 * Math.sin(time * 0.45)],
                  radiusM: Number(node<HTMLInputElement>('impact-radius').value),
                  timeSeconds: time,
                })
                .unwrap();
              lastMovingImpact = time;
            }
          }
        };
        updateShallowContacts();
        if (body.mode === 'river') {
          const speed = Number(node<HTMLInputElement>('source-speed').value);
          simulation
            .setSourceSinks([
              {
                id: 1,
                kind: 'source',
                enabled: checked('source'),
                positionM: [0, -2.8, -10],
                extentM: [18, 6, 3],
                yawRadians: 0,
                additiveVelocity: false,
                sinkDissipationPerSecond: 0,
                velocityMPerSec: [0, 0, speed],
              },
              {
                id: 2,
                kind: 'sink',
                enabled: checked('sink'),
                positionM: [0, 0, 10],
                extentM: [22, 6, 4],
                yawRadians: 0,
                additiveVelocity: false,
                sinkDissipationPerSecond: 4,
                velocityMPerSec: [0, 0, 0],
              },
            ])
            .unwrap();
          world
            .set(sourceMarker, Transform, {
              scale: checked('source') ? [1.1, 1.1, 1.1] : [0.15, 0.15, 0.15],
            })
            .unwrap();
          world
            .set(sinkMarker, Transform, {
              scale: checked('sink') ? [1.1, 1.1, 1.1] : [0.15, 0.15, 0.15],
            })
            .unwrap();
          if (simulation.inspect().bake.status === 'captured' && !bakePublishing)
            void publishCapture(simulation);
          if (
            (restored || loadedBake) &&
            body.restoredGeneration !== snapshot.sceneGeneration &&
            !restoring
          ) {
            restoring = true;
            void publishBaked()
              .catch(report)
              .finally(() => {
                restoring = false;
              });
          }
        }
      }
    },
  });
  world.addSystem(Update, waterR7SimulationInputs).unwrap();
  let rigidAngle = 0;
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR7RigidMotion',
        before: [waterR7SimulationInputs],
        queries: [],
        fn: () => {
          if (checked('rigid-motion')) rigidAngle += world.getResource(Time).delta * 0.65;
          const selected = node<HTMLSelectElement>('rigid-fixture').value;
          for (const fixture of rigidFixtures) {
            world
              .set(fixture.entity, WaterShallowCollider, {
                enabled: selected === 'all' || selected === fixture.group,
              })
              .unwrap();
            const rotation =
              fixture.mesh === 'capsule'
                ? quat.fromEuler(quat.create(), Math.PI / 2, rigidAngle, 0, 'XYZ')
                : quat.fromEuler(quat.create(), 0, rigidAngle, 0, 'XYZ');
            world.set(fixture.entity, Transform, { quat: rotation }).unwrap();
          }
        },
      }),
    )
    .unwrap();

  const querySamples = () => {
    const body = requireDemoValue(
        bodies.find((value) => value.mode === 'river'),
        'accepted authored scene member',
      ),
      snapshot = waterSceneSnapshot(world, body.entity);
    if (!snapshot) return [];
    const grid = water().bakedQueryGrid(snapshot.guid, snapshot.sceneGeneration)?.grid;
    const boundary = grid?.originXZ[0] ?? -12;
    return (
      [
        { label: '内部', position: [0, -1, 0] },
        { label: '边界', position: [boundary, -1, 0] },
        { label: '外部', position: [boundary - 0.25, -1, 0] },
      ] as const
    ).map((row) => ({
      ...row,
      result: water().queryBody(snapshot.guid, {
        positionM: row.position,
        flags:
          WaterQueryFlags.ComputeLocation |
          WaterQueryFlags.ComputeDepth |
          WaterQueryFlags.ComputeVelocity,
        timeSeconds: time,
        expectedBodyGeneration: snapshot.sceneGeneration,
      }),
    }));
  };
  const setMode = (next: Mode) => {
    mode = next;
    node('mode-title').textContent = labels[mode];
    node('scene-number').textContent =
      `0${(['shallow', 'river', 'ocean'] as const).indexOf(mode) + 1} / 03`;
    node('scene-label').textContent = {
      shallow: '交互浅水池',
      river: '河流与静态烘焙',
      ocean: '频域海面',
    }[mode];
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.mode === mode));
    });
    document.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== mode;
    });
    node('query-section').hidden = mode !== 'river';
    setView('middle');
    refresh();
  };
  const capture = () => {
    if (mode === 'ocean') water().oceanPatch()?.requestStageCapture();
    else active().simulation?.requestStageCapture();
    operation('Stage capture');
  };
  const impact = () => {
    pawnDynamic = true;
    pawnPriorBottom = undefined;
    pawnContactBodies = [];
    const radius = Number(node<HTMLInputElement>('impact-radius').value);
    pawnRadiusM = radius;
    world.set(pawn, Transform, { scale: [radius, radius, radius] }).unwrap();
    world.set(pawn, WaterPontoonSet, { enabled: true, radiiM: [radius] }).unwrap();
    world.set(pawn, RigidBody, { type: RigidBodyTypeValue.dynamic }).unwrap();
    pendingPawnLaunch = [-32, worldWaterHeight() + 7, 0];
    node<HTMLInputElement>('pawn-motion').checked = false;
    operation('Native sphere launch requested', 'shallow');
  };
  let oceanRequestSequence = 0;
  const requestOcean = async () => {
    const request = ++oceanRequestSequence;
    const recipeGuid = guid(checked('ocean-grid') ? 'recipe/ocean-grid' : 'recipe/ocean');
    const recipeHandle = (await assets.load(recipeGuid, 'water-simulation-recipe')).unwrap();
    try {
      if (request !== oceanRequestSequence) return;
      const recipe: WaterAdvancedRecipe = {
        guid: recipeGuid,
        contentVersion: version(recipeHandle),
        asset: assets.read(recipeHandle).unwrap() as Recipe,
      };
      if (water().oceanPatch()?.recipe.guid !== recipeGuid) water().removeOceanPatch();
      const ocean = water().requestOceanPatch(recipe).unwrap();
      node<HTMLInputElement>('ocean-enabled').checked = true;
      ocean.setEnabled(true);
      ocean.setPaused(checked('ocean-pause'));
      operation('FFT first request', 'ocean');
    } finally {
      assets.release(recipeHandle).unwrap();
    }
  };
  const setOceanGrid = async (enabled: boolean) => {
    node<HTMLInputElement>('ocean-grid').checked = enabled;
    if (water().oceanPatch()) {
      const active = checked('ocean-enabled');
      await requestOcean();
      if (checked('ocean-grid') !== enabled) return;
      node<HTMLInputElement>('ocean-enabled').checked = active;
      water().oceanPatch()?.setEnabled(active);
    }
    operation('FFT grid mesh recipe', 'ocean');
  };
  const rigidState = () => ({
    path: node<HTMLSelectElement>('rigid-path').value,
    fixture: node<HTMLSelectElement>('rigid-fixture').value,
    authoredSurfaceHeightM: worldWaterHeight(),
    cellSizeM: shallowCellM,
    angle: rigidAngle,
    bodies: rigidFixtures.map((fixture) => ({
      entity: fixture.entity,
      group: fixture.group,
      mesh: fixture.mesh,
      optedIn: world.get(fixture.entity, WaterShallowCollider).unwrap().enabled,
      accepted: world
        .getResource<PhysicsWorld>(PhysicsWorldResource)
        .getCommittedColliderPrimitives?.(fixture.entity),
    })),
  });
  const exportState = () => ({
    completedFrames,
    receipt,
    mode,
    camera: { eye, target },
    errors,
    operations,
    rigid: rigidState(),
    pawn: {
      entity: pawn,
      basinFloor,
      mode: pawnDynamic ? 'native-dynamic' : 'kinematic-motion-specimen',
      pendingLaunch: pendingPawnLaunch,
      entryStep: pawnImpactStep,
      contacts: pawnContactBodies,
      dynamics: world
        .getResource<PhysicsWorld>(PhysicsWorldResource)
        .getCommittedBodyDynamics?.(pawn),
      collider: world
        .getResource<PhysicsWorld>(PhysicsWorldResource)
        .getCommittedColliderPrimitives?.(pawn),
    },
    oceanPatch: water().oceanPatch()?.inspect(),
    noise: {
      guid: guid('texture/ocean-phase'),
      catalogContentVersion: version(noiseHandle),
      revision: assets.revision(noiseHandle).unwrap(),
    },
    bake: {
      status: bakeStatus,
      version: bakeVersion,
      origin: bakeOrigin,
      publication: acceptedBake,
      recipe: loadedBake,
    },
    simulations: bodies.map((body) => ({
      mode: body.mode,
      state: body.simulation?.inspect(),
      snapshot: waterSceneSnapshot(world, body.entity),
    })),
    queries: querySamples(),
    renderer: app.renderer.inspect(),
  });
  let lastTextureKey = '';
  function preview(
    canvasId: string,
    pixels: WaterAdvancedTextureReadback | WaterOceanPatchTextureReadback | undefined,
    normal: boolean,
  ) {
    if (!pixels) return;
    const output = node<HTMLCanvasElement>(canvasId),
      context = output.getContext('2d');
    if (!context) return;
    output.width = pixels.width;
    output.height = pixels.height;
    const image = context.createImageData(pixels.width, pixels.height),
      view = new DataView(pixels.bytes.buffer, pixels.bytes.byteOffset, pixels.bytes.byteLength);
    const read = (offset: number) => {
      if (pixels.format === 'rgba32float') return view.getFloat32(offset, true);
      const value = view.getUint16(offset, true),
        sign = value & 0x8000 ? -1 : 1,
        exponent = (value >>> 10) & 31,
        mantissa = value & 1023;
      return (
        sign *
        (exponent === 0
          ? mantissa * 2 ** -24
          : exponent === 31
            ? mantissa
              ? NaN
              : Infinity
            : (1 + mantissa / 1024) * 2 ** (exponent - 15))
      );
    };
    const stride = pixels.format === 'rgba32float' ? 16 : 8;
    for (let y = 0; y < pixels.height; y++)
      for (let x = 0; x < pixels.width; x++) {
        const offset = y * pixels.bytesPerRow + x * stride,
          index = (y * pixels.width + x) * 4;
        const r = read(offset),
          g = read(offset + stride / 4),
          b = read(offset + stride / 2),
          a = read(offset + (stride * 3) / 4);
        const color = normal
          ? [r * 0.5 + 0.5, g * 0.5 + 0.5, b * 0.5 + 0.5]
          : [0.2 + r * 0.7, 0.35 + g * 0.1, 0.45 + Math.hypot(b, a) * 0.2];
        for (let channel = 0; channel < 3; channel++)
          image.data[index + channel] = Math.round(
            Math.max(
              0,
              Math.min(1, requireDemoValue(color[channel], 'accepted authored scene member')),
            ) * 255,
          );
        image.data[index + 3] = 255;
      }
    context.putImageData(image, 0, 0);
  }
  function refresh() {
    const state = active().simulation?.inspect(),
      oceanInspection = water().oceanPatch()?.inspect(),
      ocean = oceanInspection?.state;
    const oceanLabel = ocean
      ? {
          disabled: '已关闭',
          retired: '已退役',
          initializing: '初始化',
          ready: '运行中',
          paused: '已暂停',
          stale: '分辨率已申请',
          unsupported: '设备不支持',
          unavailable: '输入不可用',
        }[ocean.status]
      : '未申请';
    node('state').textContent =
      mode === 'ocean'
        ? oceanLabel
        : state
          ? {
              initializing: '初始化',
              active: '运行中',
              fading: '衰减中',
              'waiting-water-info': '等待水域数据',
              'waiting-water-surface': '等待水面查询',
              disabled: '已关闭',
              retired: '已退役',
              unsupported: '设备不支持',
              failed: '运行失败',
            }[state.status]
          : '等待水域';
    const refreshShallowAndBakeReadout = () => {
      const shallowState = bodies.find((body) => body.mode === 'shallow')?.simulation?.inspect(),
        surface = shallowState?.collisionSurface;
      node('rigid-count').textContent = String(
        rigidState().bodies.filter((body) => body.optedIn).length,
      );
      node('rigid-height').textContent =
        surface?.status === 'ready'
          ? `${surface.positionM[1].toFixed(3)} m`
          : surface?.status === 'pending'
            ? '等待查询'
            : '--';
      node('step').textContent = String(
        mode === 'ocean' ? (oceanInspection?.submittedSequence ?? 0) : (state?.step ?? 0),
      );
      node('stage').textContent =
        mode === 'ocean'
          ? ocean?.status === 'ready'
            ? '频域变换'
            : '--'
          : state?.previousStage
            ? (stageLabels[state.previousStage] ?? state.previousStage)
            : '--';
      node('receipt').textContent = receipt
        ? `完成帧 ${receipt.frameId} · 设备 ${receipt.deviceGeneration} · 图 ${receipt.graphGeneration ?? 0}`
        : '等待首个完成帧';
      node('bake-state').textContent = bakeStatus;
      node('bake-version').textContent = bakeVersion;
      node('bake-version').title = bakeVersion;
      node('bake-origin').textContent = bakeOrigin;
      node<HTMLButtonElement>('bake').disabled =
        bakePublishing ||
        !bodies.find((value) => value.mode === 'river')?.simulation ||
        ['requested', 'reading'].includes(
          requireDemoValue(
            requireDemoValue(
              bodies.find((value) => value.mode === 'river'),
              "bodies.find((value) => value.mode === 'river')",
            ).simulation,
            'accepted authored scene member',
          ).inspect().bake.status,
        );
    };
    refreshShallowAndBakeReadout();
    node('ocean-state').textContent = oceanLabel;
    node('ocean-size').textContent =
      ocean && 'size' in ocean
        ? `${ocean.size} × ${ocean.size}`
        : ocean?.status === 'initializing'
          ? `${ocean.allocation === 'initial-1x1' ? 1 : ocean.requestedSize} × ${ocean.allocation === 'initial-1x1' ? 1 : ocean.requestedSize}`
          : '未申请';
    node<HTMLButtonElement>('request-ocean').disabled =
      ocean !== undefined && !['not-requested', 'disabled', 'unavailable'].includes(ocean.status);
    const refreshQueries = () => {
      const queries = node('queries');
      queries.replaceChildren();
      for (const row of querySamples()) {
        const element = document.createElement('div');
        element.className = 'query-row';
        const result = row.result.ok ? row.result.value : undefined;
        for (const text of [
          row.label,
          `${fixed(result?.locationM?.[1])} / ${fixed(result?.depthM)} m`,
          `${fixed(result?.velocityMPerSec ? Math.hypot(...result.velocityMPerSec) : undefined)} m/s`,
        ]) {
          const span = document.createElement('span');
          span.textContent = text;
          element.append(span);
        }
        const source = document.createElement('small');
        source.textContent = result
          ? `来源 ${{ plane: '平面', terrain: '地形', spline: '样条', baked: '烘焙', exclusion: '排除' }[result.source]}`
          : row.result.ok
            ? '--'
            : row.result.error.code;
        element.append(source);
        queries.append(element);
      }
    };
    refreshQueries();
    const refreshFieldPreviews = () => {
      const pixels = readbacks();
      const key = pixels[0] ? `${mode}:${pixels[0].completion.frameId}:${pixels.length}` : '';
      if (key && key !== lastTextureKey) {
        lastTextureKey = key;
        const select = node<HTMLSelectElement>('texture-selection');
        select.replaceChildren(
          ...pixels.map((pixel) => new Option(textureLabel(pixel.name), pixel.name)),
        );
        select.value =
          pixels.find((pixel) => pixel.name.endsWith('-grid'))?.name ??
          requireDemoValue(pixels[0], 'accepted authored scene member').name;
        preview(
          'field-preview',
          pixels.find((pixel) => pixel.name === select.value),
          false,
        );
        preview(
          'normal-preview',
          pixels.find((pixel) => pixel.name.endsWith('-normal')),
          true,
        );
      }
    };
    refreshFieldPreviews();
    for (const pending of operations)
      if (!pending.completion) {
        const owner =
          pending.mode === 'ocean'
            ? water().oceanPatch()?.inspect()
            : bodies.find((body) => body.mode === pending.mode)?.simulation?.inspect();
        if (owner?.completion && owner.completedSequence > pending.requestedSequence)
          pending.completion = { ...owner.completion, sequence: owner.completedSequence };
      }
  }
  app.pluginContext.effect(() => {
    const controller = new AbortController(),
      options = { signal: controller.signal };
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode as Mode), options);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener(
        'click',
        () => setView(requireDemoValue(button.dataset.view, 'accepted authored scene member')),
        options,
      );
    });
    node('panel-toggle').addEventListener(
      'click',
      () => {
        node('panel').classList.toggle('closed');
        const closed = node('panel').classList.contains('closed');
        node('panel-toggle').setAttribute('aria-label', closed ? '展开控制面板' : '收起控制面板');
        node('panel-toggle').title = closed ? '展开控制面板' : '收起控制面板';
      },
      options,
    );
    node('recenter').addEventListener('click', () => setView(selectedView), options);
    node('impact').addEventListener('click', impact, options);
    node('request-ocean').addEventListener(
      'click',
      () => {
        void requestOcean().catch(report);
      },
      options,
    );
    node('capture').addEventListener('click', capture, options);
    for (const selected of ['shallow', 'river'] as const)
      node(`reset-${selected}`).addEventListener(
        'click',
        () => {
          const body = requireDemoValue(
            bodies.find((body) => body.mode === selected),
            'accepted authored scene member',
          );
          if (body.simulation?.inspect().status === 'retired') {
            water().removeAdvancedSimulation(body.simulation);
            body.simulation = undefined;
          } else body.simulation?.reset();
          if (selected === 'shallow') {
            pendingPawnLaunch = undefined;
            pawnDynamic = false;
            pawnPriorBottom = undefined;
            pawnContactBodies = [];
            world.set(pawn, RigidBody, { type: RigidBodyTypeValue.kinematic }).unwrap();
            world.set(pawn, WaterPontoonSet, { enabled: false }).unwrap();
          }
          operation('Simulation reset', selected);
        },
        options,
      );
    node('reset-ocean').addEventListener(
      'click',
      () => {
        water().oceanPatch()?.reset();
        operation('FFT reset', 'ocean');
      },
      options,
    );
    node('ocean-pause').addEventListener(
      'change',
      () => {
        water().oceanPatch()?.setPaused(checked('ocean-pause'));
        operation('FFT pause', 'ocean');
      },
      options,
    );
    node('ocean-enabled').addEventListener(
      'change',
      () => {
        water().oceanPatch()?.setEnabled(checked('ocean-enabled'));
        operation('FFT enabled', 'ocean');
      },
      options,
    );
    node('ocean-grid').addEventListener(
      'change',
      () => {
        void setOceanGrid(checked('ocean-grid')).catch(report);
      },
      options,
    );
    node('bake').addEventListener(
      'click',
      () => {
        const result = bodies.find((body) => body.mode === 'river')?.simulation?.requestBake();
        if (result && !result.ok) report(result.error);
        else {
          bakeStatus = '等待 GPU 回读';
          operation('Bake request', 'river');
        }
      },
      options,
    );
    node('cold-reload').addEventListener('click', () => location.reload(), options);
    node('retry-save').addEventListener(
      'click',
      () => {
        if (!bakePublishing) void persistBake();
      },
      options,
    );
    for (const id of [
      'source',
      'sink',
      'patch-follow',
      'pawn-motion',
      'pawn-contact',
      'shallow-enabled',
      'river-enabled',
    ])
      node(id).addEventListener('change', () => operation(id), options);
    node('river-detail').addEventListener(
      'change',
      () => {
        if (checked('river-detail')) void requestOcean().catch(report);
        operation('River detail', 'river');
      },
      options,
    );
    node('source-speed').addEventListener(
      'input',
      () => {
        node('speed-value').textContent =
          `${Number(node<HTMLInputElement>('source-speed').value).toFixed(1)} m/s`;
      },
      options,
    );
    node('impact-radius').addEventListener(
      'input',
      () => {
        node('radius-value').textContent =
          `${Number(node<HTMLInputElement>('impact-radius').value).toFixed(1)} m`;
      },
      options,
    );
    node('texture-selection').addEventListener(
      'change',
      () => {
        preview(
          'field-preview',
          readbacks().find(
            (pixel) => pixel.name === node<HTMLSelectElement>('texture-selection').value,
          ),
          false,
        );
      },
      options,
    );
    node('rigid-path').addEventListener(
      'change',
      () => {
        const selected = requireDemoValue(
          rigidRecipes.get(node<HTMLSelectElement>('rigid-path').value),
          'accepted authored scene member',
        );
        const body = requireDemoValue(
          bodies.find((body) => body.mode === 'shallow'),
          'accepted authored scene member',
        );
        if (body.simulation) water().removeAdvancedSimulation(body.simulation);
        body.simulation = undefined;
        body.recipe = selected.handle;
        body.recipeGuid = selected.guid;
        operation('Rigid collision recipe', 'shallow');
      },
      options,
    );
    node('water-height').addEventListener(
      'change',
      () => {
        const body = requireDemoValue(
          bodies.find((body) => body.mode === 'shallow'),
          'accepted authored scene member',
        );
        world
          .set(body.entity, Transform, { pos: [centers.shallow, worldWaterHeight(), 0] })
          .unwrap();
        if (mode === 'shallow') setView(selectedView);
        operation('World water height', 'shallow');
      },
      options,
    );
    node('export').addEventListener(
      'click',
      () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(exportState(), jsonFacts, 2)], { type: 'application/json' }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'water-r7-state.json';
        anchor.click();
        URL.revokeObjectURL(url);
      },
      options,
    );
    return () => controller.abort();
  });
  let lastRefresh = 0;
  const frameTimes: number[] = [];
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') report(event.error);
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed
      .then((result) => {
        if (!result.ok) {
          report(result.error);
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
        frameTimes.push(now);
        while ((frameTimes[0] ?? now) < now - 1000) frameTimes.shift();
        if (now - lastRefresh > 180) {
          const span = now - (frameTimes[0] ?? now);
          node('fps').textContent =
            span > 400 ? `${(((frameTimes.length - 1) * 1000) / span).toFixed(1)} FPS` : '-- FPS';
          refresh();
          lastRefresh = now;
        }
      })
      .catch(report);
  });
  Object.assign(window, {
    __waterR7: {
      app,
      world,
      assets,
      bodies,
      camera,
      profiler,
      operations,
      errors,
      readState: exportState,
      setMode,
      setView,
      setCameraPose: (pose: { eye: Vector; target: Vector }) => {
        eye = [...pose.eye];
        target = [...pose.target];
        applyCamera();
      },
      capture,
      impact,
      requestOcean,
      querySamples,
      setOceanGrid,
      readbacks,
      rigidFixtures,
      rigidState,
    },
  });
  setView('middle');
  await dressWaterStage(app, [0, 0, 0], 1.2, 'laboratory');
  await dressWaterMuseum(app, [0, -4.8, 0], [116, 17, 76]);
  const runtimePanel = stageRuntimePanel(
    app,
    requireDemoValue(document.getElementById('panel'), 'accepted authored scene member'),
    'R7',
  );
  for (const body of bodies)
    runtimePanel.forms.push(
      runtimeForm(
        runtimePanel.section,
        `${body.mode} · 原生模拟配方`,
        runtimeObjectFields(
          () => ({ ...assets.read(body.recipe).unwrap() }),
          (values) => {
            assets.replace(body.recipe, values as unknown as Recipe).unwrap();
            if (body.mode === 'ocean' && water().oceanPatch()) void requestOcean().catch(report);
          },
          {
            'shallowStageConfig.advection': ['bilinear', 'cubic'],
            'substepConfig.timeStepSource': ['frame-delta'],
            'substepConfig.deltaLimit.kind': ['application-cap', 'source-default'],
          },
        ),
      ),
    );
  const quality = waterQualityControl((level) => {
    const source = assets.read(zone).unwrap();
    const resolution = [256, 512, 1024, 2048][level] ?? 512;
    assets
      .replace(zone, {
        ...source,
        tessellationFactor: [3, 4, 5, 6][level] ?? 4,
        waterInfo: {
          ...source.waterInfo,
          resolution: { widthPx: resolution, heightPx: resolution },
        },
      })
      .unwrap();
  }, 1);
  const panel = node('panel');
  const sections = [...panel.querySelectorAll<HTMLElement>(':scope > section')];
  arrangeWaterSettings({
    panel,
    hero: panel.querySelector<HTMLElement>('.panel-title') ?? undefined,
    title: '浅水、河流与海面',
    description:
      '投放物体激起浅水波，调节河流源汇并保存流场，或观察频域海面。切换顶部场景开始体验。',
    dimensions: [
      {
        title: '场景交互',
        elements: [sections[1], sections[3], sections[4]].filter((v): v is HTMLElement =>
          Boolean(v),
        ),
        open: true,
      },
      { title: '画质与相机', elements: [quality, ...sections.slice(0, 1)] },
      {
        title: '高级 · 碰撞与场数据',
        elements: [sections[2], sections[5], sections[6]].filter((v): v is HTMLElement =>
          Boolean(v),
        ),
      },
    ],
  });
  waterStageNavigation('R7');
  app.start().unwrap();
}
void main().catch((error) => {
  console.error(error);
  node('state').textContent = '启动失败';
  node('message').hidden = false;
  node('message').textContent =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : String(error);
});
