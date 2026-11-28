import assert from 'node:assert/strict';

const read = 'vc-ue5.cloud';
const part = (play, name) => play.page.locator(`[data-ui-part="${name}"]`);

function adopted(state, mode, afterFrame = 0) {
  const frame = state.completed;
  return state.mode === mode && frame &&
    Object.values(state.renderer?.layer ?? {}).some(({ resourceStage, mode0 }) =>
      resourceStage === 'accepted' &&
      mode0?.deviceGeneration === frame.deviceGeneration &&
      mode0.acceptedFrame > afterFrame &&
      mode0.acceptedFrame <= frame.frameId);
}

async function waitSettledFrames(play, mode, minFrames = 6) {
  const start = await play.state(read);
  const baseFrame = start.completed?.frameId ?? 0;
  return play.waitFor(
    state => adopted(state, mode, baseFrame + minFrames),
    { read, timeoutMs: 30000 },
  );
}

async function scrubSunElevation(play, degrees) {
  const number = part(play, 'sun-elevation-number');
  await number.scrollIntoViewIfNeeded();
  await number.fill(String(degrees));
  await number.press('Enter');
  await play.waitFor(state => Math.abs(state.sunElevation - degrees) < 1e-3, { read, timeoutMs: 15000 });
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function daytimeTransform(play) {
  await play.page.locator('html[data-forgeax-input="open"]').waitFor();
  const initial = await play.waitFor(state => adopted(state, 'shape'), { read, timeoutMs: 30000 });
  assert.equal(initial.daytime.active, false);

  const baselineLighting = {
    sunAzimuth: initial.sunAzimuth,
    sunIlluminanceLux: initial.sunIlluminanceLux,
    exposure: initial.exposure,
    phaseG: initial.phaseG,
    phaseG2: initial.phaseG2,
    phaseBlend: initial.phaseBlend,
  };
  const assertLightingUnchanged = (state, label) => {
    for (const [key, expected] of Object.entries(baselineLighting)) {
      assert.ok(Math.abs(state[key] - expected) < 1e-5, `${label}: ${key} drifted (${state[key]} vs ${expected})`);
    }
    assert.equal(state.useDetail, false, `${label}: useDetail must stay constant`);
  };

  const shots = [];
  const observations = {};

  await play.step('Enable daytime transform on sample-ue and verify live solar + wind progression', async () => {
    await play.page.locator('[data-ui-action="daytime-toggle"]').click();
    const started = await play.waitFor(
      state => state.daytime.active && state.daytime.playing && state.mode === 'sample-ue',
      { read, timeoutMs: 20000 },
    );
    assertLightingUnchanged(started, 'start');
    const wind0 = started.windOffsetMeters;
    const elev0 = started.sunElevation;
    const progressed = await play.waitFor(
      state => state.sunElevation > elev0 + 0.5 &&
        Math.hypot(
          state.windOffsetMeters[0] - wind0[0],
          state.windOffsetMeters[1] - wind0[1],
          state.windOffsetMeters[2] - wind0[2],
        ) > 50,
      { read, timeoutMs: 15000 },
    );
    assertLightingUnchanged(progressed, 'progressed');
    await play.page.locator('[data-ui-action="daytime-play"]').click();
    await play.waitFor(state => state.daytime.active && !state.daytime.playing, { read });
  });

  const stageChecks = [
    { name: 'daytime-01-dawn-m4', jump: 'dawn', elevation: -4 },
    { name: 'daytime-02-sunrise-8', scrub: 8, elevation: 8 },
    { name: 'daytime-03-morning-18', jump: 'morning', elevation: 18 },
    { name: 'daytime-04-morning-30', scrub: 30, elevation: 30 },
    { name: 'daytime-05-transition-52', scrub: 52.5, elevation: 52.5 },
    { name: 'daytime-06-noon-90', jump: 'noon', elevation: 90 },
    { name: 'daytime-07-transition-138', scrub: 137.5, elevation: 137.5 },
    { name: 'daytime-08-sunset-170', jump: 'sunset', elevation: 170 },
    { name: 'daytime-09-sunset-176', scrub: 176, elevation: 176 },
    { name: 'daytime-10-sunset-180', scrub: 180, elevation: 180 },
  ];

  for (const check of stageChecks) {
    await play.step(`Capture ${check.name} at ${check.elevation} deg`, async () => {
      if (check.jump) {
        await play.page.locator(`[data-ui-action="daytime-jump"][data-stage="${check.jump}"]`).click();
        await play.waitFor(state => Math.abs(state.sunElevation - check.elevation) < 1e-3, { read });
      } else {
        await scrubSunElevation(play, check.scrub);
      }
      const settled = await waitSettledFrames(play, 'sample-ue', 8);
      assertLightingUnchanged(settled, check.name);
      observations[check.name] = {
        sunElevation: settled.sunElevation,
        stage: settled.daytime.stage.label,
        bottomMeters: settled.bottomMeters,
        thicknessMeters: settled.thicknessMeters,
        extinctionPerMeter: settled.extinctionPerMeter,
        coverageBias: settled.coverageBias,
        layoutWeight: settled.layoutWeight,
        maskWeight: settled.maskWeight,
        profileWeight: settled.profileWeight,
        bodyWeight: settled.bodyWeight,
        erosionWeight: settled.erosionWeight,
        wind: [settled.windX, settled.windY, settled.windZ],
      };
      const shot = await play.screenshot(check.name);
      assert.equal(shot.rendered, true);
      shots.push({ name: check.name, path: shot.path });
    });
  }

  let transitionResetReasons = [];
  await play.step('Observe Mode 0 history behavior during continuous transition band playback', async () => {
    await scrubSunElevation(play, 45);
    await play.page.locator('[data-ui-action="daytime-speed"][data-speed="2"]').click();
    await play.page.locator('[data-ui-action="daytime-play"]').click();
    const mid = await play.waitFor(state => state.sunElevation > 47, { read, timeoutMs: 15000 });
    const layers = Object.values(mid.renderer?.layer ?? {});
    transitionResetReasons = layers.flatMap(entry => entry.mode0?.resetReasons ?? []);
    await play.page.locator('[data-ui-action="daytime-play"]').click();
    await play.waitFor(state => !state.daytime.playing, { read });
  });

  await play.step('Stop at 180 degrees without wrapping and replay from -4 on demand', async () => {
    await play.page.locator('[data-ui-action="daytime-speed"][data-speed="4"]').click();
    await scrubSunElevation(play, 177.5);
    await play.page.locator('[data-ui-action="daytime-play"]').click();
    const ended = await play.waitFor(
      state => state.daytime.completed && !state.daytime.playing && Math.abs(state.sunElevation - 180) < 1e-3,
      { read, timeoutMs: 15000 },
    );
    assert.equal(await part(play, 'daytime-play').textContent(), '重播');
    await play.page.waitForTimeout(400);
    const stillAtEnd = await play.state(read);
    assert.ok(Math.abs(stillAtEnd.sunElevation - 180) < 1e-3, 'Must not wrap back to -4');
    assert.equal(stillAtEnd.daytime.playing, false);
    assertLightingUnchanged(ended, 'ended');

    await play.page.locator('[data-ui-action="daytime-play"]').click();
    const replayed = await play.waitFor(
      state => state.daytime.playing && state.sunElevation < 10,
      { read, timeoutMs: 10000 },
    );
    assert.equal(replayed.daytime.completed, false);
  });

  await play.step('Allow switching cloud asset while active and auto-exit on manual driven edit', async () => {
    await play.page.locator('[data-ui-action="cloud-shape"]').click();
    const switched = await play.waitFor(state => state.mode === 'shape' && state.daytime.active, { read, timeoutMs: 15000 });
    assert.equal(switched.daytime.active, true);
    await play.page.locator('[data-ui-action="cloud-sample-ue"]').click();
    await play.waitFor(state => state.mode === 'sample-ue' && state.daytime.active, { read, timeoutMs: 15000 });

    await part(play, 'cloud-thickness').fill('3333');
    const exited = await play.waitFor(state => !state.daytime.active && state.thicknessMeters === 3333, { read, timeoutMs: 10000 });
    assert.equal(exited.daytime.playing, false);
    assert.match(await part(play, 'cloud-status').textContent(), /自动退出白昼变换/);
  });

  return { shots, observations, transitionResetReasons };
}
