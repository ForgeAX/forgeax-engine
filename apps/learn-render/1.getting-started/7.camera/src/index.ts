import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Time, Update } from '@forgeax/engine-ecs';
// apps/learn-render/1.getting-started/7.camera/src/index.ts
// LearnOpenGL section 1.7 - Camera (forgeax first-person mapping with
// WASD + mouse yaw/pitch + dt speed compensation + scroll-wheel FoV
// zoom on the @forgeax/engine-input frame-start scan + the @forgeax/
// engine-input InputSnapshot resource).
//
// Scene mirrors LO 7.3 verbatim: 10 textured cubes (`cubePositions[]`)
// each tilted on the (1, 0.3, 0.5) axis by `20 deg * i`, sharing a
// single sRGB JPG container texture. The first-person camera tours the
// cube field, providing the LO 7.3 "fly through the cubes" visual.
//
// LO 1.7 covers four sub-sections; the forgeax demo lands the
// dt-compensated keyboard (1.7.2) + scroll-wheel zoom (1.7.3) + the
// first-person mouse yaw/pitch (1.7.1 mouse_callback equivalent). LO
// 1.7.4 (Camera class) is OOS-9: the demo encodes the same state
// across `Transform` (camera position + orientation as quaternion) +
// `Camera` (perspective fov / aspect / near / far) ECS components,
// matching the engine SSOT split.
//
// In forgeax the LO 1.7 surface maps onto three layers (charter P4 +
// AC-07 + AC-09):
//   1. **input** -> the `InputSnapshot` resource returns the frozen
//      4-method `InputSnapshot` Resource (keyboard.down(key) /
//      keyboard.up(key) / mouse.movementDelta / mouse.button(0|1|2))
//      plus `mouse.wheelDelta` (sign-discrete notch per frame).
//   2. **dt** -> the system fn body reads `world.getResource<Time
//      Resource>('Time')?.dt` per tick (engine-app frame-loop SSOT,
//      plan-strategy D-1).
//   3. **camera Transform + Camera.fov** -> per-tick the first-person
//      system accumulates yaw/pitch from `mouse.movementDelta`,
//      clamps pitch at +/-89 deg, reconstructs forward via spherical
//      -> Cartesian, integrates `Transform.pos`; the scroll system
//      maintains `fovDeg` in [1, 45] (LO 1.7.3 clamp) and writes
//      `Camera.fov = fovDeg * Math.PI / 180`.
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO 7.3 cubePositions array
//                                       + first-person tuning
//                                       constants + GUID literals.
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// AC-15 (c): cube + container texture enter the world via
// `loadByGuid<MeshAsset>` / `loadByGuid<TextureAsset>` alone -- this
// file does not import @forgeax/engine-image and does not call any
// low-level decode / upload helper (charter P4 + P5).

// 1. engine usage - the public createApp + ECS World facade + Asset
// Registry namespace + AssetGuid parser + MaterialAsset / TextureAsset
// / MeshAsset POD types + 4 component schemas (Transform / Camera /
// MeshFilter / MeshRenderer). createApp owns the rAF frame-loop +
// Time resource + auto input attach.
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputBackendSample,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-container.pack.json';
import {
  CAMERA_SPEED_PER_SECOND,
  computeWasdDisplacement,
  createScrollFovAccumulator,
} from './first-person-controls';

// 2. example-specific glue - LO 7.3 cubePositions + first-person tuning
// + GUID literals.
//
//   CONTAINER_TEXTURE_GUID -> forgeax-engine-assets/learn-opengl/textures/
//                              container.jpg.meta.json subAssets[0].guid
//                              (LO 7.3 wood crate sRGB texture).
//   CUBE_MESH_GUID         -> forgeax-engine-assets/learn-opengl/meshes/cube
//                              -mesh.stub.meta.json subAssets[0].guid
//                              (engine-builtin procedural cube; the GUID is
//                              the disk-side identifier, the runtime side
//                              aliases the same logical mesh as HANDLE_CUBE).
//   CUBE_MATERIAL_GUID     -> assets/material-container.pack.json
//                              assets[0].guid (UnlitMaterialAsset whose
//                              baseColorTexture references CONTAINER_TEXTURE_GUID).
const CONTAINER_TEXTURE_GUID = '019e3969-1d46-773e-988c-a10e305ff2a4';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e2cc7-3a01-7c22-8f70-501bd9e74206';


