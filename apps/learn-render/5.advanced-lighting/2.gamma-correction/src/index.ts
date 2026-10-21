// apps/learn-render/5.advanced-lighting/2.gamma-correction/src/index.ts
// LearnOpenGL section 5.2 - Gamma Correction.
//
// One Standard pipeline plus one host-owned fullscreen feature provide the
// gamma-correct and intentionally wrong-gamma comparison modes.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.2 scene-specific constants + pipelines
//   - "// 3. bootstrap"       entry point wiring (1)+(2) + keydown HUD

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createFullscreenRenderFeature, type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import {
  Camera,
  MeshFilter,
  MeshRenderer,
  PostProcessParams,
} from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { PointLight } from '@forgeax/engine-render';



import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


// 2. example glue



// Texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json
// (chosen over container.jpg for closer fidelity to the LearnOpenGL 5.2
// floor-plane scene; both are sRGB JPEGs and either would exercise the
// gamma path identically).
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Point light at (0, 1.0, 1.0) - LO 5.2 places one positional white light
// above and slightly in front of the floor plane.
const LIGHT_POS_X = 0;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 1.0;

// Camera at (0, 0, 3), 45 deg fov, looking along -Z.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// One host-owned fullscreen feature samples the Standard pipeline output.
// mode=0 preserves the gamma-correct path; mode=1 applies the tutorial's
// intentionally wrong power curve for the A/B comparison.
const GAMMA_EFFECT_ID = 'learn-render-5-2::gamma';
const GAMMA_EFFECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
@group(1) @binding(2) var<uniform> gammaParams : vec4<f32>;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let col = textureSample(screenTexture, screenSampler, in.uv).rgb;
  if (gammaParams.x > 0.5) {
    return vec4<f32>(pow(col, vec3<f32>(2.2)), 1.0);
  }
  return vec4<f32>(col, 1.0);
}
`;

type GammaKey = '1' | '2';

const gammaFeature = createFullscreenRenderFeature({
  identity: GAMMA_EFFECT_ID,
  source: GAMMA_EFFECT_WGSL,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
});

/** Public lookup mirror: '1' -> 'correct', '2' -> 'no-gamma'. */
export function gammaDisplayNameByKey(key: string): string | null {
  if (key === '1') return 'correct';
  if (key === '2') return 'no-gamma';
  return null;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.2 gamma-correction] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    { features: [gammaFeature] },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const world = app.world;
const primitiveQuad = app.assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  app.onError((error) => {
    console.error('[learn-render 5.2 gamma-correction] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureGammaCorrection?: () => Promise<Uint8Array>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.2 gamma-correction] asset owner is unavailable');
    return;
  }

  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] wood GUID parse failed');
    return;
  }
  const woodHandleRes = await assets.load(woodGuidRes.value, 'texture');
  if (!woodHandleRes.ok) {
    console.error(
      '[learn-render 5.2 gamma-correction] wood loadByGuid failed:',
      woodHandleRes.error.code,
    );
    return;
  }
  const woodTex = woodHandleRes.value;

  const planeMat = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.8,
      baseColorTexture: Number(woodTex),
    },
  }).unwrap();

  // HANDLE_QUAD lies in XY facing +Z; place at origin so the camera at
  // (0,0,3) looks straight at it. A single textured plane is enough to
  // expose the gamma delta uniformly across the framebuffer.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0]} },
      { component: MeshFilter, data: { assetHandle: primitiveQuad } },
      { component: MeshRenderer, data: { materials: [planeMat] } },
    )
    .unwrap();

  world.spawn(
    {
      component: Transform,
      data: { pos: [LIGHT_POS_X, LIGHT_POS_Y, LIGHT_POS_Z]},
    },
    { component: PointLight, data: {} },
  );

  const cameraEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, CAMERA_POS_Z]} },
      {
        component: Camera,
        data: perspective({
          fov: CAMERA_FOV,
          aspect: target.width / target.height,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
      },
      { component: PostProcessParams, data: { shader: GAMMA_EFFECT_ID, data: new Uint8Array(16) } },
    )
    .unwrap();

  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.2-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.2 gamma-correction] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  // Dev-mode keyboard handler: '1' / '2' update the feature-owned parameter.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeKey: GammaKey = '1';
    const hudElement = document.getElementById('hud');
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      if (key === activeKey) return;
      if (key !== '1' && key !== '2') {
        return;
      }
      const modeData = new Uint8Array(16);
      new Float32Array(modeData.buffer)[0] = key === '2' ? 1 : 0;
      const modeResult = world.set(cameraEntity, PostProcessParams, { data: modeData });
      if (!modeResult.ok) {
        console.error('[learn-render 5.2 gamma-correction] mode update failed:', modeResult.error);
        return;
      }
      activeKey = key as GammaKey;
      const displayName = gammaDisplayNameByKey(key);
      if (hudElement !== null && displayName !== null) {
        hudElement.innerText = `gamma: ${displayName} (press 1 = correct, 2 = no-gamma)`;
      }
    });
  }

  console.warn('[learn-render 5.2 gamma-correction] Standard pipeline active');

  installCaptureHook(target, world);
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World before reading the Host-owned presentation surface.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureGammaCorrection?: CaptureHook };
  win.__captureGammaCorrection = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.2 gamma-correction] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
