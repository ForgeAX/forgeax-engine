#!/usr/bin/env node
// hello-animation-graph headless numerical smoke (feat-20260713-animation-state-machine-plugin M5 / w34).
//
// Validates AnimationGraph DAG evaluation correctness via PURE NUMERICAL assertions --
// no WebGPU / GPU / dawn required. Uses World + animationPlugin + defineAnimationGraph
// directly (same pattern as the integration test in animation-graph-default-path).
//
// On this host (glibc 2.28) dawn-node is unavailable; the smoke targets DAG evaluation
// correctness only. The "dawn" suffix in the filename follows the hello-* smoke naming
// convention established by the fleet.
//
// Covered acceptance criteria:
//   AC-04: Blend(Walk@1, Run@1) -> weights ~= [0.5, 0.5]  (Blend normalizes)
//   AC-05: Add(base sum=1, additive@0.3) -> total sum ~= 1.3 (Add does not normalize)
//   AC-07: orthogonal product -- nodeWeights[leaf]*staticWeight = 0.5 * 0.4 = 0.2
//   AC-08: full DAG N-slot distribution -- Add(Blend(Survey,Blend(Walk,Run)), overlay@0.3)
//          with locomotion=0.5, walkRunRatio=0.5, overlayOn=true
//
// Output literals (grep-friendly for CI log inspection):
//   [smoke] case=<name> weights=<json> PASS
//   [smoke] PASS - N/N cases green

import process from 'node:process';

// --- 1. Import engine ECS + animation primitives ---

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { animationPlugin, defineAnimationGraph, AnimationPlayer } = await import('@forgeax/engine-animation');

// --- 2. Assertion helpers ---

const EPS = 1e-5;

function assertClose(label, actual, expected, tolerance = EPS) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    process.stderr.write(
      `[smoke] FAIL - ${label}: got ${actual.toFixed(6)}, expected ${expected.toFixed(6)}, diff=${diff.toFixed(6)} > tol=${tolerance}\n`,
    );
    process.exit(1);
  }
}

function assertWeights(label, weights, expected, tolerance = EPS) {
  if (weights.length !== expected.length) {
    process.stderr.write(
      `[smoke] FAIL - ${label}: weights.length=${weights.length} != expected.length=${expected.length}\n`,
    );
    process.exit(1);
  }
  for (let i = 0; i < expected.length; i++) {
    assertClose(`${label}[${i}]`, weights[i] ?? 0, expected[i] ?? 0, tolerance);
  }
  process.stdout.write(
    `[smoke] case=${label} weights=${JSON.stringify([...weights].map((w) => +w.toFixed(6)))} PASS\n`,
  );
}

// --- 3. World factory with animationPlugin ---

async function makeWorld() {
  const clips = new Map();
  const world = new World();
  await createWorldContext(world, [animationPlugin((guid) => clips.get(guid))]);
  return { world, clips };
}

function registerClip(clips, duration) {
  const guid = `test/animation-clip-${clips.size}`;
  const clip = { kind: 'animation-clip', duration, channels: [] };
  clips.set(guid, clip);
  return guid;
}

function readWeights(world, ent) {
  const apRes = world.get(ent, AnimationPlayer);
  if (!apRes.ok) throw new Error('[smoke] AnimationPlayer not found');
  return apRes.value.weights;
}

// --- 4. Case AC-04: Blend(Walk@1, Run@1) -> [0.5, 0.5] ---

{
  const { world, clips } = await makeWorld();
  const walk = registerClip(clips, 10);
  const run = registerClip(clips, 10);
  const gr = defineAnimationGraph((b) => b.blend([b.clip(walk), b.clip(run)]));
  if (!gr.ok) { process.stderr.write(`[smoke] FAIL - AC-04 graph build: ${gr.error.code}\n`); process.exit(1); }
  const graphH = world.allocSharedRef('AnimationGraph', gr.value);
  const ent = world.spawn({ component: AnimationPlayer, data: { graph: graphH } }).unwrap();
  world.update();
  assertWeights('AC-04:Blend-equal', readWeights(world, ent), [0.5, 0.5], 1e-5);
}

