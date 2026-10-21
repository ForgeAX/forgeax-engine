// feat-20260713-animation-state-machine-plugin M5 / w33 (AC-13).
//
// Demonstrates the full AnimationGraph evaluation pipeline:
//   defineAnimationGraph -> evaluateAnimationGraph (auto, default path) -> N-slot weights[]
//
// DAG structure (7 nodes, constructed below with defineAnimationGraph):
//
//   node 0: clip(survey)          -- surveyBase, in outer Blend
//   node 1: clip(walk)            -- walkLeaf, in inner Blend
//   node 2: clip(run)             -- runLeaf, in inner Blend
//   node 3: blend([1, 2])         -- walkRunBlend (inner Blend normalizing Walk/Run)
//   node 4: blend([0, 3])         -- baseBlend (outer Blend normalizing Survey vs walkRunBlend)
//   node 5: clip(survey, 0.3)     -- overlayLeaf (synthetic additive, static weight 0.3)
//   node 6: add(4, [5])           -- root Add (base + additive overlay, non-normalizing)
//
// Keyboard: adjusts only nodeWeights[] per frame.
//   [A]/[D]:  decrease/increase locomotion (Survey <-> Walk/Run blend ratio)
//   [W]/[S]:  decrease/increase walkRunRatio (Walk <-> Run ratio inside inner Blend)
//   [O]:      toggle overlay (nodeWeights[5] = 1 or 0)
//   [Space]:  toggle paused
//
// evaluateAnimationGraph (registered by animationPlugin, runs before advance)
// post-order-computes weights[] from nodeWeights each frame -- the caller
// NEVER writes weights[] directly (AC-13 core demo intent).
//
// HUD shows weights[] + total sum; when overlay is on, sum > 1 (Add is
// non-normalizing, so the additive layer's 0.3 stacks on top).

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { ENTITY_NULL_RAW, Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  defineAnimationGraph,
} from '@forgeax/engine-animation';

import { ChildOf, Transform } from '@forgeax/engine-scene';

import { Skin, skinningPlugin } from '@forgeax/engine-skinning';

import { Camera } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { SceneInstance } from '@forgeax/engine-render';
import { DirectionalLight } from '@forgeax/engine-render';


import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { refreshHud } from './hud';


// Fox.glb sub-asset GUIDs (same as hello-skin; sourced from Fox.glb.meta.json).
const FOX_SCENE_GUID = '019eb2ce-6232-74a0-8da7-00be6d2f8774';
const CLIPS = [
  { name: 'Survey', guid: '019eb2ce-6232-74a0-8da7-00c2414d45c4' },
  { name: 'Walk', guid: '019eb2ce-6233-74f3-a877-ebea0a513ea9' },
  { name: 'Run', guid: '019eb2ce-6233-74f3-a877-ebeb96c4f15d' },
] as const;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[animation-graph] missing <canvas id="app">');

