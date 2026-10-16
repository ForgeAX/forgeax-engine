import { installGpuDrivenEvidence } from '@forgeax/apps-shared/gpu-driven-evidence';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine-ecs';
// hello-fbx-skin -- feat-20260615-fbx-importer-via-sdk M5 t51 R2 fixup #2.
//
// End-to-end declare-import-load via fbxImporter through the build-time
// vite-plugin-pack pipeline:
//   (1) configureRuntimeAssetCatalog(assets, runtimeBinding) — scoped dev or static build catalog
//   (2) createRuntimeAssetImportTransport(runtimeBinding)             — dev-server POST /__import/:guid
//                                                     dispatches to fbxImporter
//   (3) loadByGuid<SceneAsset>(sceneGuid)           — runtime resolves the GUID
//   (4) instantiate x 3 + AnimationPlayer N-way SoA slots  — per-instance pose-distinct
//
// Loads humanoid.fbx (FBX SDK 2020.3.7 sample: 80 joints, 1605 skinned verts,
// 3 animation clips: 'run' / 'punch' / 'shot'). Mirror of apps/hello/skin/
// pattern (which uses Fox.glb via gltfImporter).
//
// The .fbx fixture lives in forgeax-engine-assets/vendor/fbx-test/ per the
// engine repo's zero-binary invariant. pluginPack scans that directory
// for humanoid.fbx + humanoid.fbx.meta.json (see vite.config.ts).
//
// AC-15: full declare-import-load (no registerWithGuid shortcut).
// AC-16: 3 instances pose-distinct via per-entity AnimationPlayer.