// --- 5. Case AC-05: Add(base sum=1, additive@0.3) -> total sum = 1.3 ---

{
  const { world, clips } = await makeWorld();
  const survey = registerClip(clips, 8);
  const overlay = registerClip(clips, 8);
  // base = single clip (effective weight 1); additive = clip with static weight 0.3.
  const gr = defineAnimationGraph((b) => {
    const baseLeaf = b.clip(survey);
    const additiveLeaf = b.clip(overlay, 0.3);
    return b.add(baseLeaf, [additiveLeaf]);
  });
  if (!gr.ok) { process.stderr.write(`[smoke] FAIL - AC-05 graph build: ${gr.error.code}\n`); process.exit(1); }
  const graphH = world.allocSharedRef('AnimationGraph', gr.value);
  const ent = world.spawn({ component: AnimationPlayer, data: { graph: graphH } }).unwrap();
  world.update();
  const w = readWeights(world, ent);
  // slot 0 = baseLeaf (effective 1), slot 1 = additiveLeaf (effective 0.3)
  assertClose('AC-05:base-weight', w[0] ?? 0, 1.0, 1e-5);
  assertClose('AC-05:additive-weight', w[1] ?? 0, 0.3, 1e-5);
  const total = (w[0] ?? 0) + (w[1] ?? 0);
  assertClose('AC-05:sum', total, 1.3, 1e-5);
  process.stdout.write(`[smoke] case=AC-05:Add-sum weights=${JSON.stringify([...w].map((v) => +v.toFixed(6)))} sum=${total.toFixed(6)} PASS\n`);
}

// --- 6. Case AC-07: orthogonal product 0.5 * 0.4 = 0.2 ---

{
  const { world, clips } = await makeWorld();
  const clip = registerClip(clips, 5);
  // Static weight 0.4 in graph; runtime nodeWeights[0]=0.5.
  const gr = defineAnimationGraph((b) => b.clip(clip, 0.4));
  if (!gr.ok) { process.stderr.write(`[smoke] FAIL - AC-07 graph build: ${gr.error.code}\n`); process.exit(1); }
  const graphH = world.allocSharedRef('AnimationGraph', gr.value);
  // nodeWeights[0] = 0.5 (runtime weight for the single clip node)
  const ent = world
    .spawn({
      component: AnimationPlayer,
      data: { graph: graphH, nodeWeights: new Float32Array([0.5]) },
    })
    .unwrap();
  world.update();
  const w = readWeights(world, ent);
  // effective = incoming(1) * runtimeWeight(0.5) * staticWeight(0.4) = 0.2
  assertClose('AC-07:orthogonal-product', w[0] ?? 0, 0.2, 1e-5);
  process.stdout.write(`[smoke] case=AC-07:orthogonal-product weights=${JSON.stringify([...w].map((v) => +v.toFixed(6)))} PASS\n`);
}

