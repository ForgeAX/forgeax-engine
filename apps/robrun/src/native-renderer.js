import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import {
  createBoxGeometry,
  createCapsuleGeometry,
  createMeshBuilder,
  createPlaneGeometry,
} from '@forgeax/engine/geometry';
import { color, mat4, quat, vec3 } from '@forgeax/engine/math';
import {
  ANTIALIAS_MSAA,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Fog,
  FogModeValue,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
  Visibility,
} from '@forgeax/engine/render';
import { ChildOf, Transform } from '@forgeax/engine/scene';

const identity = { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
let active;
export const nativeRuntime = () => {
  if (!active) throw new Error('Native renderer has not initialized');
  return active;
};

export function sectionMesh(section, full) {
  const position = Float32Array.from(section.position, (value) => Math.max(-1, value / 32767));
  const attributes = { position };
  if (full) {
    attributes.normal = Float32Array.from(section.normal, (value) => Math.max(-1, value / 127));
    attributes.uv = section.uv;
  }
  return createMeshBuilder({
    attributes,
    indices: section.index,
    materialSlots: [{ slotName: 'Surface' }],
  })
    .build()
    .unwrap();
}

// The original analytic sky is sampled as linear HDR radiance. The renderer owns
// equirect conversion and IBL filtering; all GPU work belongs to the native renderer.
function skyAsset(sunDirection) {
  const width = 1024,
    height = 512;
  const data = new Float32Array(width * height * 4);
  const sun = vec3.normalize(vec3.create(), sunDirection);
  const horizon = [0.6, 0.64, 0.68],
    zenith = [0.16, 0.3, 0.55],
    solar = [1, 0.92, 0.8];
  const smooth = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const theta = ((y + 0.5) / height) * Math.PI;
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = Math.sin(theta) * Math.cos(phi),
        dy = Math.cos(theta),
        dz = Math.sin(theta) * Math.sin(phi);
      const h = Math.max(0, Math.min(1, dy)) ** 0.55;
      const ground = smooth(0, -0.08, dy);
      const d = Math.max(dx * sun[0] + dy * sun[1] + dz * sun[2], 0);
      const s = (d ** 900 * 18 + d ** 12 * 0.35 + d ** 3 * 0.08) * smooth(-0.05, 0.05, dy);
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        data[offset + c] =
          (horizon[c] * (1 - h) + zenith[c] * h) * (1 - ground) +
          horizon[c] * ground +
          solar[c] * s;
      data[offset + 3] = 1;
    }
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba32float',
    colorSpace: 'linear',
    data: new Uint8Array(data.buffer),
  };
}

