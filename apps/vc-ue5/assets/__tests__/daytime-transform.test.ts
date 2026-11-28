import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validateCloudEdit } from '../cloud-controls.ts';
import {
  DAYTIME_CLOUD_PROFILES,
  DAYTIME_DEFAULT_MATERIAL_MODE,
  DAYTIME_DRIVEN_PARAMETER_KEYS,
  DAYTIME_DURATION_SECONDS,
  DAYTIME_MAX_ELEVATION,
  DAYTIME_MIN_ELEVATION,
  DAYTIME_SPEEDS,
  DAYTIME_STAGE_ANCHORS,
  DAYTIME_STAGE_IDS,
  describeDaytimeStage,
  evaluateDaytimeParameters,
  readDaytimeSpeed,
  readDaytimeStage,
  stepDaytimeElevation,
  touchesDaytimeDrivenParameter,
} from '../daytime-transform.ts';
import { cloudParameterLabels } from '../parameter-labels.ts';

it('restricts daytime-driven parameters to layer, motion and density controls with valid ranges', () => {
  assert.equal(DAYTIME_DEFAULT_MATERIAL_MODE, 'sample-ue');
  assert.equal(DAYTIME_MIN_ELEVATION, -4);
  assert.equal(DAYTIME_MAX_ELEVATION, 180);
  assert.equal(DAYTIME_DURATION_SECONDS, 120);

  const allowedGroups = new Set(['layer', 'motion', 'density']);
  for (const key of DAYTIME_DRIVEN_PARAMETER_KEYS) {
    assert.ok(allowedGroups.has(cloudParameterLabels[key].group), `${key} must stay in layer/motion/density`);
  }
  for (const elevation of [-90, -4, 0, 18, 40, 52.5, 65, 90, 125, 137.5, 150, 170, 180, 190]) {
    const params = evaluateDaytimeParameters(elevation);
    assert.deepEqual(validateCloudEdit(params), { edit: params });
    assert.equal(params.useDetail, false);
    assert.equal(Object.keys(params).length, DAYTIME_DRIVEN_PARAMETER_KEYS.length);
  }
});

it('matches the three stage standards and blends smoothly across transition bands', () => {
  assert.deepEqual(evaluateDaytimeParameters(-4), DAYTIME_CLOUD_PROFILES.morning);
  assert.deepEqual(evaluateDaytimeParameters(18), DAYTIME_CLOUD_PROFILES.morning);
  assert.deepEqual(evaluateDaytimeParameters(40), DAYTIME_CLOUD_PROFILES.morning);
  assert.deepEqual(evaluateDaytimeParameters(65), DAYTIME_CLOUD_PROFILES.noon);
  assert.deepEqual(evaluateDaytimeParameters(90), DAYTIME_CLOUD_PROFILES.noon);
  assert.deepEqual(evaluateDaytimeParameters(125), DAYTIME_CLOUD_PROFILES.noon);
  assert.deepEqual(evaluateDaytimeParameters(150), DAYTIME_CLOUD_PROFILES.sunset);
  assert.deepEqual(evaluateDaytimeParameters(170), DAYTIME_CLOUD_PROFILES.sunset);
  assert.deepEqual(evaluateDaytimeParameters(180), DAYTIME_CLOUD_PROFILES.sunset);

  // Midpoints of both smoothstep bands sit cleanly halfway between adjacent profiles.
  const midMorningNoon = evaluateDaytimeParameters(52.5);
  assert.equal(
    midMorningNoon.bottomMeters,
    (DAYTIME_CLOUD_PROFILES.morning.bottomMeters + DAYTIME_CLOUD_PROFILES.noon.bottomMeters) / 2,
  );
  assert.equal(
    midMorningNoon.thicknessMeters,
    (DAYTIME_CLOUD_PROFILES.morning.thicknessMeters + DAYTIME_CLOUD_PROFILES.noon.thicknessMeters) / 2,
  );
  const midNoonSunset = evaluateDaytimeParameters(137.5);
  assert.equal(
    midNoonSunset.bottomMeters,
    (DAYTIME_CLOUD_PROFILES.noon.bottomMeters + DAYTIME_CLOUD_PROFILES.sunset.bottomMeters) / 2,
  );
  assert.equal(
    midNoonSunset.thicknessMeters,
    (DAYTIME_CLOUD_PROFILES.noon.thicknessMeters + DAYTIME_CLOUD_PROFILES.sunset.thicknessMeters) / 2,
  );

  // Stage morphological separation: morning thin sheet < sunset high broken < noon stratocumulus thickness.
  assert.ok(DAYTIME_CLOUD_PROFILES.morning.thicknessMeters < DAYTIME_CLOUD_PROFILES.sunset.thicknessMeters);
  assert.ok(DAYTIME_CLOUD_PROFILES.sunset.thicknessMeters < DAYTIME_CLOUD_PROFILES.noon.thicknessMeters);
  assert.ok(DAYTIME_CLOUD_PROFILES.noon.bottomMeters < DAYTIME_CLOUD_PROFILES.morning.bottomMeters);
  assert.ok(DAYTIME_CLOUD_PROFILES.morning.bottomMeters < DAYTIME_CLOUD_PROFILES.sunset.bottomMeters);
  assert.ok(DAYTIME_CLOUD_PROFILES.morning.erosionWeight < DAYTIME_CLOUD_PROFILES.noon.erosionWeight);
  assert.ok(DAYTIME_CLOUD_PROFILES.noon.erosionWeight < DAYTIME_CLOUD_PROFILES.sunset.erosionWeight);
});

