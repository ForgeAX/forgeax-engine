import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { Transform, WaterBodyInstance, WaterZoneInstance } from '@forgeax/engine/scene';
import type { WaterSystem } from '@forgeax/engine/water';
import { waterBodyEditor } from '../../body-editor';
import { dressWaterMuseum } from '../../museum-presentation';
import { stageRuntimePanel } from '../../presentation';
import { presentationGuid } from '../../presentation-identity';
import { runtimeForm, runtimeObjectFields } from '../../runtime-form';
import { waterStageNavigation } from '../../stage-catalog';
import { r0Guid } from './identity';
import '../../observatory.css';

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene'),
    panel = document.querySelector<HTMLElement>('#controls-panel');
  if (!canvas || !panel) throw new Error('R0 requires its canvas and controls');
  const app = (
    await createApp(
      canvas,
      {
        plugins: [physics3d],
        uiRoot: panel,
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
  if (!assets) throw new Error('R0 requires the App asset owner');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const zone = (await assets.load(r0Guid('zone/main'), 'water-zone')).unwrap();
  let zoneEntity: EntityHandle | undefined;
  const button = document.createElement('button');
  button.textContent = '挂载共享 Zone';
  panel.append(button);
  button.addEventListener('click', () => {
    if (zoneEntity === undefined) {
      zoneEntity = world
        .spawn({ component: Transform, data: {} }, { component: WaterZoneInstance, data: { zone } })
        .unwrap();
      button.textContent = '卸载共享 Zone';
    } else {
      world.despawn(zoneEntity).unwrap();
      zoneEntity = undefined;
      button.textContent = '挂载共享 Zone';
    }
  });
  const plank = (await assets.load(presentationGuid('mesh/plank'), 'mesh')).unwrap();
  const brass = (await assets.load(presentationGuid('material/brass'), 'material')).unwrap();
  const wood = (await assets.load(presentationGuid('material/wood'), 'material')).unwrap();
  const stone = (await assets.load(presentationGuid('material/limestone'), 'material')).unwrap();
  const sky = (await assets.load(presentationGuid('sky/day'), 'equirect')).unwrap();
  world.spawn({ component: SkyboxBackground, data: { equirect: sky } }).unwrap();
  world
    .spawn({
      component: Skylight,
      data: { equirect: sky, intensity: 0.85, ambientIrradiance: [0.2, 0.22, 0.23] },
    })
    .unwrap();
  await dressWaterMuseum(app, [0, -4.15, 1], [64, 13, 44]);
  const display = (point: number[], scale: number[], material = brass, rotation?: number[]) =>
    world
      .spawn(
        {
          component: Transform,
          data: { pos: point, scale, ...(rotation ? { quat: rotation } : {}) },
        },
        { component: MeshFilter, data: { assetHandle: plank } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  // This architecture presents lifecycle facts only. No R1 surface product is mounted.
  display([0, -1.05, 0], [45, 0.7, 15], stone);
  for (let section = 0; section < 12; section++)
    display([-20.4 + section * 3.7, -0.67, 0], [3.64, 0.12, 14.5], wood);
  for (const z of [-7.4, 7.4]) display([0, -0.55, z], [45, 0.16, 0.18]);
  for (const x of [-22.4, 22.4]) display([x, -0.55, 0], [0.18, 0.16, 15]);
  for (const x of [-20, -10, 0, 10, 20]) {
    display([x, -2.4, -5], [0.8, 3, 0.8], stone);
    display([x, -2.4, 5], [0.8, 3, 0.8], stone);
  }
  const legend = document.createElement('div');
  legend.className = 'r0-lifecycle-legend';
  document.body.append(legend);
  const bodies = await Promise.all(
    (['river', 'lake', 'ocean', 'custom'] as const).map(async (type, index) => {
      const body = (await assets.load(r0Guid(`body/${type}`), 'water-body')).unwrap();
      const pos: [number, number, number] = [(index - 1.5) * 10, 0, 0];
      let entity: EntityHandle | undefined = world
        .spawn(
          { component: Transform, data: { pos } },
          { component: WaterBodyInstance, data: { body } },
        )
        .unwrap();
      const card = document.createElement('section'),
        title = document.createElement('h2'),
        toggle = document.createElement('button');
      const names = {
        river: '01 · 河流',
        lake: '02 · 湖泊',
        ocean: '03 · 海洋',
        custom: '04 · 自定义',
      };
      title.textContent = `${names[type]} · Scene 实例`;
      toggle.textContent = '卸载实例';
      card.append(title, toggle);
      panel.append(card);
      toggle.addEventListener('click', () => {
        if (entity === undefined) {
          entity = world
            .spawn(
              { component: Transform, data: { pos } },
              { component: WaterBodyInstance, data: { body } },
            )
            .unwrap();
          toggle.textContent = '卸载实例';
        } else {
          world.despawn(entity).unwrap();
          entity = undefined;
          toggle.textContent = '重新挂载实例';
        }
      });
      const editBody = waterBodyEditor(
        assets,
        body,
        () => parameters.refresh(),
        (error) => parameters.rejectPending(error),
      );
      const parameters = runtimeForm(
        card,
        '生命周期输入（单位 m）',
        runtimeObjectFields(() => ({ ...assets.read(body).unwrap() }), editBody, {}, [
          'flags',
          'collision',
          'type',
        ]),
      );
      display([pos[0], -0.35, 0], [9.25, 0.5, 8.6], stone);
      display([pos[0], -0.04, 0], [9, 0.12, 8.3], stone);
      for (const z of [-4.2, 4.2]) display([pos[0], 0.03, z], [9.2, 0.1, 0.1]);
      for (const x of [-4.6, 4.6]) display([pos[0] + x, 0.03, 0], [0.1, 0.1, 8.5]);
      // Engraved scale ticks and a number of index bars identify the four exhibits
      // without introducing a rendered-water surface at the foundation stage.
      for (let tick = 0; tick <= 16; tick++)
        display([pos[0] - 4 + tick * 0.5, 0.13, 4], [0.035, 0.04, tick % 4 === 0 ? 0.32 : 0.16]);
      for (let bar = 0; bar <= index; bar++)
        display([pos[0] - index * 0.22 + bar * 0.44, 0.17, 4.8], [0.25, 0.12, 0.7]);
      const markers: EntityHandle[] = [];
      const bindingMarker = display([pos[0], 0.7, -5.5], [0.8, 1.5, 0.8]);
      display([pos[0], -0.25, -5.5], [1.6, 0.3, 1.6], stone);
      const badge = document.createElement('div');
      badge.innerHTML = `<strong>${names[type]}</strong><span>等待准入</span>`;
      legend.append(badge);
      const status = document.createElement('p');
      card.prepend(status);
      return {
        type,
        body,
        pos,
        markers,
        bindingMarker,
        status,
        badge,
        get entity() {
          return entity;
        },
      };
    }),
  );
  for (const body of bodies) legend.append(body.badge);
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -0.8, -0.3],
        intensity: 2.8,
        color: [1, 0.95, 0.83],
        castShadow: true,
      },
    })
    .unwrap();
  const eye: [number, number, number] = [15, 13, 31];
  world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: 0.96,
            aspect: canvas.clientWidth / canvas.clientHeight,
            near: 0.1,
            far: 500,
          }),
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
    )
    .unwrap();
  stageRuntimePanel(app, panel, 'R0');
  waterStageNavigation('R0');
  const factSection = document.createElement('details'),
    factTitle = document.createElement('summary'),
    facts = document.createElement('pre');
  factTitle.textContent = '生命周期准入与绑定事实';
  factSection.append(factTitle, facts);
  panel.append(factSection);
  let completedFrames = 0;
  const state = () => {
    const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    return {
      completedFrames,
      bodies: water.snapshots(),
      zones: water.zoneSnapshots(),
      renderer: app.renderer.inspect(),
    };
  };
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (!result.ok || event.receipt.presentation !== 'ready') return;
      completedFrames++;
      if (completedFrames % 15 !== 0) return;
      const current = state();
      for (const body of bodies) {
        const snapshot = current.bodies.find((value) => value.instanceEntity === body.entity);
        body.status.textContent = snapshot
          ? `已准入 · ${snapshot.binding.kind} · generation ${snapshot.sceneGeneration}`
          : '实例未挂载 / 等待准入';
        const badgeStatus = body.badge.lastElementChild;
        if (badgeStatus)
          badgeStatus.textContent = snapshot
            ? `${snapshot.binding.kind === 'bound' ? 'Zone 已绑定' : '已准入 · 等待 Zone'} / G${snapshot.sceneGeneration}`
            : '实例已卸载';
        const refreshBoundaryMarkers = () => {
          const captureBoundaryShape = () => {
            const source = snapshot?.asset ?? assets.read(body.body).unwrap();
            const footprint = source.geometrySnapshot?.queryFootprint.outer;
            const points = footprint?.length
              ? footprint
              : source.type === 'ocean'
                ? [
                    [-(source.oceanExtentM?.[0] ?? 8) / 2, -3],
                    [(source.oceanExtentM?.[0] ?? 8) / 2, -3],
                    [(source.oceanExtentM?.[0] ?? 8) / 2, 3],
                    [-(source.oceanExtentM?.[0] ?? 8) / 2, 3],
                  ]
                : source.spline.points.map((point) => [point.positionM[0], point.positionM[2]]);
            const closed =
              Boolean(footprint?.length) || source.spline.closed || source.type === 'ocean';
            return { points, closed };
          };
          const { points, closed } = captureBoundaryShape();
          const count = Math.max(0, points.length - (closed ? 0 : 1));
          while (body.markers.length > count) {
            const retired = body.markers.pop();
            if (retired !== undefined) world.despawn(retired).unwrap();
          }
          while (body.markers.length < count) body.markers.push(display([0, 0, 0], [1, 1, 1]));
          for (let index = 0; index < count; index++) {
            const a = points[index],
              b = points[(index + 1) % points.length],
              marker = body.markers[index];
            if (!a || !b || marker === undefined) continue;
            const ax = a[0] ?? 0,
              az = a[1] ?? 0,
              bx = b[0] ?? 0,
              bz = b[1] ?? 0;
            const yaw = -Math.atan2(bz - az, bx - ax),
              height = 0.35 + (snapshot?.asset.baseHeightM ?? 0);
            world
              .set(marker, Transform, {
                pos: [body.pos[0] + (ax + bx) / 2, height, (az + bz) / 2],
                scale: [
                  Math.hypot(bx - ax, bz - az),
                  snapshot ? 0.18 : 0.08,
                  snapshot ? 0.2 : 0.08,
                ],
                quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
              })
              .unwrap();
          }
        };
        refreshBoundaryMarkers();
        world
          .set(body.bindingMarker, Transform, {
            pos: [body.pos[0], snapshot?.binding.kind === 'bound' ? 1.4 : 0.5, -5.5],
            scale: [0.8, snapshot?.binding.kind === 'bound' ? 3 : 1.2, 0.8],
          })
          .unwrap();
      }
      if (factSection.open)
        facts.textContent = JSON.stringify(
          {
            completedFrames,
            bodies: current.bodies.map(({ instanceEntity, sceneGeneration, binding, outputs }) => ({
              instanceEntity,
              sceneGeneration,
              binding,
              outputs,
            })),
            zones: current.zones.map(({ guid, generation }) => ({ guid, generation })),
          },
          null,
          2,
        );
    });
  });
  app.pluginContext.effect(() => unsubscribe);
  Object.assign(window, { __waterR0: { app, world, assets, bodies, readState: state } });
  window.addEventListener('beforeunload', () => {
    void app.dispose();
  });
  app.start().unwrap();
}
void main().catch((error) => {
  const status = document.querySelector('#status');
  if (status) status.textContent = String(error);
  console.error(error);
});