// LO 7.3 cubePositions[] array (verbatim translation; the LO source
// uses `glm::vec3(...)` literals, here they map onto the per-entity
// `Transform.pos` flat array column the engine RenderSystem reads each
// frame). 10 cubes laid out in a loose grid so the first-person tour
// has reference geometry. Source: LearnOpenGL/src/1.getting_started/
// 7.3.camera_mouse_zoom/camera_mouse_zoom.cpp `cubePositions[]`.
const CUBE_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];

// LO 7.3 per-cube rotation: each cube tilts on a fixed axis by an
// angle proportional to its index, matching `glm::rotate(model,
// glm::radians(20.0f * i), glm::vec3(1.0f, 0.3f, 0.5f))`. The axis is
// normalised before being baked into the Transform quaternion.
const CUBE_AXIS_RAW = [1.0, 0.3, 0.5] as const;
const CUBE_AXIS_LEN = Math.sqrt(
  CUBE_AXIS_RAW[0] * CUBE_AXIS_RAW[0] +
    CUBE_AXIS_RAW[1] * CUBE_AXIS_RAW[1] +
    CUBE_AXIS_RAW[2] * CUBE_AXIS_RAW[2],
);
const CUBE_AXIS = [
  CUBE_AXIS_RAW[0] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[1] / CUBE_AXIS_LEN,
  CUBE_AXIS_RAW[2] / CUBE_AXIS_LEN,
] as const;
const CUBE_TILT_RADIANS_PER_INDEX = (20 * Math.PI) / 180;

// LO 7.3 perspective projection: same `glm::perspective(glm::radians(
// 45.0f), w/h, 0.1f, 100.0f)` shape carried from 1.6.
const CAMERA_FOV_RADIANS = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;