export async function createNativeRenderer(quality, debug) {
  const diagnostics = new URLSearchParams(location.search);
  const profiler = diagnostics.has('cpu-profile')
    ? (await import('@forgeax/engine/profiler')).createProfiler()
    : undefined;
  const bundler = forgeaxBundlerAdapter();
  if (diagnostics.has('rhi-capture')) {
    const { attachBrowserRhiRecorder } = await import('@forgeax/engine/app/host-adapter');
    bundler.attachRhiRecorder = attachBrowserRhiRecorder;
  }
  const canvas = document.createElement('canvas');
  document.body.prepend(canvas);
  const created = await createApp(
    canvas,
    {
      canvasPixelRatio: Math.min(devicePixelRatio, quality.pixelRatio),
      renderBackend: 'webgpu',
      ...(profiler ? { profiler } : {}),
      ...(diagnostics.has('gpu-timing') ? { gpuPassTiming: {} } : {}),
      ...(diagnostics.has('ablation') ? { renderAblation: diagnostics.get('ablation') } : {}),
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: false },
    },
    bundler,
  );
  if (!created.ok) throw created.error;
  const app = created.value,
    world = app.world,
    assets = app.assets;
  const cameraEntity = world
    .spawn(
      { component: Transform, data: identity },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: innerWidth / innerHeight,
          near: 0.25,
          far: 14000,
          clearColor: [0.6, 0.64, 0.68, 1],
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1,
          antialias: ANTIALIAS_MSAA,
        },
      },
    )
    .unwrap();
  const sunEntity = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -1, 0],
        intensity: 2.6,
        castShadow: quality.shadowMap > 0,
        color: color.linearRgb(0xfff1dc),
        cascadeCount: 1,
        mapSize: quality.shadowMap || 1024,
        shadowDistance: quality.shadowRadius || 100,
        sourceAngle: 0,
      },
    })
    .unwrap();
  world
    .spawn({
      component: Fog,
      data: { color: [0.6, 0.64, 0.68], density: 11e-5, mode: FogModeValue.exp2 },
    })
    .unwrap();
  const playerRoot = world
    .spawn({ component: Transform, data: identity }, { component: Visibility, data: { state: 2 } })
    .unwrap();
  const playerParts = [
    [createCapsuleGeometry(0.35, 1.05, 6, 16).unwrap(), [0, 0.875, 0], 0xf1c35a, 0.55],
    [createBoxGeometry(0.42, 0.16, 0.2).unwrap(), [0, 1.33, 0.29], 0x1b2430, 0.3],
    [createBoxGeometry(0.4, 0.5, 0.2).unwrap(), [0, 0.9625, -0.35], 0x8a5a2b, 0.8],
  ];
  for (const [mesh, pos, color, roughness] of playerParts)
    world
      .spawn(
        { component: Transform, data: { ...identity, pos } },
        { component: ChildOf, data: { parent: playerRoot } },
        { component: MeshFilter, data: { assetHandle: assets.create(mesh).unwrap() } },
        {
          component: MeshRenderer,
          data: {
            materials: [
              assets.create(Materials.standard({ baseColor: color, roughness })).unwrap(),
            ],
          },
        },
      )
      .unwrap();
  const direction = vec3.create();
  const shadowProjection = mat4.create(),
    shadowViewProjection = mat4.create();
  let environment,
    frameCallback,
    startedAt = performance.now(),
    submitted = 0,
    completed = 0;
  const cpuFrames = [],
    completions = [];
  canvas.addEventListener('forgeax:frame-submitted', () => {
    submitted++;
  });
  canvas.addEventListener('forgeax:frame-completed', (event) => {
    if (event.detail.presentation !== 'ready') return;
    completed++;
    completions.push(performance.now());
    if (completions.length > 5000) completions.shift();
    if (!debug.ready) {
      debug.ready = true;
      debug.firstReadyMs = performance.now() - debug.startedAt;
    }
  });
  app.onError((error) => {
    debug.errors.push(JSON.stringify(error));
    console.error(error);
  });
  function updateView(camera, sun, player) {
    world
      .set(cameraEntity, Transform, {
        pos: camera.position,
        quat: camera.quaternion,
        scale: [1, 1, 1],
      })
      .unwrap();
    world.set(cameraEntity, Camera, { aspect: camera.aspect }).unwrap();
    vec3.normalize(direction, vec3.sub(direction, sun.target.position, sun.position));
    const shadowCamera = sun.shadow.camera;
    mat4.lookAt(shadowViewProjection, sun.position, sun.target.position, [0, 1, 0]);
    mat4.orthographicReverseZ(
      shadowProjection,
      shadowCamera.left,
      shadowCamera.right,
      shadowCamera.top,
      shadowCamera.bottom,
      shadowCamera.near,
      shadowCamera.far,
    );
    mat4.multiply(shadowViewProjection, shadowProjection, shadowViewProjection);
    world
      .set(sunEntity, DirectionalLight, {
        direction: direction,
        intensity: sun.intensity,
        castShadow: sun.castShadow,
        shadowProjection: 1,
        shadowViewProjection: shadowViewProjection,
        shadowBiasMode: 1,
        depthBias: 4e-4,
        normalBias: 0.06,
        shadowRadius: 1,
      })
      .unwrap();
    if (!environment) {
      const equirect = assets.create(skyAsset(vec3.negate(vec3.create(), direction))).unwrap();
      world.spawn({ component: Skylight, data: { equirect, intensity: 0.9 } }).unwrap();
      world.spawn({ component: SkyboxBackground, data: { equirect } }).unwrap();
      environment = equirect;
    }
    world
      .set(playerRoot, Transform, {
        pos: player.pos,
        quat: [0, Math.sin(player.heading / 2), 0, Math.cos(player.heading / 2)],
        scale: [1, 1, 1],
      })
      .unwrap();
    world.set(playerRoot, Visibility, { state: player.visible ? 2 : 1 }).unwrap();
  }
  function setWater(list) {
    const mesh = assets.create(createPlaneGeometry(32, 32).unwrap()).unwrap();
    const material = assets
      .create(
        Materials.standard({
          baseColor: [0.025, 0.05, 0.05, 0.9],
          roughness: 0.12,
          metallic: 0,
          queue: 3000,
          renderState: {
            depthWriteEnabled: false,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        }),
      )
      .unwrap();
    const orientation = quat.fromAxisAngle(quat.create(), [1, 0, 0], -Math.PI / 2);
    for (const item of list)
      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: item.p,
              quat: quat.multiply(quat.create(), item.q, orientation),
              scale: [item.s[0], item.s[2], 1],
            },
          },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: ShadowParticipation, data: { cast: false, receive: true } },
        )
        .unwrap();
  }
  const zipEntities = [];
  function setZiplines(list) {
    for (const entity of zipEntities) world.despawn(entity).unwrap();
    zipEntities.length = 0;
    if (!list.length) return;
    const positions = [];
    for (const entry of list) {
      const length = Math.hypot(entry[3] - entry[0], entry[4] - entry[1], entry[5] - entry[2]);
      const stride = entry[6] === 1 ? 5.2 : length;
      for (let offset = 0; offset < length; offset += stride)
        for (const distance of [offset, Math.min(length, offset + (entry[6] === 1 ? 3 : length))]) {
          for (let axis = 0; axis < 3; axis++)
            positions.push(entry[axis] + ((entry[axis + 3] - entry[axis]) * distance) / length);
        }
    }
    const mesh = assets
      .create(
        createMeshBuilder({
          attributes: { position: new Float32Array(positions) },
          submeshes: [{ topology: 'line-list' }],
        })
          .build()
          .unwrap(),
      )
      .unwrap();
    for (const through of [true, false])
      zipEntities.push(
        world
          .spawn(
            { component: Transform, data: identity },
            { component: MeshFilter, data: { assetHandle: mesh } },
            {
              component: MeshRenderer,
              data: {
                materials: [
                  assets
                    .create(
                      Materials.unlit([...color.linearRgb(0xf1e6c8), through ? 0.266 : 0.95], {
                        queue: 3000,
                        renderState: {
                          depthCompare: through ? 'always' : 'greater',
                          depthWriteEnabled: false,
                          blend: {
                            color: {
                              srcFactor: 'src-alpha',
                              dstFactor: 'one-minus-src-alpha',
                              operation: 'add',
                            },
                            alpha: {
                              srcFactor: 'one',
                              dstFactor: 'one-minus-src-alpha',
                              operation: 'add',
                            },
                          },
                        },
                      }),
                    )
                    .unwrap(),
                ],
              },
            },
            { component: Lines, data: { width: 3 } },
            { component: ShadowParticipation, data: { cast: false, receive: false } },
          )
          .unwrap(),
      );
  }
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'robrun-game',
        queries: [],
        fn: (w) => {
          if (!frameCallback) return;
          const at = performance.now();
          frameCallback(at, w.getResource(Time).delta);
          cpuFrames.push(performance.now() - at);
          if (cpuFrames.length > 5000) cpuFrames.shift();
        },
      }),
    )
    .unwrap();
  const adapter = {
    app,
    world,
    assets,
    domElement: canvas,
    updateView,
    setWater,
    setZiplines,
    getPixelRatio: () => Math.min(devicePixelRatio, quality.pixelRatio),
    start(callback) {
      frameCallback = callback;
      startedAt = performance.now();
      app.start().unwrap();
    },
    profiler,
    inspect: () => app.renderer.inspect(),
    capture: () => app.rhiCapture?.captureFrame(),
    stats: () => ({
      submitted,
      completed,
      cpuFrames: cpuFrames.slice(),
      completions: completions.slice(),
      startedAt,
      renderer: app.renderer.inspect(),
    }),
    dispose: () => app.dispose(),
  };
  active = adapter;
  debug.native = adapter;
  return adapter;
}
