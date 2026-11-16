import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { defineSystem, type EntityHandle, Time, Update } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  createSphereGeometry,
} from '@forgeax/engine-geometry';
import {
  attachBrowserInputBackend,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  perspective,
  ReadonlyDynamicInputPage,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import {
  registryWaterMaterialReference,
  WATER_SCENE_STATUS_RESOURCE,
  WATER_SYSTEM_RESOURCE,
} from '@forgeax/engine-runtime';
import { Transform, WaterBodyInstance, WaterZoneInstance } from '@forgeax/engine-scene';
import type { AssetHandle, WaterBodyAsset } from '@forgeax/engine-types';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { surfaceEvidenceGuid } from './surface-standard-evidence-identity';

const canvas = document.querySelector<HTMLCanvasElement>('#water');
const status = document.querySelector<HTMLElement>('#status');
if (!canvas || !status) throw new Error('Missing water demo shell');
const r0Mode = document.body.dataset.waterDemo === 'r0';
canvas.width = Math.min(innerWidth * devicePixelRatio, 1920);
canvas.height = Math.round((canvas.width * innerHeight) / innerWidth);
try {
  const created = await createApp(
    canvas,
    {
      ...(r0Mode
        ? { input: attachBrowserInputBackend(canvas, { pointerLockAllowed: () => false }).backend }
        : {}),
      ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
    },
    {
      ...forgeaxBundlerAdapter(),
      ...(import.meta.env.DEV && runtimeBinding
        ? { importTransport: createRuntimeAssetImportTransport(runtimeBinding) }
        : {}),
    },
  );
  if (!created.ok) throw created.error;
  const app = created.value;
  const assets = app.assets;
  if (!assets) throw new Error('Water demo requires the App asset registry');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const catalog = await assets.catalogSource?.enumerate();
  if (catalog === undefined) throw new Error('Water demo requires a Catalog source');
  if (!catalog.ok) throw catalog.error;
  const world = app.world;
  type BodyKind = 'river' | 'lake' | 'ocean' | 'custom';
  const bodyKinds: readonly BodyKind[] = ['river', 'lake', 'ocean', 'custom'];
  const bodyHandles = new Map<BodyKind, AssetHandle<'water-body'>>();
  const bodyEntities = new Map<BodyKind, EntityHandle>();
  const riverSegmentEntities: EntityHandle[] = [];
  const riverSegmentMeshHandles: AssetHandle<'mesh'>[] = [];
  let riverMaterialHandle: AssetHandle<'material'> | undefined;
  const bodyPositions: Record<BodyKind, [number, number, number]> = {
    river: [-14, 0.12, 1],
    lake: [-2, 0.12, 1],
    ocean: [7, 0.12, 1],
    custom: [16, 0.12, 1],
  };
  const compactBodyPositions: Record<BodyKind, [number, number, number]> = {
    river: [-4, 0.12, -15],
    lake: [0, 0.12, -5],
    ocean: [0, 0.12, 5],
    custom: [0, 0.12, 15],
  };
  const waterActorPosition = (kind: BodyKind): [number, number, number] =>
    innerWidth / innerHeight < 0.8 ? compactBodyPositions[kind] : bodyPositions[kind];
  const layoutWaterActors = () => {
    const compact = innerWidth / innerHeight < 0.8;
    for (const [kind, entity] of bodyEntities)
      world.set(entity, Transform, { pos: waterActorPosition(kind) }).unwrap();
    for (const entity of riverSegmentEntities)
      world.set(entity, Transform, { pos: waterActorPosition('river') }).unwrap();
    return compact;
  };
  const bodySourceKey = (kind: BodyKind) =>
    kind === 'river' ? 'river/main' : `water/body/${kind}`;
  if (r0Mode)
    for (const kind of bodyKinds)
      bodyHandles.set(
        kind,
        (await assets.load(surfaceEvidenceGuid(bodySourceKey(kind)), 'water-body')).unwrap(),
      );
  if (r0Mode) {
    const riverBody = assets
      .read(requireWaterValue(bodyHandles.get('river')))
      .unwrap() as WaterBodyAsset;
    riverMaterialHandle = (await assets.load(riverBody.surfaceMaterialGuid, 'material')).unwrap();
    for (const guid of riverBody.riverSegmentMeshGuids ?? [])
      riverSegmentMeshHandles.push((await assets.load(guid, 'mesh')).unwrap());
  }
  const spawnRiverSegments = () => {
    if (!riverMaterialHandle) return;
    for (const handle of riverSegmentMeshHandles)
      riverSegmentEntities.push(
        world
          .spawn(
            { component: Transform, data: { pos: waterActorPosition('river') } },
            { component: MeshFilter, data: { assetHandle: handle } },
            { component: MeshRenderer, data: { materials: [riverMaterialHandle] } },
          )
          .unwrap(),
      );
  };
  const despawnRiverSegments = () => {
    for (const entity of riverSegmentEntities.splice(0)) world.despawn(entity).unwrap();
  };
  const spawnWaterActor = (kind: BodyKind) => {
    const entity = world
      .spawn(
        { component: Transform, data: { pos: waterActorPosition(kind) } },
        { component: WaterBodyInstance, data: { body: requireWaterValue(bodyHandles.get(kind)) } },
      )
      .unwrap();
    if (kind === 'river') spawnRiverSegments();
    return entity;
  };
  if (r0Mode) for (const kind of bodyKinds) bodyEntities.set(kind, spawnWaterActor(kind));
  const compactWaterLayout = r0Mode ? layoutWaterActors() : false;
  let zoneHandle: AssetHandle<'water-zone'> | undefined;
  let zoneEntity: EntityHandle | undefined;
  const zoneButton = r0Mode ? document.querySelector<HTMLButtonElement>('#bind-zone') : null;
  const bindZone = async () => {
    if (!zoneHandle)
      zoneHandle = (
        await assets.load(surfaceEvidenceGuid('water/zone/r0-demo'), 'water-zone')
      ).unwrap();
    if (zoneEntity === undefined)
      zoneEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
    if (zoneButton) zoneButton.textContent = 'Unmount shared Zone';
  };
  zoneButton?.addEventListener('click', () => {
    if (zoneEntity !== undefined) {
      world.despawn(zoneEntity).unwrap();
      zoneEntity = undefined;
      zoneButton.textContent = 'Mount shared Zone';
    } else void bindZone();
  });
  const bodyActors = r0Mode ? document.querySelector<HTMLElement>('#body-actors') : null;
  if (r0Mode && !bodyActors) throw new Error('Missing water body actor panel');
  const actorRows = new Map<
    BodyKind,
    { toggle: HTMLButtonElement; reload: HTMLButtonElement; meta: HTMLElement }
  >();
  let duplicateZoneWarning: HTMLElement | undefined;
  if (bodyActors) {
    bodyActors.innerHTML = bodyKinds
      .map((kind) => {
        const bodyName = (
          { river: 'River', lake: 'Lake', ocean: 'Ocean', custom: 'Custom' } as const
        )[kind];
        const reloadLabel = kind === 'river' ? 'Replace local river width' : 'Hot reload';
        return `<div class="body-row"><h3 class="kind-${kind}">${bodyName}</h3><button data-action="toggle" data-kind="${kind}">Mount instance</button><button data-action="reload" data-kind="${kind}" disabled>${reloadLabel}</button><div class="body-meta"></div></div>`;
      })
      .join('');
    for (const kind of bodyKinds) {
      const row = bodyActors.querySelector<HTMLElement>(
        `.body-row button[data-kind="${kind}"]`,
      )?.parentElement;
      const toggle = row?.querySelector<HTMLButtonElement>('button[data-action="toggle"]');
      const reload = row?.querySelector<HTMLButtonElement>('button[data-action="reload"]');
      const meta = row?.querySelector<HTMLElement>('.body-meta');
      if (!toggle || !reload || !meta)
        throw new Error(`Missing stable WaterBody controls for ${kind}`);
      actorRows.set(kind, { toggle, reload, meta });
    }
    duplicateZoneWarning = document.createElement('p');
    duplicateZoneWarning.className = 'abi';
    duplicateZoneWarning.hidden = true;
    bodyActors.append(duplicateZoneWarning);
  }
  const panelsButton = document.querySelector<HTMLButtonElement>('#toggle-panels');
  panelsButton?.addEventListener('click', () => {
    const hidden = document.body.classList.toggle('panel-hidden');
    panelsButton.textContent = hidden ? '☰' : 'Hide panels';
    panelsButton.title = hidden ? 'Show panels' : 'Hide panels';
    panelsButton.setAttribute('aria-label', panelsButton.title);
    panelsButton.setAttribute('aria-expanded', String(!hidden));
  });
  bodyActors?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const kind = button?.dataset.kind as BodyKind | undefined;
    if (!button || !kind || !bodyKinds.includes(kind)) return;
    if (button.dataset.action === 'toggle') {
      const current = bodyEntities.get(kind);
      if (current !== undefined) {
        world.despawn(current).unwrap();
        bodyEntities.delete(kind);
        if (kind === 'river') despawnRiverSegments();
      } else bodyEntities.set(kind, spawnWaterActor(kind));
    } else if (button.dataset.action === 'reload') {
      if (kind !== 'river') return;
      const handle = requireWaterValue(bodyHandles.get(kind));
      const current = assets.read(handle).unwrap();
      if (current.kind !== 'water-body') throw new Error('Water body handle changed kind');
      const currentWidthM = current.spline.points[0]?.widthM ?? 8;
      const nextWidthM = currentWidthM < 16 ? 16 : 8;
      const scale = nextWidthM / currentWidthM;
      const centerZ =
        current.queryFootprint.reduce((sum, point) => sum + point[1], 0) /
        current.queryFootprint.length;
      const replaced = assets.replace(handle, {
        ...current,
        spline: {
          ...current.spline,
          points: current.spline.points.map((point) => ({ ...point, widthM: nextWidthM })),
        },
        queryFootprint: current.queryFootprint.map(
          ([x, z]) => [x, centerZ + (z - centerZ) * scale] as const,
        ),
      } as WaterBodyAsset);
      if (!replaced.ok) throw replaced.error;
    }
  });
  const refreshWaterActorPanel = () => {
    if (!bodyActors) return;
    const water = world.getResource(WATER_SYSTEM_RESOURCE) as unknown as {
      snapshots(): readonly {
        guid: string;
        sourceAssetGuid: string;
        sourceVersion: string;
        sourcePublication?: { sourceRevision: string; generation: number; digest: string };
        sceneGeneration: number;
        worldMatrixM: readonly number[];
        binding: { kind: string; zoneGuid?: string };
        outputs: Record<string, 'unsupported' | 'not-requested' | 'zone-unbound'>;
        dirty: ReadonlySet<string>;
        asset: {
          baseHeightM: number;
          spline: { points: readonly { widthM: number }[] };
          queryFootprint: readonly (readonly [number, number])[];
        };
      }[];
      materialStatuses(
        guid: string,
        resolve: (guid: string) =>
          | { kind: 'unavailable' | 'invalid-kind' }
          | {
              kind: 'valid';
              asset: {
                parent?: unknown;
                surface?: { model: string };
                passes?: readonly { name: string }[];
              };
            },
      ): readonly {
        slot: string;
        reference: string;
        material?: { form: string };
        waterAbi: string;
      }[];
    };
    const snapshots = water.snapshots();
    const zoneState = world.getResource(WATER_SCENE_STATUS_RESOURCE) as unknown as {
      duplicateZoneAssetGuids: readonly string[];
    };
    for (const kind of bodyKinds) {
      const snapshot = snapshots.find(
        (entry) => entry.sourceAssetGuid === surfaceEvidenceGuid(bodySourceKey(kind)),
      );
      const mounted = bodyEntities.has(kind);
      const binding =
        snapshot?.binding.kind === 'bound'
          ? 'Zone bound'
          : snapshot?.binding.kind === 'zone-unbound'
            ? 'Waiting for Zone'
            : 'Unmounted';
      const position = snapshot?.worldMatrixM[12] ?? bodyPositions[kind][0];
      const slots = snapshot
        ? water.materialStatuses(snapshot.guid, (guid) =>
            registryWaterMaterialReference(assets, guid),
          )
        : [];
      const slotNames: Readonly<Record<string, string>> = {
        surface: 'Surface',
        'river-to-lake-transition': 'River-to-lake transition',
        'river-to-ocean-transition': 'River-to-ocean transition',
        'water-info': 'WaterInfo',
        lod: 'LOD',
        'underwater-post-process': 'Underwater post-process',
      };
      const referenceNames: Readonly<Record<string, string>> = {
        valid: 'Valid reference',
        unavailable: 'Not loaded',
        'invalid-kind': 'Invalid kind',
      };
      const materialSummary = slots
        .map(
          (slot) =>
            `${slotNames[slot.slot] ?? slot.slot}: ${referenceNames[slot.reference] ?? slot.reference}${slot.material ? ` (${slot.material.form === 'child' ? 'Child material' : 'Root material'})` : ''} · Water material interface unsupported`,
        )
        .join('<br>');
      const refreshActorRow = () => {
        const row = requireWaterValue(actorRows.get(kind));
        const toggleText = mounted ? 'Unmount instance' : 'Mount instance';
        if (row.toggle.textContent !== toggleText) row.toggle.textContent = toggleText;
        const reloadDisabled = !mounted || kind !== 'river';
        if (row.reload.disabled !== reloadDisabled) row.reload.disabled = reloadDisabled;
        const summarizeRiverWidth = () => {
          const riverWidth =
            kind === 'river' && snapshot ? snapshot.asset.spline.points[0]?.widthM : undefined;
          const queryWidth =
            kind === 'river' && snapshot
              ? Math.max(...snapshot.asset.queryFootprint.map((point) => point[1])) -
                Math.min(...snapshot.asset.queryFootprint.map((point) => point[1]))
              : undefined;
          const widthSummary =
            riverWidth === undefined || queryWidth === undefined
              ? ''
              : `<br>River width ${riverWidth.toFixed(1)} m · Query footprint ${queryWidth.toFixed(1)} m`;
          return widthSummary;
        };
        const widthSummary = summarizeRiverWidth();
        const outputNames: Readonly<Record<string, string>> = {
          geometry: 'Geometry',
          waterInfo: 'WaterInfo',
          waterMesh: 'WaterMesh',
          terrainBrush: 'Terrain brush',
          collision: 'Collision',
          query: 'Query',
          material: 'Material',
        };
        const outputs = snapshot
          ? Object.entries(snapshot.outputs)
              .map(
                ([output, value]) =>
                  `${outputNames[output] ?? output}: ${value === 'unsupported' ? 'Unsupported' : value === 'zone-unbound' ? 'Zone unbound' : 'Not requested'}`,
              )
              .join(' · ')
          : '';
        const dirtyNames = snapshot
          ? [...snapshot.dirty].map((kind) => outputNames[kind] ?? kind).join(', ')
          : '';
        const publication = snapshot?.sourcePublication
          ? ` · Pack ${snapshot.sourcePublication.sourceRevision} / ${snapshot.sourcePublication.generation}`
          : ' · Pack publication not recorded';
        const metaHtml = `Instance ${snapshot?.guid ?? 'Unmounted'}<br>Source ${snapshot?.sourceAssetGuid ?? '—'}<br>Registry local version ${snapshot?.sourceVersion ?? '—'}${snapshot ? publication : ''}<br>Scene generation ${snapshot?.sceneGeneration ?? '—'} · ${binding} · World X ${position.toFixed(1)} m${widthSummary}${outputs ? `<br>Outputs ${outputs}` : ''}${dirtyNames ? `<br>Pending ${dirtyNames}` : ''}${materialSummary ? `<br>${materialSummary}` : ''}`;
        if (row.meta.innerHTML !== metaHtml) row.meta.innerHTML = metaHtml;
      };
      refreshActorRow();
    }
    const duplicateText = zoneState.duplicateZoneAssetGuids.length
      ? `Ambiguous Zone instances: ${zoneState.duplicateZoneAssetGuids.join(', ')}`
      : '';
    if (duplicateZoneWarning && duplicateZoneWarning.textContent !== duplicateText)
      duplicateZoneWarning.textContent = duplicateText;
    const hideDuplicateWarning = duplicateText.length === 0;
    if (duplicateZoneWarning && duplicateZoneWarning.hidden !== hideDuplicateWarning)
      duplicateZoneWarning.hidden = hideDuplicateWarning;
    const count = String(snapshots.length);
    if (document.body.dataset.waterBodies !== count) document.body.dataset.waterBodies = count;
    const zoneBound = String(
      snapshots.length > 0 && snapshots.every((snapshot) => snapshot.binding.kind === 'bound'),
    );
    if (document.body.dataset.zoneBound !== zoneBound) document.body.dataset.zoneBound = zoneBound;
  };
  const waterStatusTimer = bodyActors ? window.setInterval(refreshWaterActorPanel, 100) : undefined;
  let waterMaterialHandle: AssetHandle<'material'> | undefined;
  let waterEntity: EntityHandle | undefined;
  const loadMaterial = async (name: string) =>
    (await assets.load(surfaceEvidenceGuid(`material/${name}`), 'material')).unwrap();
  if (!r0Mode) {
    const [water, sand, rock, wood, foliage] = await Promise.all(
      ['water-shore', 'shore-sand', 'shore-rock', 'shore-wood', 'shore-foliage'].map(loadMaterial),
    );
    waterMaterialHandle = water;
    if (!water || !sand || !rock || !wood || !foliage)
      throw new Error('Missing shoreline materials');
    const cube = app.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const sphere = app.assets.create(createSphereGeometry(1, 16, 12).unwrap()).unwrap();
    const spawn = (
      material: AssetHandle<'material'>,
      pos: number[],
      scale: number[],
      rounded = false,
      rot = quat.create(),
    ) => {
      return world
        .spawn(
          { component: Transform, data: { pos, scale, quat: rot } },
          { component: MeshFilter, data: { assetHandle: rounded ? sphere : cube } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    };
    // One continuous sloped beach; the same opaque bed remains visible through the medium.
    spawn(
      sand,
      [0, -1.05, -1],
      [80, 1, 200],
      false,
      quat.fromEuler(quat.create(), 0, 0, -0.13, 'XYZ'),
    );
    for (let i = 0; i < 44; i++) {
      const x = -6.5 + Math.sin(i * 2.4) * 3.2;
      const z = -10 + ((i * 3.71) % 21);
      const radius = 0.16 + ((i * 0.13) % 0.48);
      spawn(rock, [x, -0.5 - x * 0.13, z], [radius * 1.7, radius * 0.6, radius], true);
    }
    // A few distinct submerged stones make refraction and depth legible.
    for (let i = 0; i < 14; i++) {
      const x = -2.8 + (i % 4) * 1.5;
      const z = -3 + Math.floor(i / 4) * 1.6;
      spawn(rock, [x, -0.48 - x * 0.13, z], [0.24, 0.11, 0.38], true);
    }
    for (let i = 0; i < 5; i++) {
      const x = -9 - Math.sin(i) * 1.3;
      const z = -8 + i * 3.6;
      spawn(wood, [x, 1.65, z], [0.16, 2.7, 0.16]);
      spawn(foliage, [x, 3.1, z], [1.25, 1.9, 1.15], true);
    }
    for (let i = 0; i < 12; i++) spawn(wood, [-3.5 + i * 0.36, 0.22, -4.4], [0.32, 0.15, 1.6]);
    for (const x of [-3.5, 0.45])
      for (const z of [-5, -3.8]) spawn(wood, [x, -0.35, z], [0.14, 1.5, 0.14]);
    waterEntity = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, -1], quat: quat.fromEuler(quat.create(), -Math.PI / 2, 0, 0, 'XYZ') },
        },
        {
          component: MeshFilter,
          data: {
            assetHandle: app.assets.create(createPlaneGeometry(200, 200).unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: { materials: [water] },
        },
      )
      .unwrap();
  }
  const reflectionTarget = r0Mode
    ? undefined
    : app.renderer.createRenderTarget({
        shape: '2d',
        width: 512,
        height: 512,
        format: 'rgba16float',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: true,
      });
  if (reflectionTarget && !reflectionTarget.ok) throw reflectionTarget.error;
  if (reflectionTarget?.ok)
    document
      .querySelector<HTMLSelectElement>('#reflection-resolution')
      ?.addEventListener('change', (event) => {
        const size = Number((event.target as HTMLSelectElement).value);
        const resized = app.renderer.resizeRenderTarget(reflectionTarget.value, {
          shape: '2d',
          width: size,
          height: size,
          format: 'rgba16float',
          mipLevels: 1,
          sampleCount: 1,
          sampled: true,
          readback: true,
        });
        if (!resized.ok) throw resized.error;
      });
  if (!r0Mode)
    document
      .querySelector<HTMLSelectElement>('#reflection-interval')
      ?.addEventListener('change', (event) => {
        world
          .set(camera, PlanarReflection, {
            updateIntervalFrames: Number((event.target as HTMLSelectElement).value),
          })
          .unwrap();
      });
  const cameraPosition: [number, number, number] =
    r0Mode && compactWaterLayout ? [0, 24, 40] : r0Mode ? [2, 16, 31] : [8, 7, 11];
  let cameraYaw = 0;
  let cameraPitch = 0.49;
  let canvasDragging = false;
  const beginCameraDrag = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    canvasDragging = true;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const endCameraDrag = () => {
    canvasDragging = false;
  };
  if (r0Mode) {
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', beginCameraDrag);
    canvas.addEventListener('pointerup', endCameraDrag);
    canvas.addEventListener('pointercancel', endCameraDrag);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('pointerup', endCameraDrag);
  }
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: cameraPosition,
          quat: quat.fromLookAt(
            quat.create(),
            cameraPosition,
            r0Mode ? [compactWaterLayout ? 0 : 2, 0, 1] : [-2, 0, -1],
            [0, 1, 0],
          ),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 3.2,
            aspect: canvas.width / canvas.height,
            near: 0.1,
            far: 300,
          }),
          tonemap: TONEMAP_ACES_FILMIC,
          clearColor: [0.3, 0.5, 0.6, 1],
        },
      },
    )
    .unwrap();
  if (r0Mode)
    window.addEventListener('resize', () => {
      canvas.width = Math.max(1, Math.floor(innerWidth * devicePixelRatio));
      canvas.height = Math.max(1, Math.floor(innerHeight * devicePixelRatio));
      if (innerWidth / innerHeight < 0.8) {
        cameraPosition.splice(0, 3, 0, 24, 40);
        cameraPitch = Math.atan2(24, 39);
      } else {
        cameraPosition.splice(0, 3, 2, 16, 31);
        cameraPitch = 0.49;
      }
      layoutWaterActors();
      cameraYaw = 0;
      world.set(camera, Camera, { aspect: canvas.width / canvas.height }).unwrap();
      const direction = [
        Math.sin(cameraYaw) * Math.cos(cameraPitch),
        -Math.sin(cameraPitch),
        -Math.cos(cameraYaw) * Math.cos(cameraPitch),
      ];
      world
        .set(camera, Transform, {
          pos: cameraPosition,
          quat: quat.fromLookAt(
            quat.create(),
            cameraPosition,
            [
              cameraPosition[0] + requireWaterValue(direction[0]),
              cameraPosition[1] + requireWaterValue(direction[1]),
              cameraPosition[2] + requireWaterValue(direction[2]),
            ],
            [0, 1, 0],
          ),
        })
        .unwrap();
    });
  if (r0Mode)
    world
      .addSystem(
        Update,
        defineSystem({
          name: 'water-demo-free-camera',
          queries: [],
          fn: () => {
            const input = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY) as InputSnapshot;
            if (!input || document.activeElement !== canvas) return;
            const delta = canvasDragging ? input.mouse.movementDelta : { x: 0, y: 0 };
            cameraYaw += delta.x * 0.003;
            cameraPitch = Math.max(-1.35, Math.min(1.35, cameraPitch + delta.y * 0.003));
            const forward: [number, number, number] = [
              Math.sin(cameraYaw),
              0,
              -Math.cos(cameraYaw),
            ];
            const right: [number, number, number] = [Math.cos(cameraYaw), 0, Math.sin(cameraYaw)];
            const speed = 14 * world.getResource(Time).delta;
            let moved = false;
            if (input.keyboard.downCode('KeyW')) {
              cameraPosition[0] += forward[0] * speed;
              cameraPosition[2] += forward[2] * speed;
              moved = true;
            }
            if (input.keyboard.downCode('KeyS')) {
              cameraPosition[0] -= forward[0] * speed;
              cameraPosition[2] -= forward[2] * speed;
              moved = true;
            }
            if (input.keyboard.downCode('KeyD')) {
              cameraPosition[0] += right[0] * speed;
              cameraPosition[2] += right[2] * speed;
              moved = true;
            }
            if (input.keyboard.downCode('KeyA')) {
              cameraPosition[0] -= right[0] * speed;
              cameraPosition[2] -= right[2] * speed;
              moved = true;
            }
            if (input.keyboard.downCode('KeyE')) {
              cameraPosition[1] += speed;
              moved = true;
            }
            if (input.keyboard.downCode('KeyQ')) {
              cameraPosition[1] -= speed;
              moved = true;
            }
            if (delta.x !== 0 || delta.y !== 0 || moved) {
              const direction = [
                Math.sin(cameraYaw) * Math.cos(cameraPitch),
                -Math.sin(cameraPitch),
                -Math.cos(cameraYaw) * Math.cos(cameraPitch),
              ];
              world
                .set(camera, Transform, {
                  pos: cameraPosition,
                  quat: quat.fromLookAt(
                    quat.create(),
                    cameraPosition,
                    [
                      cameraPosition[0] + requireWaterValue(direction[0]),
                      cameraPosition[1] + requireWaterValue(direction[1]),
                      cameraPosition[2] + requireWaterValue(direction[2]),
                    ],
                    [0, 1, 0],
                  ),
                })
                .unwrap();
            }
          },
        }),
      )
      .unwrap();
  if (reflectionTarget?.ok)
    world
      .addComponent(camera, {
        component: PlanarReflection,
        data: {
          target: world.allocSharedRef('RenderTarget', reflectionTarget.value),
          updateIntervalFrames: 2,
        },
      })
      .unwrap();
  if (!r0Mode)
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0.3, -0.9, -0.4],
          color: [1, 0.93, 0.8],
          intensity: 2.5,
          castShadow: true,
        },
      })
      .unwrap();
  if (!r0Mode) {
    const environment = (
      await assets.load('81eec382-392f-5a93-8998-0ecf11ef7990', 'equirect')
    ).unwrap();
    world.spawn({ component: Skylight, data: { equirect: environment, intensity: 0.85 } }).unwrap();
    world.spawn({ component: SkyboxBackground, data: { equirect: environment } }).unwrap();
  }
  if (r0Mode)
    world
      .addSystem(
        Update,
        defineSystem({
          name: 'water-body-debug-bounds',
          queries: [],
          fn: () => {
            const waterSystem = world.getResource(WATER_SYSTEM_RESOURCE) as unknown as {
              snapshots(): readonly {
                worldMatrixM: readonly number[];
                asset: {
                  type: BodyKind;
                  baseHeightM: number;
                  maxWaveHeightM: number;
                  queryFootprint: readonly (readonly [number, number])[];
                };
              }[];
            };
            for (const snapshot of waterSystem.snapshots()) {
              const matrix = snapshot.worldMatrixM;
              const yLow = snapshot.asset.baseHeightM - snapshot.asset.maxWaveHeightM;
              const yHigh = snapshot.asset.baseHeightM + snapshot.asset.maxWaveHeightM;
              const min = [Infinity, Infinity, Infinity];
              const max = [-Infinity, -Infinity, -Infinity];
              for (const [x, z] of snapshot.asset.queryFootprint)
                for (const y of [yLow, yHigh]) {
                  const point = [
                    requireWaterValue(matrix[0]) * x +
                      requireWaterValue(matrix[4]) * y +
                      requireWaterValue(matrix[8]) * z +
                      requireWaterValue(matrix[12]),
                    requireWaterValue(matrix[1]) * x +
                      requireWaterValue(matrix[5]) * y +
                      requireWaterValue(matrix[9]) * z +
                      requireWaterValue(matrix[13]),
                    requireWaterValue(matrix[2]) * x +
                      requireWaterValue(matrix[6]) * y +
                      requireWaterValue(matrix[10]) * z +
                      requireWaterValue(matrix[14]),
                  ];
                  for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.min(
                      requireWaterValue(min[axis]),
                      requireWaterValue(point[axis]),
                    );
                    max[axis] = Math.max(
                      requireWaterValue(max[axis]),
                      requireWaterValue(point[axis]),
                    );
                  }
                }
              const boundsColor =
                snapshot.asset.type === 'river'
                  ? [0.22, 0.84, 0.98, 1]
                  : snapshot.asset.type === 'lake'
                    ? [1, 0.78, 0.22, 1]
                    : snapshot.asset.type === 'ocean'
                      ? [1, 0.38, 0.55, 1]
                      : [0.56, 0.95, 0.44, 1];
              app.debugDraw?.aabb(
                Float32Array.from(min) as unknown as Parameters<
                  NonNullable<typeof app.debugDraw>['aabb']
                >[0],
                Float32Array.from(max) as unknown as Parameters<
                  NonNullable<typeof app.debugDraw>['aabb']
                >[1],
                boundsColor,
              );
              app.debugDraw?.axes(
                Float32Array.from(matrix) as unknown as Parameters<
                  NonNullable<typeof app.debugDraw>['axes']
                >[0],
                1.25,
              );
            }
          },
        }),
      )
      .unwrap();
  if (waterMaterialHandle && waterEntity) {
    const water = waterMaterialHandle;
    const schema = assets.read(water).unwrap().surface?.dynamicInput;
    if (!schema) throw new Error('Water material has no event schema');
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'shore-footsteps',
      pageId: 1,
      schema,
    }).unwrap();
    page.reconfigureDevice(app.renderer.inspect().frame.deviceGeneration).unwrap();
    for (let i = 0; i < 8; i++)
      page.writeRecord(i, { position: [0, 0, 0], time: -100, eventId: i }).unwrap();
    const ranges = [
      page
        .reserveRange({
          domain: 'shore',
          recordStart: 0,
          recordCount: 8,
          instanceIndex: 0,
          member: {
            worldIdentity: world.identity,
            entityKey: waterEntity,
            drawItemIndex: 0,
            instanceOrdinal: 0,
          },
        })
        .unwrap(),
    ];
    let revision = 1;
    let eventId = 0;
    let time = 0;
    let animate = true;
    let pendingStep = false;
    let low = false;
    document.querySelector('#step')?.addEventListener('click', () => {
      pendingStep = true;
    });
    document.querySelector<HTMLInputElement>('#waves')?.addEventListener('change', (event) => {
      animate = (event.target as HTMLInputElement).checked;
    });
    document.querySelector('#view')?.addEventListener('click', (event) => {
      low = !low;
      const eye = low ? [6, 1.4, 9] : [8, 7, 11];
      world
        .set(camera, Transform, {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [-2, 0, -1], [0, 1, 0]),
        })
        .unwrap();
      (event.target as HTMLButtonElement).textContent = low ? 'Shore overview' : 'Low water view';
    });
    const systemToken1 = defineSystem({
      name: 'shore-water-events',
      queries: [],
      fn: () => {
        if (animate) time += world.getResource(Time).delta;
        if (pendingStep) {
          page
            .writeRecord(eventId % 8, {
              position: [-2 + (eventId % 3) * 0.55, 0, 1.8],
              time,
              eventId: ++eventId,
            })
            .unwrap();
          revision++;
          pendingStep = false;
        }
        app.renderer.setSurfaceDynamicInput({
          page,
          ranges,
          frameTime: time,
          projectionRevision: revision,
        });
      },
    });
    world.addSystem(Update, systemToken1).unwrap();
  }
  const smoke = new URLSearchParams(location.search).has('smoke');
  if (smoke)
    Object.assign(globalThis, {
      __planarWater: {
        app,
        world,
        camera,
        ...(reflectionTarget?.ok ? { reflectionTarget: reflectionTarget.value } : {}),
      },
      ...(r0Mode ? { __waterR0: { app, world, bodyHandles, bodyEntities, bindZone } } : {}),
    });
  let completedFrames = 0;
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      console.error(JSON.stringify(event.error));
      status.textContent = `Render error: ${event.error.code}`;
      document.body.dataset.error = event.error.code;
    }
    if (smoke && event.kind === 'frame-submitted') {
      void event.receipt.completed.then((result) => {
        if (result.ok) document.body.dataset.frames = String(++completedFrames);
        else document.body.dataset.error = result.error.code;
      });
    }
  });
  app.start().unwrap();
  status.textContent = r0Mode
    ? 'Four WaterBody Scene instance kinds mounted'
    : 'Ready · Step into the shallows to send ripples across the surface.';
  document.body.dataset.ready = 'true';
  window.addEventListener(
    'pagehide',
    () => {
      if (waterStatusTimer !== undefined) window.clearInterval(waterStatusTimer);
      void app.dispose();
    },
    { once: true },
  );
} catch (error) {
  status.textContent = `Unable to render: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
}