// LO 1.7 first-person tuning. The 4-step algorithm described in the
// chapter:
//   (i)   accumulate yaw/pitch from mouse delta (with sensitivity);
//   (ii)  clamp pitch within [-89 deg, +89 deg];
//   (iii) reconstruct forward direction via spherical -> Cartesian:
//           dx = cos(yaw)*cos(pitch);
//           dy = sin(pitch);
//           dz = sin(yaw)*cos(pitch);
//   (iv)  integrate camera position from WASD held keys along forward
//         + right vectors with cameraSpeed * dt (LO `cameraSpeed = 2.5
//         * deltaTime`; numeric SSOT lives in first-person-controls
//         .ts as `CAMERA_SPEED_PER_SECOND = 2.5`).
const PITCH_CLAMP_DEG = 89;
const PITCH_CLAMP_RAD = (PITCH_CLAMP_DEG * Math.PI) / 180;
const MOUSE_SENSITIVITY = 0.002; // radians per pixel

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: {
    readonly kind: string;
    readonly passes: ReadonlyArray<{ readonly name: string; readonly program: { readonly module: string } }>;
    readonly values: {
      readonly baseColor: readonly [number, number, number, number];
      readonly baseColorTexture?: string;
    };
  };
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to createApp, wire AssetRegistry through the shared catalog
// configuration helper + loadByGuid, spawn 10 textured cubes + camera + first-person and
// scroll systems, then start the app.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 1.7 camera] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __captureCameraInputBackend?: () => InputBackend;
  };
  const overrideFactory = winExt.__captureCameraInputBackend;
  const overrideBackend = overrideFactory !== undefined ? overrideFactory() : undefined;

  const appRes = await createAppForCamera(target, overrideBackend);
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 1.7 camera] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 1.7 camera] host assets are unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const containerGuidRes = AssetGuid.parse(CONTAINER_TEXTURE_GUID);
  const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
  const matGuidRes = AssetGuid.parse(CUBE_MATERIAL_GUID);
  if (!containerGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
    console.error('[learn-render 1.7 camera] GUID parse failed for container / cube / material');
    return;
  }

  // Resolve container texture through the production fetch chain
  // (catalog configuration -> container.jpg ->
  // parseImage -> uploadTexture). If loadByGuid fails (e.g. submodule
  // missing in a non-test environment), the demo falls back to an
  // untextured baseColor material so the first-person system + AC-07
  // capture hook still install (charter P3 explicit failure: log code
  // /hint, do not abort bootstrap).
  const containerHandleRes = await assets.loadByGuid<TextureAsset>(containerGuidRes.value);
  if (!containerHandleRes.ok) {
    console.warn(
      '[learn-render 1.7 camera] container texture loadByGuid failed (continuing untextured):',
      containerHandleRes.error.code,
    );
    // Mirror render-loop onError into the bootstrap-asset failure path so
    // the apps-shared onerror-gate browser test catches it (the gate
    // filters by SUT_ATTRIBUTABLE_CODES; bootstrap asset misses are part
    // of that allowlist as of 2026-06-08).
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) {
      bus.push({
        code: containerHandleRes.error.code,
        ...(containerHandleRes.error.hint !== undefined ? { hint: containerHandleRes.error.hint } : {}),
      });
    }
  }

  const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 1.7 camera] HANDLE_CUBE asset unavailable');
    return;
  }
  assets.catalog<MeshAsset>(cubeGuidRes.value, cubeAssetRes.value);

  const matPack = materialPackJson as unknown as MaterialPackFile;
  const matEntry = matPack.assets.find((a) => a.kind === 'material');
  if (matEntry === undefined) {
    console.error(
      '[learn-render 1.7 camera] material-container.pack.json missing material entry',
    );
    return;
  }
  // loadByGuid returns the texture PAYLOAD (M8 D-17); mint a user-tier column
  // handle so the baseColorTexture slot carries a resolved numeric Handle.
  const containerTexHandle = containerHandleRes.ok
    ? unwrapHandle(world.allocSharedRef('TextureAsset', containerHandleRes.value))
    : undefined;
  const cubeMaterial: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: {
      baseColor: matEntry.payload.values.baseColor,
      ...(containerTexHandle !== undefined ? { baseColorTexture: containerTexHandle } : {}),
    },
  };
  assets.catalog<MaterialAsset>(matGuidRes.value, cubeMaterial);

  const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuidRes.value);
  const matHandleRes = await assets.loadByGuid<MaterialAsset>(matGuidRes.value);
  if (!cubeHandleRes.ok || !matHandleRes.ok) {
    console.error(
      '[learn-render 1.7 camera] loadByGuid failed:',
      cubeHandleRes.ok ? null : cubeHandleRes.error.code,
      matHandleRes.ok ? null : matHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns payloads (M8 D-17); mint user-tier column handles.
  const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
  const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

  // Spawn the 10 cubes (LO 7.3 cubePositions[i] + per-index axis-angle
  // rotation around (1, 0.3, 0.5)). The axis-angle is baked into the
  // Transform quaternion so the engine RenderSystem can compose
  // worldFromLocal: mat4 from the SoA columns without further per-frame
  // work (LO 7.3 does not animate the cubes; the first-person camera
  // moves through them).
  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    const pos = CUBE_POSITIONS[i];
    if (pos === undefined) continue;
    const angle = i * CUBE_TILT_RADIANS_PER_INDEX;
    const halfAngle = angle * 0.5;
    const sinH = Math.sin(halfAngle);
    const cosH = Math.cos(halfAngle);
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [pos[0], pos[1], pos[2]], quat: [CUBE_AXIS[0] * sinH, CUBE_AXIS[1] * sinH, CUBE_AXIS[2] * sinH, cosH],},
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        {
          component: MeshRenderer,
          data: { materials: [matHandle] },
        },
      )
      .unwrap();
  }

  // Spawn the camera entity at (0, 0, 3) looking down -Z. The first-
  // person system below mutates this entity's Transform every tick;
  // the scroll system mutates the Camera.fov each tick.
  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 3]},
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: CAMERA_FOV_RADIANS,
          aspect: cameraAspect,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
        // LO 1.7 reuses LO 1.1's teal clear color (was the retired
        // the former renderer clearColor option; sinks onto Camera per
        // feat-20260608-create-app-param-surface-trim / M1 / D-1).
        clearColor: [0.2, 0.3, 0.3, 1.0],
      },
    },
  ).unwrap();

  // First-person camera system. The fn body implements LO 1.7 4-step
  // algorithm. Bound queries return the camera entity's Transform
  // array columns; the system rewrites pos + quat lanes each tick.
  let yaw = 0;
  let pitch = 0;
  let lastDirX = 0;
  let lastDirY = 0;
  let lastDirZ = -1;
  let lastTickIndex = 0;
  const qTmp = quat.create();
  const forwardTmp = vec3.create();
  const rightTmp = vec3.create();
  const FORWARD_LOCAL: Readonly<[number, number, number]> = [0, 0, -1];
  const RIGHT_LOCAL: Readonly<[number, number, number]> = [1, 0, 0];
  world.addSystem(Update, {
    name: 'learn-render-camera-first-person',
    after: ['input-frame-start-scan'],
    queries: [{ write: [Transform], with: [Camera] }] as const,
    fn: (world, queryResults) => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;
      // AC-13 type-narrowing probes: verify GamepadButtonIndex (0|1|...|16)
      // and GamepadAxisIndex (0|1|2|3) literal unions narrow correctly at the
      // full-typed InputSnapshot consumer boundary (D-7: probes live inside
      // a real world.addSystem fn, not a standalone .test-d.ts file).
      void snap.gamepad(0).button(0);
      void snap.gamepad(0).axis(2);
      void snap.gamepad(0).buttonValue(6);
      void snap.capabilities.gamepad;
      const time = world.getResource(Time);
      const dt = time.delta;
      const dx = snap.mouse.movementDelta.x;
      const dy = snap.mouse.movementDelta.y;
      yaw += dx * MOUSE_SENSITIVITY;
      pitch -= dy * MOUSE_SENSITIVITY;
      if (pitch > PITCH_CLAMP_RAD) pitch = PITCH_CLAMP_RAD;
      if (pitch < -PITCH_CLAMP_RAD) pitch = -PITCH_CLAMP_RAD;
      // Yaw/pitch -> quaternion (engine-math SSOT: identity q looks down -Z).
      // 7.camera uses engine yaw convention (yaw=0 -> -Z) so the LO->engine
      // bridge is just `-yaw` (no pi/2 offset; that offset exists in
      // apps/shared/learn-render-first-person because it tracks LO yaw=-pi/2
      // initial). forward + right are derived from q via transformVec3 — no
      // hand-rolled Tait-Bryan formula.
      quat.fromEuler(qTmp, pitch, -yaw, 0, 'YXZ');
      quat.transformVec3(forwardTmp, qTmp, FORWARD_LOCAL);
      quat.transformVec3(rightTmp, qTmp, RIGHT_LOCAL);
      const fwdX = forwardTmp[0] ?? 0;
      const fwdY = forwardTmp[1] ?? 0;
      const fwdZ = forwardTmp[2] ?? 0;
      const rightX = rightTmp[0] ?? 0;
      const rightZ = rightTmp[2] ?? 0;
      const held = {
        w: snap.keyboard.down('w'),
        s: snap.keyboard.down('s'),
        a: snap.keyboard.down('a'),
        d: snap.keyboard.down('d'),
      } as const;
      const disp = computeWasdDisplacement(
        dt,
        { x: fwdX, y: fwdY, z: fwdZ },
        { x: rightX, y: 0, z: rightZ },
        held,
      );

      for (const row of queryResults[0]) {
          const transform = row.mut(Transform);
          // Flat stride-N array columns (feat-20260709 M2): row i lanes at
          // pos[i*3+a] / quat[i*4+a].
          transform.pos.set([
            (transform.pos[0] ?? 0) + disp.x,
            (transform.pos[1] ?? 0) + disp.y,
            (transform.pos[2] ?? 0) + disp.z,
          ]);
          transform.quat.set([qTmp[0] ?? 0, qTmp[1] ?? 0, qTmp[2] ?? 0, qTmp[3] ?? 1]);
      }
      lastDirX = fwdX;
      lastDirY = fwdY;
      lastDirZ = fwdZ;
      lastTickIndex += 1;
    },
  });

  // Scroll-wheel FoV zoom system.
  const scrollAcc = createScrollFovAccumulator();
  world.addSystem(Update, {
    name: 'learn-render-camera-scroll-fov',
    after: ['input-frame-start-scan'],
    queries: [{ write: [Camera] }] as const,
    fn: (world, queryResults) => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;
      scrollAcc.apply(snap.mouse.wheelDelta);
      const fovRad = scrollAcc.fovRad;
      for (const row of queryResults[0]) row.mut(Camera).fov = fovRad;
    },
  });

  installCaptureHooks(target, world, () => ({
    yaw,
    pitch,
    dirX: lastDirX,
    dirY: lastDirY,
    dirZ: lastDirZ,
    tickCount: lastTickIndex,
    fovDeg: scrollAcc.fovDeg,
  }));

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 1.7 camera] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 1.7 camera] Standard pipeline active cameraSpeed=${CAMERA_SPEED_PER_SECOND}`);
}

async function createAppForCamera(
  target: HTMLCanvasElement,
  overrideBackend: InputBackend | undefined,
): Promise<{ ok: true; value: App } | { ok: false; error: CanvasAppError }> {
  // Host-explicit dev transport (OOS-1 / four-verb redesign 2026-06-06):
  // the container.jpg sidecar ships as a raw source row; the runtime
  // texture loader fails fast with `texture-source-not-imported` until a
  // build-time `.bin` (production) or a wired ImportTransport (dev) makes
  // the imported `.bin` reachable. Without this third arg, dev would
  // surface `asset-not-imported` from `loadByGuid<TextureAsset>` and the
  // demo would run untextured (charter P3 explicit failure).
  //
  // feat-20260608 / M3 / AC-11: hoist a single `bundler` const so the grep
  // gate "exactly 1 forgeaxBundlerAdapter call per demo file" holds across
  // the ternary below.
  const bundler = {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  };
  if (overrideBackend === undefined) {
    return createApp(target, {}, bundler);
  }
  return createApp(target, { input: overrideBackend }, bundler);
}

interface CameraInputState {
  readonly yaw: number;
  readonly pitch: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  readonly tickCount: number;
  readonly fovDeg: number;
}

interface CameraInputDriver {
  readonly setHeldKeys: (keys: ReadonlyArray<string>) => void;
  readonly addMouseDelta: (dx: number, dy: number) => void;
  readonly addWheelDelta: (dz: number) => void;
  readonly tick: () => Promise<CameraInputState>;
}

function installCaptureHooks(
  target: HTMLCanvasElement,
  world: World,
  readState: () => CameraInputState,
): void {
  type CameraCaptureHook = () => Promise<Uint8Array>;
  type CameraInputCaptureHook = () => CameraInputDriver;
  const win = window as unknown as {
    __captureCamera?: CameraCaptureHook;
    __captureCameraInput?: CameraInputCaptureHook;
  };
  win.__captureCamera = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 1.7 camera] canvas capture failed: ${r.error.hint}`,
      );
    }
    return r.value;
  };
  win.__captureCameraInput = (): CameraInputDriver => {
    const driverWin = window as unknown as {
      __captureCameraSyntheticDriver?: {
        readonly setHeldKeys: (keys: ReadonlyArray<string>) => void;
        readonly addMouseDelta: (dx: number, dy: number) => void;
        readonly addWheelDelta?: (dz: number) => void;
        readonly setDt?: (dt: number) => void;
      };
    };
    const sd = driverWin.__captureCameraSyntheticDriver;
    if (sd === undefined) {
      throw new Error(
        "[learn-render 1.7 camera] code: 'capture-driver-missing'; hint: window.__captureCameraSyntheticDriver must be installed before bootstrap (the browser test wires it together with __captureCameraInputBackend)",
      );
    }
    return {
      setHeldKeys: sd.setHeldKeys,
      addMouseDelta: sd.addMouseDelta,
      addWheelDelta: (dz: number): void => {
        sd.addWheelDelta?.(dz);
      },
      tick: async (): Promise<CameraInputState> => {
        world.update(1 / 60).unwrap();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return readState();
      },
    };
  };
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 1.7 camera] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 1.7 camera] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureCameraInputBackend?: () => InputBackend;
    __captureCameraSyntheticDriver?: {
      readonly setHeldKeys: (keys: ReadonlyArray<string>) => void;
      readonly addMouseDelta: (dx: number, dy: number) => void;
      readonly addWheelDelta?: (dz: number) => void;
      readonly setDt?: (dt: number) => void;
    };
  }
}

