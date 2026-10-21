import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
// apps/learn-render/5.advanced-lighting/7.bloom/src/index.ts
// LearnOpenGL section 5.7 - Bloom.
//
// Faithful port of the LearnOpenGL 5.7 Bloom scene
// (src/5.advanced_lighting/7.bloom/bloom.cpp): a large wood floor, six
// container2 wooden boxes scattered with assorted positions/rotations/
// scales, four bright "light box" cubes, and four HDR point lights whose
// colours run well past 1.0 (up to 15.0). The bright light-box cubes are
// the bloom source: each is an unlit cube painted with its light colour
// (mirroring the tutorial's 7.light_box.fs, which writes lightColor
// straight to FragColor), so their pixels blow past the Bloom extraction
// threshold of 1.0 and glow.
//
// Bloom is opt-in via Camera fields (bloom, bloomThreshold, bloomIntensity,
// bloomSmoothWidth/bloomRadius) + Reinhard-extended tonemap. The engine declares the
// five-level multiscale chain (downsample -> upsample -> composite);
// no custom pipeline code lives here. Contrast with 6.hdr's custom
// RenderPipeline paradigm and apps/hello/bloom (which proves the bloom
// infrastructure and toggles it at runtime via Space).
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example-specific glue"  LO 5.7 scene-specific constants + materials
//   - "// 3. bootstrap"       entry point wiring (1)+(2) + HUD

// 1. engine usage
import { type App } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { quat } from '@forgeax/engine/math';

import { Transform } from '@forgeax/engine/scene';

import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';



import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';


// 2. example-specific glue



// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/
//   wood.png       GUID 019e3969-1d48-7c3b-ac24-6d68f457065f
//   container2.png GUID 019e3969-1d46-7945-a75a-ef97d537531e
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const CONTAINER2_GUID_STR = '019e3969-1d46-7945-a75a-ef97d537531e';

// Bloom configuration. threshold=1.0 only filters HDR-bright pixels (the
// light boxes); intensity/scatter match hello/bloom's migrated Camera config.
const BLOOM_THRESHOLD = 1.0;
const BLOOM_INTENSITY = 1.0;

// Reinhard-extended exposure analogue. The bloom_final tonemap in the
// tutorial uses exposure=1.0.
const TONEMAP_EXPOSURE = 1.0;

// HDR light colours (bloom.cpp lightColors). Channels exceed 1.0 so the
// light boxes blow past the Bloom extraction threshold and glow.
const LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [5.0, 5.0, 5.0],
  [10.0, 0.0, 0.0],
  [0.0, 0.0, 15.0],
  [0.0, 5.0, 0.0],
];

// Light positions (bloom.cpp lightPositions). Shared by the point lights
// and the bright light-box cubes that visualise them.
const LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.5, 1.5],
  [-4.0, 0.5, -3.0],
  [3.0, 0.5, 1.0],
  [-0.8, 2.4, -1.0],
];

// Each light box is a unit cube scaled to 0.25 (bloom.cpp light cube scale).
const LIGHT_BOX_SCALE = 0.25;

// PointLight intensity/range. The tutorial bakes brightness into the light
// colour itself; here colour stays in [0,1]-ish proportions per channel via
// LIGHT_COLORS (which already carry the HDR magnitude), driven at unit
// intensity. Range covers the ~12-unit floor.
const POINT_LIGHT_INTENSITY = 1.0;
const POINT_LIGHT_RANGE = 30.0;

// Wood floor: a large flat box centred below the scene (bloom.cpp:
// translate (0,-1,0), scale (12.5, 0.5, 12.5)). The builtin cube spans
// [-0.5,0.5], so scale maps directly to full extents.
const FLOOR_POS_Y = -1.0;
const FLOOR_SCALE_X = 12.5;
const FLOOR_SCALE_Y = 0.5;
const FLOOR_SCALE_Z = 12.5;

