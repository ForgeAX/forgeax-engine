import type { App } from '@forgeax/engine/app';
import type { InputShapeOf, SchemaOf } from '@forgeax/engine/ecs';
import { PhysicsWorldResource, RigidBody } from '@forgeax/engine/physics';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  ScreenSpaceReflection,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import {
  Transform,
  WaterBodyInstance,
  WaterContactProbeSet,
  WaterFluidSimulation,
  WaterPontoonSet,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import type { WaterSimulationRecipeAsset, WaterZoneAsset } from '@forgeax/engine/types';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { waterBodyEditor } from './body-editor';
import { presentationGuid } from './presentation-identity';
import { runtimeForm, runtimeObjectFields } from './runtime-form';
import { contactProbeInput, pontoonInput } from './runtime-input';
import './suite.css';

/** Asset-backed presentation supplements a stage; it never produces its Water outputs. */
export async function dressWaterStage(
  app: App,
  center: readonly [number, number, number],
  scale = 1,
  setting: 'coast' | 'laboratory' = 'coast',
) {
  const assets = app.assets;
  if (!assets) throw new Error('Water observatory requires the App asset owner');
  const meshes = await Promise.all(
    ['plank', 'post', 'rock', 'frond'].map(async (key) =>
      (await assets.load(presentationGuid(`mesh/${key}`), 'mesh')).unwrap(),
    ),
  );
  const materials = await Promise.all(
    ['wood', 'rock', 'sand', 'leaf', 'brass', 'limestone', 'ink'].map(async (key) =>
      (await assets.load(presentationGuid(`material/${key}`), 'material')).unwrap(),
    ),
  );
  const sky = (await assets.load(presentationGuid('sky/day'), 'equirect')).unwrap();
  const { world } = app;
  if (Array.from(world.query({ read: [SkyboxBackground] }).unwrap()).length === 0)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: SkyboxBackground, data: { equirect: sky } },
      )
      .unwrap();
  if (Array.from(world.query({ read: [Skylight] }).unwrap()).length === 0)
    world
      .spawn({
        component: Skylight,
        data: { equirect: sky, intensity: 0.85, ambientIrradiance: [0.16, 0.19, 0.2] },
      })
      .unwrap();
  else
    for (const row of world.query({ read: [Skylight] }).unwrap())
      world
        .set(row.entity, Skylight, {
          equirect: sky,
          intensity: 0.85,
          ambientIrradiance: [0.16, 0.19, 0.2],
        })
        .unwrap();
  const placed: { entity: import('@forgeax/engine/ecs').EntityHandle; position: number[] }[] = [];
  const spawn = (
    mesh: number,
    material: number,
    point: readonly number[],
    size: readonly number[],
    rotation?: readonly number[],
  ) => {
    const position = point.map((value, axis) => (center[axis] ?? 0) + value * scale);
    const meshHandle = meshes[mesh],
      materialHandle = materials[material];
    if (meshHandle === undefined || materialHandle === undefined)
      throw new Error('Unknown presentation asset');
    const entity = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: position,
            scale: size.map((value) => value * scale),
            ...(rotation ? { quat: rotation } : {}),
          },
        },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
    placed.push({ entity, position });
    return entity;
  };
  for (let i = 0; i < 18; i++) {
    spawn(0, 0, [-8, 0.45, -9 + i * 0.42], [3.6, 0.18, 0.36]);
    if (i % 4 === 0)
      for (const side of [-1, 1]) {
        spawn(1, 0, [-8 + side * 1.5, -0.15, -9 + i * 0.42], [1, 1.7, 1]);
        spawn(0, 4, [-8 + side * 1.5, 0.77, -9 + i * 0.42], [0.28, 0.06, 0.28]);
      }
  }
  if (setting === 'coast') {
    // Individual courses preserve physical texture scale on the harbor retaining wall.
    spawn(0, 6, [0, -4.6, 0], [72, 0.8, 64]);
    for (let course = 0; course < 5; course++)
      for (let bay = 0; bay < 24; bay++)
        spawn(0, 5, [-34.5 + bay * 3, -3.35 + course * 1.05, -27], [2.94, 1, 6.6]);
    for (let i = 0; i < 24; i++) spawn(0, 0, [-34.5 + i * 3, 1.69, -27], [2.93, 0.12, 6.6]);
    for (const z of [-30.4, -23.6]) {
      spawn(0, 4, [0, 2.8, z], [72, 0.09, 0.09]);
      for (let i = 0; i < 19; i++) spawn(1, 4, [-34 + i * 3.8, 2.25, z], [0.4, 1.1, 0.4]);
    }
  }
  for (const row of world.query({ read: [Camera] }).unwrap())
    world.set(row.entity, Camera, { tonemap: TONEMAP_ACES_FILMIC, exposure: 1 }).unwrap();
  return {
    entities: placed.map((item) => item.entity),
    setCenter(next: readonly number[]) {
      for (const item of placed)
        world
          .set(item.entity, Transform, {
            pos: item.position.map(
              (value, axis) => value + (next[axis] ?? 0) - (center[axis] ?? 0),
            ),
          })
          .unwrap();
    },
  };
}