void ((): void => {
  const winExt = window as unknown as {
    __captureCameraInputBackend?: () => InputBackend;
    __captureCameraSyntheticDriver?: {
      readonly setHeldKeys: (keys: ReadonlyArray<string>) => void;
      readonly addMouseDelta: (dx: number, dy: number) => void;
      readonly addWheelDelta?: (dz: number) => void;
      readonly setDt?: (dt: number) => void;
    };
  };
  if (winExt.__captureCameraInputBackend !== undefined) return;
  if (typeof navigator === 'undefined') return;
  if (!navigator.userAgent.includes('HeadlessChrome')) return;
  const heldKeys = new Set<string>();
  let mvxPending = 0;
  let mvyPending = 0;
  let wheelPending = 0;
  const backend: InputBackend = {
    sample(): InputBackendSample {
      const out: InputBackendSample = {
        downKeys: new Set(heldKeys),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: mvxPending,
        movementY: mvyPending,
        wheelDelta: wheelPending,
        focused: true,
        pointerLocked: false,
      };
      mvxPending = 0;
      mvyPending = 0;
      wheelPending = 0;
      return out;
    },
    detach(): void {},
  };
  winExt.__captureCameraInputBackend = (): InputBackend => backend;
  winExt.__captureCameraSyntheticDriver = {
    setHeldKeys(keys: ReadonlyArray<string>): void {
      heldKeys.clear();
      for (const k of keys) heldKeys.add(k);
    },
    addMouseDelta(dx: number, dy: number): void {
      mvxPending += dx;
      mvyPending += dy;
    },
    addWheelDelta(dz: number): void {
      wheelPending += dz;
    },
  };
})();