// Six wooden container boxes (bloom.cpp scenery cubes). Each entry is
// [x, y, z, uniformScale, rotAxisXYZ, rotDeg]; rotDeg=0 means no
// rotation. Axes are normalised by quat.fromAxisAngle.
type BoxSpec = {
  pos: readonly [number, number, number];
  scale: number;
  axis: readonly [number, number, number];
  deg: number;
};
const CONTAINER_BOXES: readonly BoxSpec[] = [
  { pos: [0.0, 1.5, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [2.0, 0.0, 1.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
  { pos: [-1.0, -1.0, 2.0], scale: 1.0, axis: [1, 0, 1], deg: 60 },
  { pos: [0.0, 2.7, 4.0], scale: 1.25, axis: [1, 0, 1], deg: 23 },
  { pos: [-2.0, 1.0, -3.0], scale: 1.0, axis: [1, 0, 1], deg: 124 },
  { pos: [-3.0, 0.0, 0.0], scale: 0.5, axis: [1, 0, 0], deg: 0 },
];

// Camera at (0, 0, 5) looking down -Z (bloom.cpp Camera(0,0,5)).
const CAMERA_POS_X = 0.0;
const CAMERA_POS_Y = 0.0;
const CAMERA_POS_Z = 5.0;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

const DEG2RAD = Math.PI / 180;

type LearnRenderErrorRecord = {
  readonly asset?: string;
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
};

function toLearnRenderError(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}, asset?: string): LearnRenderErrorRecord {
  return {
    ...(asset === undefined ? {} : { asset }),
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.7 bloom] missing <canvas id='app'> in index.html");
}

const bootstrapPromise = bootstrap(canvas);
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.7 bloom] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  exposeLearnRenderTestApp(app, target);
  const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  app.onError((error) => {
    const record = toLearnRenderError(error);
    console.error('[learn-render 5.7 bloom] app.onError:', record);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: LearnRenderErrorRecord[];
        __captureBloom?: () => Promise<Uint8Array>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push(record);
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.7 bloom] asset owner is unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Load textures by GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  const container2GuidRes = AssetGuid.parse(CONTAINER2_GUID_STR);
  if (!woodGuidRes.ok || !container2GuidRes.ok) {
    console.error('[learn-render 5.7 bloom] GUID parse failed');
    return;
  }

  const [woodTexRes, container2TexRes] = await Promise.all([
    assets.load(woodGuidRes.value, 'texture'),
    assets.load(container2GuidRes.value, 'texture'),
  ]);
  if (!woodTexRes.ok || !container2TexRes.ok) {
    const failures = [
      woodTexRes.ok ? undefined : toLearnRenderError(woodTexRes.error, 'wood'),
      container2TexRes.ok ? undefined : toLearnRenderError(container2TexRes.error, 'container2'),
    ].filter((failure): failure is LearnRenderErrorRecord => failure !== undefined);
    const bus = (globalThis as unknown as {
      __learnRenderErrors?: LearnRenderErrorRecord[];
    }).__learnRenderErrors;
    if (bus !== undefined) failures.forEach((failure) => bus.push(failure));
    console.error(`[learn-render 5.7 bloom] load failed: ${JSON.stringify({ failures })}`);
    return;
  }
  const woodTex = woodTexRes.value;
  const container2Tex = container2TexRes.value;

  // Wood floor + container boxes: standard PBR lit by the point lights.
  const floorMatHandle = assets.create(Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.9,
      baseColorTexture: Number(woodTex),
    })).unwrap();
  const containerMatHandle = assets.create(Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.8,
      baseColorTexture: Number(container2Tex),
    })).unwrap();

  // Spawn wood floor.
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, FLOOR_POS_Y, 0], scale: [FLOOR_SCALE_X, FLOOR_SCALE_Y, FLOOR_SCALE_Z],},
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Spawn the six wooden container boxes.
  const rot = quat.create();
  for (const box of CONTAINER_BOXES) {
    quat.fromAxisAngle(rot, box.axis, box.deg * DEG2RAD);
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [box.pos[0], box.pos[1], box.pos[2]], quat: [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0, rot[3] ?? 1], scale: [box.scale, box.scale, box.scale],},
        },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [containerMatHandle] } },
      )
      .unwrap();
  }

  // Spawn the four HDR point lights + their bright light-box cubes.
  // The light box is an unlit cube painted with the light colour (HDR,
  // channels up to 15.0) -- this is the bloom source, mirroring the
  // tutorial's 7.light_box.fs (FragColor = lightColor).
  LIGHT_POSITIONS.forEach((pos, i) => {
    const color = LIGHT_COLORS[i] ?? [1, 1, 1];

    // Point light illuminating the floor + containers.
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [pos[0], pos[1], pos[2]]},
        },
        {
          component: PointLight,
          data: {
            color: [color[0], color[1], color[2]],
            intensity: POINT_LIGHT_INTENSITY,
            range: POINT_LIGHT_RANGE,
          },
        },
      )
      .unwrap();

    // Bright light-box cube (unlit, HDR light colour -> bloom source).
    const lightBoxMat = assets.create(Materials.unlit([color[0], color[1], color[2], 1.0])).unwrap();
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [pos[0], pos[1], pos[2]], scale: [LIGHT_BOX_SCALE, LIGHT_BOX_SCALE, LIGHT_BOX_SCALE],},
        },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [lightBoxMat] } },
      )
      .unwrap();
  });

  // Camera with bloom + tonemap enabled.
  // Camera.bloom=BLOOM_ENABLED opt-in drives the URP default five-level
  // multiscale chain (D0..D4 -> U3..U0 -> composite). No custom pipeline code
  // needed -- this is the "Camera fields as API" paradigm, contrasted with
  // 6.hdr's custom RenderPipeline paradigm.
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z]},
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: CAMERA_FOV,
            aspect: target.width / target.height,
            near: CAMERA_NEAR,
            far: CAMERA_FAR,
          }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          exposure: TONEMAP_EXPOSURE,
          bloom: BLOOM_ENABLED,
          bloomThreshold: BLOOM_THRESHOLD,
          bloomIntensity: BLOOM_INTENSITY,
          bloomSmoothWidth: 0.01,
          bloomRadius: 0,
        },
      },
    )
    .unwrap();

  // First-person controls so the AI user can explore the bloom scene.
  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.7-bloom-first-person',
    overrideBackend: undefined,
  });

  // Space-key toggle for the bloom A/B comparison -- the core interaction of
  // LearnOpenGL 5.7 (the tutorial flips `bloom` to show the same scene with
  // and without glow). Mirrors apps/hello/bloom: read the spacebar from the
  // input snapshot, derive a press-edge from prev-frame level, flip
  // Camera.bloom between BLOOM_ENABLED and BLOOM_DISABLED via world.set.
  // The engine re-reads bloom every frame at extract; no other change needed.
  // InputSnapshot.keyboard matches KeyboardEvent.key, so the spacebar is the
  // literal ' ' (NOT 'Space', which is ev.code).
  let prevSpace = false;
  let currentBloom: number = BLOOM_ENABLED;
  world.addSystem(Update, {
    name: 'learn-render-5.7-bloom-space-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        const target = currentBloom === BLOOM_ENABLED ? BLOOM_DISABLED : BLOOM_ENABLED;
        const setRes = world.set(cameraEntity, Camera, { bloom: target });
        if (setRes.ok) {
          currentBloom = target;
          updateHud(currentBloom);
        } else {
          console.error('[learn-render 5.7 bloom] toggle world.set failed:', setRes.error.code);
        }
      }
      prevSpace = cur;
    },
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.7 bloom] app.start failed:', startRes.error);
    return;
  }

  // HUD: display bloom status + scene reference.
  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  updateHud(currentBloom);

  console.warn('[learn-render 5.7 bloom] Standard pipeline active. Press Space to toggle bloom.');

  installCaptureHook(app, world);
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World and issues one explicit observed draw before reading the Render-owned
// final-display observation. Reading that receipt-bound domain avoids comparing a
// captured Bloom graph with an earlier browser compositor frame.
function installCaptureHook(app: App, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureBloom?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureBloom = async (): Promise<Uint8Array> => {
    // Requesting all three domains keeps the Standard output split in the
    // same graph shape used by the existing receipt-observation contract;
    // final-display capture is only declared on the explicit encode stage.
    const armed = renderer.requestObservation?.(['linear-hdr', 'linear-ldr', 'final-display']);
    if (armed === undefined) throw new Error('[learn-render 5.7 bloom] final-display observation unavailable');
    if (!armed.ok) throw armed.error;
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, {
      include: ['linear-hdr', 'linear-ldr', 'final-display'],
    });
    if (!observed.ok) throw observed.error;
    const domain = observed.value.observations?.find((item) => item.domain === 'final-display');
    if (domain === undefined) throw new Error('[learn-render 5.7 bloom] final-display observation missing');
    const { width, height, bytesPerRow } = domain.metadata;
    const tightRowBytes = width * 4;
    if (bytesPerRow === tightRowBytes) return domain.bytes;
    const tight = new Uint8Array(tightRowBytes * height);
    for (let y = 0; y < height; y += 1) {
      tight.set(
        domain.bytes.subarray(y * bytesPerRow, y * bytesPerRow + tightRowBytes),
        y * tightRowBytes,
      );
    }
    return tight;
  };
}

// HUD reflecting the current bloom state + the Space-toggle hint, so the A/B
// comparison (LO 5.7's whole point) is discoverable from the on-screen text.
function updateHud(bloom: number): void {
  const hudElement = document.getElementById('hud');
  if (hudElement === null) return;
  const state = bloom === BLOOM_ENABLED ? 'ON' : 'OFF';
  hudElement.innerText = `bloom: ${state} (threshold=1.0) -- press [Space] to toggle | 4 HDR light boxes (colors up to 15.0) glow over 6 wooden crates`;
}

declare global {
  interface Window {
    __learnRenderErrors?: LearnRenderErrorRecord[];
  }
}