export function stageRuntimePanel(app: App, parent: HTMLElement, label: string) {
  const section = document.createElement('details');
  section.className = 'water-runtime-panel water-dimension';
  const heading = document.createElement('summary');
  heading.textContent = '高级 · 引擎对象与验收';
  section.append(heading);
  const facts = document.createElement('details'),
    summary = document.createElement('summary'),
    pre = document.createElement('pre');
  summary.textContent = '已接纳参数、帧率与渲染事实';
  facts.append(summary, pre);
  section.append(facts);
  const fullInspection = document.createElement('details'),
    fullSummary = document.createElement('summary'),
    fullPre = document.createElement('pre'),
    inspect = document.createElement('button');
  fullSummary.textContent = '完整渲染检查快照';
  fullPre.dataset.fullInspection = '';
  inspect.textContent = '检查完整渲染 JSON';
  inspect.addEventListener('click', () => {
    fullPre.textContent = JSON.stringify(
      app.renderer.inspect(),
      (_key, value) => (value instanceof Set ? [...value] : value),
      2,
    );
    fullInspection.open = true;
  });
  fullInspection.append(fullSummary, fullPre);
  section.append(inspect);
  facts.append(fullInspection);
  parent.append(section);
  const forms: ReturnType<typeof runtimeForm>[] = [];
  const bindings = new Map<string, ReturnType<typeof runtimeForm>>();
  const choices = {
    'waterInfo.format': ['rgba16f', 'rgba32f'],
    'gpuMesh.occlusion': ['disabled', 'hzb', 'precise', 'hzb-precise'],
    'substepConfig.timeStepSource': ['frame-delta'],
    'shallowStageConfig.advection': ['bilinear', 'cubic'],
    'shallowStageConfig.rigidMeshCollisions.kind': ['disabled', 'simple', 'distance-field'],
    'oceanPatchConfig.collisions.kind': ['simple', 'distance-field'],
    'oceanPatchConfig.boundary.kind': ['periodic', 'absorbing'],
    'oceanPatchConfig.normalRtFormat': ['rgba16float', 'rgba32float'],
    'oceanPatchConfig.visualNormalDetailFft.normalRtFormat': ['rgba16float', 'rgba32float'],
  };
  let reconciling = false,
    retired = false;
  const reconcile = async () => {
    if (reconciling || retired) return;
    reconciling = true;
    try {
      const active = new Set<string>();
      const mount = (
        key: string,
        title: string,
        read: () => Record<string, unknown>,
        write: (value: Record<string, unknown>) => void,
        readonlyPaths: readonly string[] = [],
      ) => {
        active.add(key);
        // The form reconciles its demanded source observation, including branch replacement.
        // Mounted identity and admission policy alone determine whether a form is replaced.
        const identity = key + JSON.stringify(readonlyPaths);
        active.delete(key);
        active.add(identity);
        if (!bindings.has(identity))
          bindings.set(
            identity,
            runtimeForm(section, title, runtimeObjectFields(read, write, choices, readonlyPaths)),
          );
      };
      const mountComponentForms = () => {
        for (const row of app.world.query({ read: [Camera] }).unwrap())
          mount(
            `camera:${row.entity}`,
            `相机 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, Camera).unwrap() }),
            (value) => {
              app.world
                .set(row.entity, Camera, value as InputShapeOf<SchemaOf<typeof Camera>>)
                .unwrap();
            },
          );
        for (const row of app.world.query({ read: [ScreenSpaceReflection] }).unwrap())
          mount(
            `ssr:${row.entity}`,
            `水体屏幕反射 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, ScreenSpaceReflection).unwrap() }),
            (value) => {
              app.world
                .set(
                  row.entity,
                  ScreenSpaceReflection,
                  value as InputShapeOf<SchemaOf<typeof ScreenSpaceReflection>>,
                )
                .unwrap();
            },
          );
        for (const row of app.world.query({ read: [RigidBody] }).unwrap())
          mount(
            `rigid:${row.entity}`,
            `刚体质量与原生阻尼 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, RigidBody).unwrap() }),
            (value) => {
              app.world
                .set(row.entity, RigidBody, value as InputShapeOf<SchemaOf<typeof RigidBody>>)
                .unwrap();
            },
            app.world.hasResource(PhysicsWorldResource) &&
              app.world
                .getResource<import('@forgeax/engine/physics').PhysicsWorld>(PhysicsWorldResource)
                .getDerivedPublication?.(row.entity)
              ? ['mass']
              : [],
          );
        for (const row of app.world.query({ read: [WaterPontoonSet] }).unwrap())
          mount(
            `pontoon:${row.entity}`,
            `浮力与水阻力 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, WaterPontoonSet).unwrap() }),
            (value) => {
              app.world.set(row.entity, WaterPontoonSet, pontoonInput(value)).unwrap();
            },
          );
        for (const row of app.world.query({ read: [WaterContactProbeSet] }).unwrap())
          mount(
            `contact:${row.entity}`,
            `船体接触 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, WaterContactProbeSet).unwrap() }),
            (value) => {
              app.world.set(row.entity, WaterContactProbeSet, contactProbeInput(value)).unwrap();
            },
          );
        for (const row of app.world.query({ read: [ParticleEffectPlayer] }).unwrap())
          mount(
            `particle:${row.entity}`,
            `粒子播放 · ${row.entity}`,
            () => ({ ...app.world.get(row.entity, ParticleEffectPlayer).unwrap() }),
            (value) => {
              app.world
                .set(
                  row.entity,
                  ParticleEffectPlayer,
                  value as InputShapeOf<SchemaOf<typeof ParticleEffectPlayer>>,
                )
                .unwrap();
            },
          );
      };
      mountComponentForms();
      const assets = app.assets;
      if (assets) {
        const materials = new Set<import('@forgeax/engine/types').AssetHandle<'material'>>();
        for (const row of app.world.query({ read: [MeshRenderer] }).unwrap())
          for (const handle of row.get(MeshRenderer).materials) materials.add(handle);
        for (const row of app.world.query({ read: [WaterZoneInstance] }).unwrap()) {
          const handle = row.get(WaterZoneInstance).zone;
          mount(
            `zone:${handle}`,
            '区域 / WaterInfo / 网格',
            () => ({ ...assets.read(handle).unwrap() }),
            (value) => {
              assets.replace(handle, value as unknown as WaterZoneAsset).unwrap();
            },
          );
        }
        for (const row of app.world.query({ read: [WaterBodyInstance] }).unwrap()) {
          const handle = row.get(WaterBodyInstance).body;
          const body = assets.read(handle).unwrap();
          for (const guid of [
            body.surfaceMaterialGuid,
            body.lodMaterialGuid,
            body.underwaterPostProcessMaterialGuid,
          ]) {
            if (!guid) continue;
            const material = await assets.load(guid, 'material');
            if (material.ok) materials.add(material.value);
          }
          const writeBody = waterBodyEditor(
            assets,
            handle,
            () => bindings.get(`body:${handle}[]`)?.refresh(),
            (error) => bindings.get(`body:${handle}[]`)?.rejectPending(error),
          );
          mount(
            `body:${handle}`,
            `水体参数与光学设置 · ${row.entity}`,
            () => {
              const body = assets.read(handle).unwrap();
              return { ...body };
            },
            writeBody,
          );
        }
        for (const row of app.world.query({ read: [WaterFluidSimulation] }).unwrap()) {
          const handle = row.get(WaterFluidSimulation).recipe;
          mount(
            `recipe:${handle}`,
            `局部流体配方 · ${row.entity}`,
            () => ({ ...assets.read(handle).unwrap() }),
            (value) => {
              assets.replace(handle, value as unknown as WaterSimulationRecipeAsset).unwrap();
            },
          );
        }
        for (const handle of materials) {
          mount(
            `material:${handle}`,
            `材质运行值 · ${handle}`,
            () => {
              const material = assets.read(handle).unwrap();
              return {
                values: material.values ?? {},
                staticSwitches: material.staticSwitches ?? {},
              };
            },
            (value) => {
              assets
                .update(handle, {
                  values: value.values as Record<
                    string,
                    import('@forgeax/engine/types').MaterialValue
                  >,
                })
                .unwrap();
            },
            ['staticSwitches'],
          );
        }
      }
      for (const [key, form] of bindings)
        if (!active.has(key)) {
          form.remove();
          bindings.delete(key);
        }
      forms.splice(0, forms.length, ...bindings.values());
    } finally {
      reconciling = false;
    }
  };
  section.addEventListener('toggle', () => {
    if (!section.open) return;
    void reconcile()
      .then(() => {
        for (const form of forms) form.refresh();
      })
      .catch((error) => {
        pre.textContent = String(error);
        facts.open = true;
      });
  });
  let count = 0,
    last = performance.now();
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (retired || !result.ok || event.receipt.presentation !== 'ready') return;
      count++;
      if (performance.now() - last < 500) return;
      heading.textContent = `高级 · 引擎对象与验收 · ${((count * 1000) / (performance.now() - last)).toFixed(1)} FPS`;
      count = 0;
      last = performance.now();
      if (section.open)
        void reconcile()
          .then(() => {
            if (!retired) for (const form of forms) form.refresh();
          })
          .catch((error) => {
            pre.textContent = String(error);
            facts.open = true;
          });
      if (facts.open)
        pre.textContent = JSON.stringify(
          app.renderer.inspect({
            fields: ['state', 'frame', 'surface', 'recovery', 'featureGraph'],
          }),
          (_key, value) => (value instanceof Set ? [...value] : value),
          2,
        );
    });
  });
  app.pluginContext.effect(() => () => {
    retired = true;
    unsubscribe();
  });
  const capture = document.createElement('button');
  capture.textContent = '保存实际 RHI 帧';
  capture.addEventListener('click', () => {
    void (async () => {
      const result = await app.rhiCapture?.captureFrame();
      if (!result?.ok) {
        pre.textContent = JSON.stringify(result);
        facts.open = true;
        return;
      }
      const bytes = result.value.bytes;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${label}.rhitape`;
      anchor.click();
      URL.revokeObjectURL(url);
    })();
  });
  section.append(capture);
  return { section, forms };
}