resizeCanvasToDisplaySize(canvas);
window.addEventListener('resize', () => resizeCanvasToDisplaySize(canvas));

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[animation-graph] env:', err);
  else console.error('[animation-graph] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    { plugins: [skinningPlugin()] },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[animation-graph] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world: World = app.world;
  console.warn('[animation-graph] Standard pipeline active');

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[animation-graph] asset owner unavailable');
    return;
  }
  if (assets === null) {
    console.error('[animation-graph] AssetRegistry is null');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Load Fox scene + 3 animation clips from the pack index.
  const sceneGuidRes = AssetGuid.parse(FOX_SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[animation-graph] AssetGuid.parse(scene) failed');
    return;
  }
  const sceneRes = await assets.load(sceneGuidRes.value, 'scene');
  if (!sceneRes.ok) {
    console.error('[animation-graph] load(scene) failed:', sceneRes.error);
    return;
  }
  const sceneHandle = sceneRes.value;

  for (const def of CLIPS) {
    const guidRes = AssetGuid.parse(def.guid);
    if (!guidRes.ok) {
      console.error('[animation-graph] AssetGuid.parse failed for', def.name);
      return;
    }
    const clipRes = await assets.load(guidRes.value, 'animation-clip');
    if (!clipRes.ok) {
      console.error('[animation-graph] load failed for', def.name, clipRes.error);
      return;
    }
  }

  const findClipGuid = (name: string): string => {
    const entry = CLIPS.find((clip) => clip.name === name);
    if (entry === undefined) throw new Error(`[animation-graph] clip '${name}' not found`);
    return entry.guid;
  };
  // Build DAG: Add(base=Blend(Survey, Blend(Walk,Run)), additive=[overlay@0.3]).
  // Node indices (construction order):
  //   0: surveyBase clip(survey)
  //   1: walkLeaf   clip(walk)
  //   2: runLeaf    clip(run)
  //   3: walkRunBlend  blend([1,2])
  //   4: baseBlend     blend([0,3])
  //   5: overlayLeaf   clip(survey, weight=0.3)  <- synthetic additive
  //   6: root          add(4, [5])
  const graphResult = defineAnimationGraph((b) => {
    const surveyBase = b.clip(findClipGuid('Survey'));
    const walkLeaf = b.clip(findClipGuid('Walk'));
    const runLeaf = b.clip(findClipGuid('Run'));
    const walkRunBlend = b.blend([walkLeaf, runLeaf]);
    const baseBlend = b.blend([surveyBase, walkRunBlend]);
    const overlayLeaf = b.clip(findClipGuid('Survey'), 0.3);
    return b.add(baseBlend, [overlayLeaf]);
  });
  if (!graphResult.ok) {
    console.error('[animation-graph] defineAnimationGraph failed:', graphResult.error.code);
    return;
  }
  const graphHandle = assets.create(graphResult.value).unwrap();

  // Instantiate Fox scene + find the Skin-bearing entity.
  const instRes = assets.instantiate(sceneHandle, world);
  if (!instRes.ok) {
    console.error('[animation-graph] instantiate failed:', (instRes.error as { code: string }).code);
    return;
  }
  const root = instRes.value;

  const parentRig = world
    .spawn({ component: Transform, data: { pos: [0, 1, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } })
    .unwrap();
  world.addComponent(root, { component: ChildOf, data: { parent: parentRig } });

  const inst = world.get(root, SceneInstance);
  if (!inst.ok) {
    console.error('[animation-graph] root has no SceneInstance');
    return;
  }
  let hasSkin = false;
  const animationTargets: EntityHandle[] = [];
  for (let i = 0; i < inst.value.mapping.length; i++) {
    const entRaw = inst.value.mapping[i];
    if (entRaw === undefined || entRaw === ENTITY_NULL_RAW) continue;
    const ent = entRaw as EntityHandle;
    if (world.get(ent, AnimationTargetId).ok) animationTargets.push(ent);
    if (world.get(ent, Skin).ok) hasSkin = true;
  }
  if (!hasSkin) {
    console.error('[animation-graph] no Skin entity in instantiated scene');
    return;
  }
  // Assign AnimationPlayer with graph handle.
    // nodeWeights default to 1 per node (evaluateAnimationGraph falls back to 1
    // when nodeWeights[i] is out of range), so an empty array is a valid start.
    // We write a full 7-element nodeWeights to make the keyboard-driven params
    // explicit and discoverable. nodeSpeeds drives per-node time advancement;
    // default 0 means eval uses the fallback 0 speed, so we set non-zero for the
    // clip leaves we want to animate.
    //
    // Initial params: locomotion=0.5, walkRunRatio=0.5, overlayOn=false.
  world.addComponent(root, {
      component: AnimationPlayer,
      data: {
        graph: graphHandle,
        // nodeWeights[i] = runtime weight for node i (multiplied by static weight).
        // locomotion=0.5: nodeWeights[0]=0.5 (Survey), nodeWeights[3]=0.5 (walkRunBlend)
        // walkRunRatio=0.5: nodeWeights[1]=0.5 (Walk), nodeWeights[2]=0.5 (Run)
        // overlayOn=false: nodeWeights[5]=0 (overlayLeaf off)
        nodeWeights: new Float32Array([0.5, 0.5, 0.5, 0.5, 1, 0, 1]),
        // nodeSpeeds: advance rate for each node's per-node time.
        // Clip leaves (0,1,2,5) advance at speed 1; blend/add internal nodes ignored.
        nodeSpeeds: new Float32Array([1, 1, 1, 0, 0, 1, 0]),
        looping: true,
      },
  });
  const playerEnt = root as EntityHandle;
  const bound = bindAnimationTargets(world, playerEnt, animationTargets);
  if (!bound.ok) {
    console.error(
      '[animation-graph] bindAnimationTargets failed:',
      bound.error.code,
      bound.error.detail,
    );
    return;
  }

  // Camera + light matching Fox.glb authored-in-cm proportions.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 35, 280] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 1, far: 500 }),
          clearColor: [0.05, 0.08, 0.12, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
    })
    .unwrap();

  // Mutable parameter state owned by the keyboard system.
  let locomotion = 0.5;
  let walkRunRatio = 0.5;
  let overlayOn = false;
  let paused = false;
  const STEP = 0.05;

  // Press-edge tracking for held-key params (A/D/W/S) and toggle-edge (O/Space).
  let prevA = false;
  let prevD = false;
  let prevW = false;
  let prevS = false;
  let prevO = false;
  let prevSpace = false;

  const hudEl = document.getElementById('ag-hud');

  // Helper: rewrite nodeWeights from current param values and optionally update HUD.
  const applyParams = (ent: EntityHandle): void => {
    // Clamp params to [0, 1].
    locomotion = Math.min(1, Math.max(0, locomotion));
    walkRunRatio = Math.min(1, Math.max(0, walkRunRatio));
    // nodeWeights[i] for each node (7 nodes, indices 0-6):
    //   0: surveyBase  -> 1 - locomotion
    //   1: walkLeaf    -> 1 - walkRunRatio
    //   2: runLeaf     -> walkRunRatio
    //   3: walkRunBlend-> locomotion
    //   4: baseBlend   -> 1 (fixed, Blend node weight)
    //   5: overlayLeaf -> overlayOn ? 1 : 0
    //   6: root Add    -> 1 (fixed)
    world.set(ent, AnimationPlayer, {
      paused,
      nodeWeights: new Float32Array([
        1 - locomotion,
        1 - walkRunRatio,
        walkRunRatio,
        locomotion,
        1,
        overlayOn ? 1 : 0,
        1,
      ]),
    });
  };

  // ag-graph-keyboard system: reads input each frame and updates nodeWeights.
  // Runs after input-frame-start-scan, before animation eval.
  // Only nodeWeights are written -- weights[] is NEVER touched directly.
  world.addSystem(Update, {
    name: 'ag-graph-keyboard',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);

      if (snap !== undefined) {
        let changed = false;
        const curA = snap.keyboard.down('a') || snap.keyboard.down('A') || snap.keyboard.down('ArrowLeft');
        const curD = snap.keyboard.down('d') || snap.keyboard.down('D') || snap.keyboard.down('ArrowRight');
        const curW = snap.keyboard.down('w') || snap.keyboard.down('W') || snap.keyboard.down('ArrowUp');
        const curS = snap.keyboard.down('s') || snap.keyboard.down('S') || snap.keyboard.down('ArrowDown');
        const curO = snap.keyboard.down('o') || snap.keyboard.down('O');
        const curSpace = snap.keyboard.down(' ');

        if (curA && !prevA) { locomotion -= STEP; changed = true; }
        if (curD && !prevD) { locomotion += STEP; changed = true; }
        if (curW && !prevW) { walkRunRatio -= STEP; changed = true; }
        if (curS && !prevS) { walkRunRatio += STEP; changed = true; }
        if (curO && !prevO) { overlayOn = !overlayOn; changed = true; }
        if (curSpace && !prevSpace) { paused = !paused; changed = true; }

        prevA = curA;
        prevD = curD;
        prevW = curW;
        prevS = curS;
        prevO = curO;
        prevSpace = curSpace;

        if (changed) applyParams(playerEnt!);
      }

      // HUD refreshes every frame regardless of input availability.
      // weights[] change each frame as animations advance in nodeTimes.
      refreshHud(hudEl, world, playerEnt!, { locomotion, walkRunRatio, overlayOn, paused });
    },
  });

  // Kick initial HUD render on the first frame.
  applyParams(playerEnt);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[animation-graph] app.start() failed:', startRes.error);
    return;
  }
  console.log('[animation-graph] ready -- keyboard: [A/D] locomotion  [W/S] walkRunRatio  [O] overlay  [Space] pause');
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
