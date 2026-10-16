#!/usr/bin/env node
// hello-animation-graph falsification counter-proof (feat-20260713-animation-state-machine-plugin M5 / w35).
//
// Falsification script: makes INTENTIONALLY WRONG assertions that MUST FAIL.
// A non-zero exit code from this script proves the smoke-dawn.mjs assertions
// are SENSITIVE (discriminatory) to the variables they test. If this script
// somehow exited 0 it would mean the wrong assertions passed -- i.e., the smoke
// is INSENSITIVE to the tested variable and therefore worthless.
//
// NOT in CI (plan-strategy §5.4). Run locally to confirm discriminatory power:
//   node apps/hello/animation-graph/scripts/smoke-falsify.mjs
//   # Expected: exits 1 (wrong assertions failed -- probe is load-bearing)
//
// Two falsification variants:
//   (A) overlay-off-assert-1.3: disable overlay, but assert sum IS 1.3.
//       Actual sum when overlay is off = 1.0 -> assertion FAILS -> confirms
//       smoke-dawn.mjs AC-05 assertion (sum=1.3 with overlay ON) has discriminatory power.
//   (B) locomotion-zero-assert-quarter: set locomotion=0 (all Survey), but assert
//       Walk=0.25 and Run=0.25. Actual: Walk=0, Run=0 -> assertions FAIL -> confirms
//       smoke-dawn.mjs AC-08 distributional assertions are sensitive to locomotion param.
//
// Expected exit: 1 (both variants fail as intended -> discriminatory power confirmed).
// Unexpected exit: 0 (a wrong assertion passed -> smoke is INSENSITIVE -> bug).

import process from 'node:process';

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { animationPlugin, defineAnimationGraph, AnimationPlayer } = await import('@forgeax/engine-animation');

let failCount = 0;
let unexpectedPassCount = 0;

async function makeWorld() {
  const clips = new Map();
  const world = new World();
  await createWorldContext(world, [animationPlugin((guid) => clips.get(guid))]);
  return { world, clips };
}

function registerClip(clips, duration) {
  const guid = `test/animation-clip-${clips.size}`;
  clips.set(guid, { kind: 'animation-clip', duration, channels: [] });
  return guid;
}

function readWeights(world, ent) {
  return world.get(ent, AnimationPlayer).unwrap().weights;
}

function buildFullDag(world, clips) {
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
  if (!gr.ok) throw new Error(`buildFullDag failed: ${gr.error.code}`);
  return world.allocSharedRef('AnimationGraph', gr.value);
}

// Intentional wrong assertion: expects `value` to equal `wrong` (which it should NOT).
// If the assertion FAILS (as expected), log OK and increment failCount.
// If the assertion PASSES (value actually == wrong), it means the variable has no effect.
function assertWrong(label, value, wrong, tolerance = 0.01) {
  const diff = Math.abs(value - wrong);
  if (diff <= tolerance) {
    // The wrong value matched -- the assertion would have incorrectly PASSED.
    process.stdout.write(
      `[falsify] UNEXPECTED-PASS - ${label}: got ${value.toFixed(6)}, wrongly asserted ${wrong} PASSED\n`,
    );
    unexpectedPassCount++;
  } else {
    // The wrong assertion correctly FAILED -- smoke is discriminatory.
    process.stdout.write(
      `[falsify] FAIL-AS-EXPECTED - ${label}: got ${value.toFixed(6)}, wrong-assert ${wrong} correctly rejected (diff=${diff.toFixed(6)})\n`,
    );
    failCount++;
  }
}

// --- Variant A: overlay OFF, assert sum IS 1.3 (wrong: actual = 1.0) ---

{
  const { world, clips } = await makeWorld();
  const graphH = buildFullDag(world, clips);
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
          0,   // 5: overlayLeaf -- DISABLED (overlay OFF)
          1,   // 6: root Add
        ]),
      },
    })
    .unwrap();
  world.update();
  const w = readWeights(world, ent);
  const total = [...w].reduce((a, v) => a + v, 0);
  // WRONG assertion: sum should be 1.3 (but overlay is off -> actual = 1.0)
  assertWrong('variant-A:overlay-off-assert-1.3', total, 1.3, 0.01);
}

// --- Variant B: locomotion=0, assert Walk=0.25 and Run=0.25 (wrong: actual = 0, 0) ---

{
  const { world, clips } = await makeWorld();
  const graphH = buildFullDag(world, clips);
  const ent = world
    .spawn({
      component: AnimationPlayer,
      data: {
        graph: graphH,
        nodeWeights: new Float32Array([
          1,   // 0: surveyBase  -- locomotion=0 -> all Survey
          0.5, // 1: walkLeaf
          0.5, // 2: runLeaf
          0,   // 3: walkRunBlend -- locomotion=0 -> disabled
          1,   // 4: baseBlend
          0,   // 5: overlayLeaf
          1,   // 6: root Add
        ]),
      },
    })
    .unwrap();
  world.update();
  const w = readWeights(world, ent);
  const walkWeight = w[1] ?? 0;
  const runWeight = w[2] ?? 0;
  // WRONG assertions: expect Walk=0.25 (actual=0) and Run=0.25 (actual=0)
  assertWrong('variant-B:fixed-locomotion-0-assert-walk-0.25', walkWeight, 0.25, 0.01);
  assertWrong('variant-B:fixed-locomotion-0-assert-run-0.25', runWeight, 0.25, 0.01);
}

// --- Final verdict ---

if (unexpectedPassCount > 0) {
  process.stderr.write(
    `[falsify] PROBLEM - ${unexpectedPassCount} wrong assertion(s) PASSED: smoke is insensitive to tested variable(s)\n`,
  );
  process.exit(0); // exit 0 is the BAD outcome (wrong assertions passed = insensitive smoke)
} else {
  // All wrong assertions failed as expected -- smoke HAS discriminatory power.
  process.stdout.write(
    `[falsify] CONFIRMED - ${failCount}/${failCount} wrong assertions correctly FAILED: smoke-dawn.mjs assertions are discriminatory\n`,
  );
  process.exit(1); // exit 1 is the EXPECTED outcome (wrong assertions all rejected)
}