// --- 7. Case AC-08: full DAG N-slot distribution ---
//
// Graph: Add(base=Blend(Survey, Blend(Walk, Run)), additive=overlay@0.3)
// Params: locomotion=0.5, walkRunRatio=0.5, overlayOn=true
// Node indices:
//   0: surveyBase  clip (in outer Blend)
//   1: walkLeaf    clip (in inner Blend)
//   2: runLeaf     clip (in inner Blend)
//   3: walkRunBlend blend([1,2])
//   4: baseBlend   blend([0,3])
//   5: overlayLeaf clip(survey, weight=0.3)
//   6: root        add(4, [5])
//
// Expected per-slot effective weights (locomotion=0.5, walkRunRatio=0.5):
//   Total from base normalization (Blend normalizes all contributions to 1):
//     nodeWeights[0]=0.5 (surveyBase), nodeWeights[3]=0.5 (walkRunBlend)
//     outer Blend total = 0.5*1 + 0.5*1 = 1.0
//     surveyBase -> eff = (1/1.0) * 0.5 * 1 = 0.5
//     walkRunBlend -> eff = (1/1.0) * 0.5 * 1 = 0.5
//     inner Blend(Walk,Run): total = 0.5*1 + 0.5*1 = 1.0
//       Walk -> eff = (0.5/1.0) * 0.5 * 1 = 0.25
//       Run  -> eff = (0.5/1.0) * 0.5 * 1 = 0.25
//   Add additive: overlayLeaf eff = 1 * 1 * 0.3 = 0.3 (non-normalizing)
//
// Slot order (clip leaves in graph construction order):
//   slot 0 = surveyBase    -> 0.5
//   slot 1 = walkLeaf      -> 0.25
//   slot 2 = runLeaf       -> 0.25
//   slot 3 = overlayLeaf   -> 0.3
//   total sum = 0.5 + 0.25 + 0.25 + 0.3 = 1.3

{
  const { world, clips } = await makeWorld();
  const survey = registerClip(clips, 8);
  const walk = registerClip(clips, 12);
  const run = registerClip(clips, 7);
  const gr = defineAnimationGraph((b) => {
    const surveyBase = b.clip(survey);
    const walkLeaf = b.clip(walk);
    const runLeaf = b.clip(run);
    const walkRunBlend = b.blend([walkLeaf, runLeaf]);
    const baseBlend = b.blend([surveyBase, walkRunBlend]);
    const overlayLeaf = b.clip(survey, 0.3);
    return b.add(baseBlend, [overlayLeaf]);
  });
  if (!gr.ok) { process.stderr.write(`[smoke] FAIL - AC-08 graph build: ${gr.error.code}\n`); process.exit(1); }
  const graphH = world.allocSharedRef('AnimationGraph', gr.value);
  // locomotion=0.5 -> nodeWeights[0]=0.5(survey), nodeWeights[3]=0.5(walkRunBlend)
  // walkRunRatio=0.5 -> nodeWeights[1]=0.5(walk), nodeWeights[2]=0.5(run)
  // overlayOn -> nodeWeights[5]=1
  const ent = world
    .spawn({
      component: AnimationPlayer,
      data: {
        graph: graphH,
        nodeWeights: new Float32Array([
          0.5, // 0: surveyBase
          0.5, // 1: walkLeaf
          0.5, // 2: runLeaf
          0.5, // 3: walkRunBlend
          1,   // 4: baseBlend
          1,   // 5: overlayLeaf
          1,   // 6: root Add
        ]),
        looping: true,
      },
    })
    .unwrap();
  world.update();
  const w = readWeights(world, ent);
  // 4 clip leaves -> 4 slots
  if (w.length !== 4) {
    process.stderr.write(`[smoke] FAIL - AC-08: expected 4 slots, got ${w.length}\n`);
    process.exit(1);
  }
  assertClose('AC-08:survey-base', w[0] ?? 0, 0.5, 1e-5);
  assertClose('AC-08:walk', w[1] ?? 0, 0.25, 1e-5);
  assertClose('AC-08:run', w[2] ?? 0, 0.25, 1e-5);
  assertClose('AC-08:overlay', w[3] ?? 0, 0.3, 1e-5);
  const total = [...w].reduce((a, v) => a + v, 0);
  assertClose('AC-08:total-sum', total, 1.3, 1e-5);
  process.stdout.write(
    `[smoke] case=AC-08:full-DAG-distribution weights=${JSON.stringify([...w].map((v) => +v.toFixed(6)))} sum=${total.toFixed(6)} PASS\n`,
  );
}

// --- 8. Final verdict ---

process.stdout.write('[smoke] PASS - 4/4 cases green (AC-04 Blend-equal, AC-05 Add-sum, AC-07 orthogonal-product, AC-08 full-DAG)\n');
process.exit(0);
