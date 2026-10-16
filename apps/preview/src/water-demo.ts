import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  createSphereGeometry,
} from '@forgeax/engine-geometry';
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
import { Transform } from '@forgeax/engine-scene';
import type { EquirectAsset, MaterialAsset } from '@forgeax/engine-types';
import { surfaceEvidenceGuid } from './surface-standard-evidence-identity';

const canvas = document.querySelector<HTMLCanvasElement>('#water');
const status = document.querySelector<HTMLElement>('#status');
if (!canvas || !status) throw new Error('Missing water demo shell');
canvas.width = Math.min(innerWidth * devicePixelRatio, 1920);
canvas.height = Math.round((canvas.width * innerHeight) / innerWidth);
try {
  const app = (
    await createApp(
      canvas,
      {
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        ...(import.meta.env.DEV && runtimeBinding
          ? { importTransport: createRuntimeAssetImportTransport(runtimeBinding) }
          : {}),
      },
    )
  ).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('Water demo requires the App asset registry');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  await assets.refreshCatalog();
  const world = app.world;
  const loadMaterial = async (name: string) =>
    (
      await assets.loadByGuid<MaterialAsset>(
        assets.parseGuid(surfaceEvidenceGuid(`material/${name}`)),
      )
    ).unwrap();
  const [water, sand, rock, wood, foliage] = await Promise.all(
    ['water-shore', 'shore-sand', 'shore-rock', 'shore-wood', 'shore-foliage'].map(loadMaterial),
  );
  if (!water || !sand || !rock || !wood || !foliage) throw new Error('Missing shoreline materials');
  const cube = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const sphere = world.allocSharedRef('MeshAsset', createSphereGeometry(1, 16, 12).unwrap());
  const materialHandles = new Map(
    [sand, rock, wood, foliage].map((material) => [
      material,
      world.allocSharedRef('MaterialAsset', material),
    ]),
  );
  const spawn = (
    material: MaterialAsset,
    pos: number[],
    scale: number[],
    rounded = false,
    rot = quat.create(),
  ) => {
    const materialHandle = materialHandles.get(material);
    if (materialHandle === undefined) throw new Error('Undeclared shoreline material');
    return world
      .spawn(
        { component: Transform, data: { pos, scale, quat: rot } },
        { component: MeshFilter, data: { assetHandle: rounded ? sphere : cube } },
        {
          component: MeshRenderer,
          data: {
            materials: [materialHandle],
          },
        },
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
  const waterEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, -1], quat: quat.fromEuler(quat.create(), -Math.PI / 2, 0, 0, 'XYZ') },
      },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', createPlaneGeometry(200, 200).unwrap()),
        },
      },
      {
        component: MeshRenderer,
        data: { materials: [world.allocSharedRef('MaterialAsset', water)] },
      },
    )
    .unwrap();
  const reflectionTarget = app.renderer.createRenderTarget({
    shape: '2d',
    width: 512,
    height: 512,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: true,
  });
  if (!reflectionTarget.ok) throw reflectionTarget.error;
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
  document
    .querySelector<HTMLSelectElement>('#reflection-interval')
    ?.addEventListener('change', (event) => {
      world
        .set(camera, PlanarReflection, {
          updateIntervalFrames: Number((event.target as HTMLSelectElement).value),
        })
        .unwrap();
    });
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [8, 7, 11],
          quat: quat.fromLookAt(quat.create(), [8, 7, 11], [-2, 0, -1], [0, 1, 0]),
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
  world
    .addComponent(camera, {
      component: PlanarReflection,
      data: {
        target: world.allocSharedRef('RenderTarget', reflectionTarget.value),
        updateIntervalFrames: 2,
      },
    })
    .unwrap();
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
  const sky = (
    await assets.loadByGuid<EquirectAsset>(assets.parseGuid('81eec382-392f-5a93-8998-0ecf11ef7990'))
  ).unwrap();
  const environment = world.allocSharedRef('EquirectAsset', sky);
  world.spawn({ component: Skylight, data: { equirect: environment, intensity: 0.85 } }).unwrap();
  world.spawn({ component: SkyboxBackground, data: { equirect: environment } }).unwrap();
  const schema = water.surface?.dynamicInput;
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
  world
    .addSystem(Update, {
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
    })
    .unwrap();
  const smoke = new URLSearchParams(location.search).has('smoke');
  if (smoke)
    Object.assign(globalThis, {
      __planarWater: {
        app,
        world,
        camera,
        reflectionTarget: reflectionTarget.value,
      },
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
  status.textContent = 'Ready · Step into the shallows to send ripples across the surface.';
  document.body.dataset.ready = 'true';
  window.addEventListener(
    'pagehide',
    () => {
      void app.dispose();
    },
    { once: true },
  );
} catch (error) {
  status.textContent = `Unable to render: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
}