import { createApp } from '@forgeax/engine-app/browser';
import { ENTITY_NULL_RAW, type EntityHandle, World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import { Skin, skinningPlugin } from '@forgeax/engine-skinning';

import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { SceneInstance } from '@forgeax/engine-render';

import { type AnimationClip, type Handle, type SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const SCENE_GUID = '019ecd87-179b-7eb3-a37d-391f05c61e52';

const CLIPS = [
  { name: 'run', guid: '019ecd87-179b-71f7-b9f8-4c8518326b65' },
  { name: 'punch', guid: '019ecd87-179b-7843-a17a-513a3c8c6b3b' },
  { name: 'shot', guid: '019ecd87-179b-73a7-8bd0-e05301dc8df0' },
] as const;

const INSTANCE_POSITIONS: readonly [number, number, number][] = [
  [-50, 0, 0],
  [0, 0, 0],
  [50, 0, 0],
];

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-fbx-skin: missing <canvas id="app">');

resizeCanvasToDisplaySize(canvas);
window.addEventListener('resize', () => resizeCanvasToDisplaySize(canvas));

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[fbx-skin] env:', err);
  else console.error('[fbx-skin] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    { plugins: [skinningPlugin()], ...(import.meta.env.DEV && runtimeBinding !== undefined ? { assetRuntimeBinding: runtimeBinding } : {}) },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[fbx-skin] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world: World = app.world;
  installGpuDrivenEvidence(world, app.renderer);
  console.warn('[fbx-skin] Standard pipeline active');

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[hello-fbx-skin] asset owner unavailable');
    return;
  }
  if (assets === null) {
    console.error('[fbx-skin] AssetRegistry is null');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Load scene + 3 animation clips up front so per-frame swap is just a Handle.
  const sceneGuidRes = AssetGuid.parse(SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[fbx-skin] AssetGuid.parse(scene) failed:', sceneGuidRes.error);
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuidRes.value);
  if (!sceneRes.ok) {
    console.error('[fbx-skin] loadByGuid<SceneAsset> failed:', sceneRes.error);
    return;
  }

  // feat-20260614 M8 (D-17): loadByGuid returns the payload; mint a user-tier
  // column handle per clip via world.allocSharedRef.
  type ClipHandle = Handle<'AnimationClip', 'shared'>;
  const clipHandles: { name: string; handle: ClipHandle }[] = [];
  for (const c of CLIPS) {
    const gRes = AssetGuid.parse(c.guid);
    if (!gRes.ok) continue;
    const res = await assets.loadByGuid<AnimationClip>(gRes.value);
    if (!res.ok) {
      console.warn(`[fbx-skin] clip '${c.name}' loadByGuid failed:`, res.error.code);
      continue;
    }
    const handle = world.allocSharedRef<'AnimationClip', AnimationClip>('AnimationClip', res.value);
    clipHandles.push({ name: c.name, handle });
  }

  // feat-20260614 M8 (D-17): mint the SceneAsset payload into a user-tier
  // column handle once; instantiate dedups per GUID across the 3 copies.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

  // Instantiate 3 copies at distinct world positions; assign different clips.
  const playerEnts: EntityHandle[] = [];
  for (let i = 0; i < 3; i++) {
    const pos = INSTANCE_POSITIONS[i];
    if (pos === undefined) continue;
    const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
    if (!instRes.ok) {
      console.error(`[fbx-skin] instantiate[${i}] failed:`, instRes.error);
      continue;
    }
    const root = instRes.value;
    const rootTransform = world.get(root, Transform);
    if (rootTransform.ok) {
      world.set(root, Transform, {
        pos: [
          (rootTransform.value.pos[0] ?? 0) + pos[0],
          (rootTransform.value.pos[1] ?? 0) + pos[1],
          (rootTransform.value.pos[2] ?? 0) + pos[2],
        ],
      });
    }
    const inst = world.get(root, SceneInstance);
    if (!inst.ok) continue;
    let hasSkin = false;
    const animationTargets: EntityHandle[] = [];
    for (const entRaw of inst.value.mapping) {
      if (entRaw === undefined || entRaw === ENTITY_NULL_RAW) continue;
      const ent = entRaw as EntityHandle;
      if (world.get(ent, AnimationTargetId).ok) animationTargets.push(ent);
      if (world.get(ent, Skin).ok) hasSkin = true;
    }
    if (hasSkin) {
      const clipIdx = i % Math.max(1, clipHandles.length);
      const clip = clipHandles[clipIdx];
      if (clip === undefined) continue;
      // Variable N-slot init: all four parallel columns length-synced (D-5).
      // A short write is not tail-padded and speeds no longer defaults to
      // [1,1,1,1] (D-6), so speeds is written explicitly; paused/looping
      // inherit the schema layer-2 defaults. Distinct times[0] per instance
      // (i * 0.5) desyncs the three humanoids' poses (AC-16).
      const added = world.addComponent(root, {
        component: AnimationPlayer,
        data: {
          clips: [clip.handle],
          times: [i * 0.5],
          weights: [1],
          speeds: [1],
        },
      });
      if (!added.ok) continue;
      const bound = bindAnimationTargets(world, root, animationTargets);
      if (!bound.ok) {
        world.removeComponent(root, AnimationPlayer);
        console.error(
          `[fbx-skin] bindAnimationTargets[${i}] failed:`,
          bound.error.code,
          bound.error.detail,
        );
        continue;
      }
      playerEnts.push(root);
    }
  }

  if (playerEnts.length === 0) {
    console.error('[fbx-skin] no Skin entity found in any instantiated scene');
    return;
  }

  // Camera + directional light. humanoid.fbx is in cm; ~150 unit body.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 90, 520]} },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 1, far: 2000 }),
          clearColor: [0, 0.4, 0.4, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
      },
    })
    .unwrap();

  // HUD + keyboard toggle (mirror of hello/skin).
  const hudEl = document.getElementById('fbx-skin-hud');
  let currentClipIndex = 0;
  let currentPaused = false;
  const prevDigit: Record<string, boolean> = { '1': false, '2': false, '3': false };
  let prevSpace = false;

  const refreshHud = (): void => {
    if (!hudEl) return;
    const clipName = clipHandles[currentClipIndex]?.name ?? '?';
    const state = currentPaused ? 'Paused' : 'Playing';
    hudEl.innerHTML =
      `${playerEnts.length}x humanoid instances<br/>Clip: ${clipName}<br/>State: ${state}<br/>` +
      '<span style="color:#8a90a8;">[1] run  [2] punch  [3] shot  [Space] Pause</span>';
  };

  world.addSystem(Update, {
    name: 'fbx-skin-clip-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snap === undefined) return;

      for (let i = 0; i < clipHandles.length; i++) {
        const key = String(i + 1);
        const cur = snap.keyboard.down(key);
        if (cur && !prevDigit[key] && i !== currentClipIndex) {
          const newClip = clipHandles[i];
          if (newClip === undefined) continue;
          for (const ent of playerEnts) {
            // Toggle re-write to a single active slot: all four parallel
            // columns are written length-synced at length 1 (D-5). speeds is
            // re-supplied because a variable column write is a full replace,
            // not a tail-preserving partial; paused/looping are untouched and
            // keep their current value.
            world.set(ent, AnimationPlayer, {
              clips: [newClip.handle],
              times: [0],
              weights: [1],
              speeds: [1],
            });
          }
          currentClipIndex = i;
          refreshHud();
        }
        prevDigit[key] = cur;
      }

      const curSpace = snap.keyboard.down(' ');
      if (curSpace && !prevSpace) {
        currentPaused = !currentPaused;
        for (const ent of playerEnts) {
          world.set(ent, AnimationPlayer, { paused: currentPaused });
        }
        refreshHud();
      }
      prevSpace = curSpace;
    },
  });

  refreshHud();
  app.start();
}

function resizeCanvasToDisplaySize(c: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || window.innerWidth;
  const cssH = c.clientHeight || window.innerHeight;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (c.width !== targetW) c.width = targetW;
  if (c.height !== targetH) c.height = targetH;
}
