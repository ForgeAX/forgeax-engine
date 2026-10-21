// apps/learn-render/5.advanced-lighting/3.2.point-shadows/src/main.ts
// LearnOpenGL section 5.3.2 — point-light cube-map shadows.
// Room scene: the canonical LearnOpenGL room (extent=5) viewed from inside,
// wood-textured cubes, and the orbiting point light with PointLightShadow.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. scene constants" D4 scene-specific constants
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { Time, Update } from '@forgeax/engine-ecs';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials, PointLightShadow } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';



import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { createSceneCubeMesh } from './scene-mesh';

// 2. scene constants

// The source renderCube() spans [-1, 1] on each axis (2 units wide), while
// HANDLE_CUBE is the engine's 1-unit cube. Keep the source's [-5, 5] room
// extent by applying the corresponding engine transform scale of 10.
const ROOM_EXTENT = 5;
const ROOM_SCALE = ROOM_EXTENT * 2;
const ROOM_Y = 0;

// Camera: canonical LearnOpenGL starting pose (0, 0, 3), looking -Z.
const CAMERA_POS_Y = 0;
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50.0;

// Inner objects: exact LearnOpenGL renderScene() positions/scales. The source
// sample uses one wood texture for every cube; the material handle below is
// shared by the room and all five objects.
const INNER_OBJECTS = [
  { pos: [4, -3.5, 0] as const, scale: 1, quat: [0, 0, 0, 1] as const },
  { pos: [2, 3, 1] as const, scale: 1.5, quat: [0, 0, 0, 1] as const },
  { pos: [-3, -1, 0] as const, scale: 1, quat: [0, 0, 0, 1] as const },
  { pos: [-1.5, 1, 1.5] as const, scale: 1, quat: [0, 0, 0, 1] as const },
  {
    pos: [-1.5, 2, -3] as const,
    scale: 1.5,
    // glm::rotate(..., radians(60), normalize(vec3(1, 0, 1))).
    quat: [0.3535533906, 0, 0.3535533906, 0.8660254038] as const,
  },
];

// Point light: canonical sample keeps x/y at zero and oscillates z with
// sin(time * 0.5) * 3. The engine's PointLight uses physical attenuation;
// intensity/range are the equivalent bright, finite light envelope.
const LIGHT_ORBIT_Y = 0;
const LIGHT_ORBIT_RADIUS = 3;
const LIGHT_ORBIT_SPEED = 0.5;
const LIGHT_RANGE = 25;
// Candela for this ten-meter room. Standard PBR uses inverse-square falloff;
// it does not reproduce the source's distance-independent Blinn-Phong shader.
const LIGHT_INTENSITY = 20;

const POINT_SHADOW = {
  mapSize: 1024,
  // LearnOpenGL subtracts a 0.05 world-unit bias from the fragment distance
  // and applies no normal offset.
  depthBias: 0.05,
  normalBias: 0,
  nearPlane: 1,
  farPlane: 25,
  pcfKernelSize: 1,
};

// LearnOpenGL's shader clears to a neutral dark grey and applies a 0.3
// direction-independent ambient term. The engine has no implicit ambient, so
// the material's textured emissive term below carries that baseline while the
// point light remains the only shadowed key light.
const CLEAR_COLOR = [0.1, 0.1, 0.1, 1] as const;

// GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.3.2 point-shadows] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // This app is served by the local Pack Vite plugin. Wire the transport
  // explicitly so a dependency-optimized shared helper cannot accidentally
  // select the production /pack-index.json branch in dev.
  const binding = runtimeBinding;
  if (binding === undefined) {
    console.error('[learn-render 5.3.2 point-shadows] runtime asset binding unavailable');
    return;
  }
  const appRes = await createApp(
    target,
    { assetRuntimeBinding: binding },
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(binding),
    },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.3.2 point-shadows] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((error) => {
    console.error('[learn-render 5.3.2 point-shadows] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.3.2 point-shadows] AssetRegistry is null');
    return;
  }
  // The shared helper selects the Vite dev binding or the emitted production
  // pack-index from import.meta.env.DEV. Keeping that decision centralized is
  // what makes the same source work in both `vite` and `vite preview`.
  configureRuntimeAssetCatalog(assets, binding);

  // The original sample binds wood.png to both the room and every inner
  // cube. Keep the load on the normal GUID/catalog route so the visual demo
  // and its asset identity match the rest of learn-render.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.3.2 point-shadows] wood GUID parse failed');
    return;
  }
  const woodTextureRes = await assets.load(woodGuidRes.value, 'texture');
  if (!woodTextureRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: woodTextureRes.error.code, hint: woodTextureRes.error.hint });
    console.error(
      '[learn-render 5.3.2 point-shadows] wood texture load failed:',
      woodTextureRes.error.code,
      woodTextureRes.error.hint,
    );
    return;
  }
  const woodTextureHandle = Number(
    woodTextureRes.value,
  );

  // The original explicitly reverses room normals. Author that geometry once
  // so ordinary back-face culling and depth writes work in every render pass.
  const roomMat = assets.create(Materials.standard({
      baseColor: [1, 1, 1, 1],
      baseColorTexture: woodTextureHandle,
      metallic: 0,
      roughness: 1,
      occlusionStrength: 1,
      emissive: [1, 1, 1],
      // LearnOpenGL's ambient is 0.3 * lightColor (0.09). Carry that exact
      // baseline through the shared wood texture because Standard PBR has no
      // implicit ambient term.
      emissiveIntensity: 0.09,
      emissiveTexture: woodTextureHandle,
    })).unwrap();

  const roomMesh = assets.create(createSceneCubeMesh(true)).unwrap();
  const cubeMesh = assets.create(createSceneCubeMesh(false)).unwrap();
  // Inward-facing geometry at positive scale preserves the source room bounds.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, ROOM_Y, 0],
        quat: [0, 0, 0, 1],
        scale: [ROOM_SCALE, ROOM_SCALE, ROOM_SCALE],
      },
    },
    { component: MeshFilter, data: { assetHandle: roomMesh } },
    { component: MeshRenderer, data: { materials: [roomMat] } },
  ).unwrap();

  // Inner wood-textured objects (exact LearnOpenGL renderScene layout).
  for (const obj of INNER_OBJECTS) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: obj.pos,
          quat: obj.quat,
          scale: [obj.scale, obj.scale, obj.scale],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeMesh } },
      { component: MeshRenderer, data: { materials: [roomMat] } },
    ).unwrap();
  }

  // Orbiting point light with shadow.
  const lightEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, LIGHT_ORBIT_Y, 0] },
    },
    {
      component: PointLight,
      data: { range: LIGHT_RANGE, intensity: LIGHT_INTENSITY, color: [1, 1, 1] },
    },
    {
      component: PointLightShadow,
      // The source demo uses a 1024² depth cubemap and near/far=[1, 25].
      // Keep the values explicit rather than relying on engine defaults.
      data: POINT_SHADOW,
    },
  ).unwrap();

  // Camera: canonical LearnOpenGL pose (0, 0, 3), looking -Z.
  const cameraEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, CAMERA_POS_Y, CAMERA_POS_Z], quat: [0, 0, 0, 1] },
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
        clearColor: CLEAR_COLOR,
      },
    },
  ).unwrap();
  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.3.2-point-shadows-first-person',
    overrideBackend: undefined,
  });

  // Per-frame orbit: the source sample keeps x/y at zero and oscillates z.
  let elapsed = 0;
  let paused = new URLSearchParams(location.search).has('paused');
  const pauseButton = document.querySelector<HTMLButtonElement>('#pause');
  const updatePauseLabel = () => {
    if (pauseButton) pauseButton.textContent = paused ? 'Resume light (P)' : 'Pause light (P)';
  };
  const togglePause = () => { paused = !paused; updatePauseLabel(); };
  pauseButton?.addEventListener('click', togglePause);
  document.querySelector('#reset')?.addEventListener('click', () => { elapsed = 0; });
  updatePauseLabel();
  world.addSystem(Update, {
    name: 'point-light-orbit',
    queries: [],
    fn: () => {
      if (!paused) elapsed += world.getResource(Time)?.delta ?? 0;
      const t = elapsed * LIGHT_ORBIT_SPEED;
      world.set(lightEntity, Transform, {
        pos: [0, LIGHT_ORBIT_Y, Math.sin(t) * LIGHT_ORBIT_RADIUS],
      });
    },
  });

  // Match the source demo's SPACE shadow toggle. Removing the component makes
  // the renderer take the ordinary point-light path; adding it back restores
  // the same six-face atlas request with the authored parameters above.
  let shadowsEnabled = true;
  const shadowButton = document.querySelector<HTMLButtonElement>('#shadows');
  const toggleShadows = () => {
    if (shadowsEnabled) {
      world.removeComponent(lightEntity, PointLightShadow).unwrap();
      shadowsEnabled = false;
    } else {
    world
      .addComponent(lightEntity, {
        component: PointLightShadow,
        data: { ...POINT_SHADOW },
      })
      .unwrap();
    shadowsEnabled = true;
    }
    if (shadowButton) shadowButton.textContent = `Shadows: ${shadowsEnabled ? 'on' : 'off'} (Space)`;
  };
  shadowButton?.addEventListener('click', toggleShadows);
  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === 'KeyP') togglePause();
    if (event.code === 'KeyR') elapsed = 0;
    if (event.code !== 'Space') return;
    event.preventDefault();
    toggleShadows();
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.3.2 point-shadows] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 5.3.2 point-shadows] backend=${renderer.inspect().capabilities.backendKind}`);
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