it('advances from -4 to 180 in 120 seconds without wrapping around', () => {
  let elevation = DAYTIME_MIN_ELEVATION;
  for (let i = 0; i < 119; i++) {
    const step = stepDaytimeElevation(elevation, 1, 1);
    assert.equal(step.completed, false);
    assert.ok(step.elevation > elevation);
    elevation = step.elevation;
  }
  const finalStep = stepDaytimeElevation(elevation, 1, 1);
  assert.equal(finalStep.elevation, DAYTIME_MAX_ELEVATION);
  assert.equal(finalStep.completed, true);

  // Further ticks remain clamped at 180 degrees rather than wrapping to -4.
  const clamped = stepDaytimeElevation(finalStep.elevation, 10, 4);
  assert.equal(clamped.elevation, DAYTIME_MAX_ELEVATION);
  assert.equal(clamped.completed, true);

  // 2x speed completes the full -4..180 sweep in 60 seconds.
  const fast = stepDaytimeElevation(DAYTIME_MIN_ELEVATION, 60, 2);
  assert.equal(fast.elevation, DAYTIME_MAX_ELEVATION);
  assert.equal(fast.completed, true);
});

it('describes stages, validates controls and detects manual edits to driven fields', () => {
  assert.equal(describeDaytimeStage(-4).id, 'dawn');
  assert.equal(describeDaytimeStage(-4).progress, 0);
  assert.equal(describeDaytimeStage(18).id, 'morning');
  assert.equal(describeDaytimeStage(52).transitioning, true);
  assert.equal(describeDaytimeStage(90).id, 'noon');
  assert.equal(describeDaytimeStage(138).transitioning, true);
  assert.equal(describeDaytimeStage(170).id, 'sunset');
  assert.equal(describeDaytimeStage(180).progress, 1);

  for (const speed of DAYTIME_SPEEDS) assert.equal(readDaytimeSpeed(speed), speed);
  assert.equal(readDaytimeSpeed(3), undefined);
  assert.equal(readDaytimeSpeed('1'), undefined);

  for (const id of DAYTIME_STAGE_IDS) assert.equal(readDaytimeStage(id), DAYTIME_STAGE_ANCHORS[id]);
  assert.equal(readDaytimeStage('__proto__'), undefined);

  assert.equal(touchesDaytimeDrivenParameter({ thicknessMeters: 2000 }), true);
  assert.equal(touchesDaytimeDrivenParameter({ windX: 100 }), true);
  assert.equal(touchesDaytimeDrivenParameter({ coverageBias: -0.1 }), true);
  assert.equal(touchesDaytimeDrivenParameter({ exposure: 0.0003, phaseG: 0.5, viewBlueNoise: true }), false);
});
