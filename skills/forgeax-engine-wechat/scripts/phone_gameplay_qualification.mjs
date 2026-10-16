const median = (values) =>
  values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

export function summarizePhoneGameplaySamples(samples, phases, startMs, baselineHeight) {
  const rows = phases.map((phase) => {
    const selected = samples.filter(
      (sample) => sample.atMs >= startMs + phase.startMs && sample.atMs < startMs + phase.endMs,
    );
    let distance = 0,
      yawTravel = 0,
      maximumGapMs = 0;
    const speeds = [];
    for (let index = 1; index < selected.length; index++) {
      const a = selected[index - 1],
        b = selected[index],
        gap = b.atMs - a.atMs;
      if (!(gap > 0)) throw new Error('Gameplay samples must advance');
      const movement = Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]);
      distance += movement;
      speeds.push((movement * 1000) / gap);
      yawTravel += Math.abs(Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)));
      maximumGapMs = Math.max(maximumGapMs, gap);
    }
    return {
      name: phase.name,
      samples: selected.length,
      distance,
      medianSpeed: median(speeds),
      maximumSpeed: speeds.length ? Math.max(...speeds) : null,
      maximumGapMs,
      movingSamples: selected.filter(
        (sample) =>
          Math.abs(sample.controls.horizontal) + Math.abs(sample.controls.vertical) > 0.05,
      ).length,
      runningSamples: selected.filter((sample) => sample.controls.run).length,
      airborneSamples: selected.filter((sample) => !sample.grounded).length,
      maximumHeight: selected.length
        ? Math.max(...selected.map((sample) => sample.position[1]))
        : null,
      yawTravel,
      readCostMs: {
        median: median(selected.map((sample) => sample.readMs)),
        maximum: selected.length ? Math.max(...selected.map((sample) => sample.readMs)) : null,
      },
    };
  });
  const [walk, run, jump, runJump] = rows;
  const evidence = {
    walking: !!walk && walk.movingSamples >= 2 && walk.medianSpeed > 0.05,
    running:
      !!run &&
      run.runningSamples >= 2 &&
      run.movingSamples >= 2 &&
      run.medianSpeed > walk.medianSpeed * 1.1,
    jumping: !!jump && jump.airborneSamples >= 2 && jump.maximumHeight > baselineHeight + 0.1,
    runningJumping:
      !!runJump &&
      runJump.runningSamples >= 2 &&
      runJump.movingSamples >= 2 &&
      runJump.airborneSamples >= 2 &&
      runJump.maximumHeight > baselineHeight + 0.1,
    camera: rows.length === 4 && rows.every((row) => row.yawTravel > 0.01),
    coverage: rows.length === 4 && rows.every((row) => row.samples >= 5 && row.maximumGapMs <= 500),
  };
  return {
    success: Object.values(evidence).every(Boolean),
    evidence,
    phases: rows,
    runToWalkMedianSpeed: walk?.medianSpeed > 0 ? run.medianSpeed / walk.medianSpeed : null,
  };
}

/** Separate intrusive run: public player reads at most 10 Hz, never the clean FPS window. */
export async function collectPhoneGameplayQualification({
  read,
  now,
  wait,
  startMs,
  endMs,
  phases,
  baselineHeight,
}) {
  const samples = [];
  let failure = null;
  try {
    while (now() < endMs && samples.length < 1201) {
      await wait(Math.max(0, startMs - now()));
      const began = now(),
        player = await read(),
        atMs = now();
      if (atMs >= endMs) break;
      if (
        !Array.isArray(player?.position) ||
        player.position.length !== 3 ||
        !player.position.every(Number.isFinite) ||
        typeof player.grounded !== 'boolean' ||
        !Number.isFinite(player.camera?.yaw) ||
        !Number.isFinite(player.controls?.horizontal) ||
        !Number.isFinite(player.controls?.vertical) ||
        typeof player.controls.run !== 'boolean'
      )
        throw new Error('Public player projection is incomplete');
      samples.push({
        atMs,
        readMs: atMs - began,
        position: [...player.position],
        grounded: player.grounded,
        yaw: player.camera.yaw,
        controls: {
          horizontal: player.controls.horizontal,
          vertical: player.controls.vertical,
          run: player.controls.run,
        },
        fixedTick: player.simulation?.fixedTick ?? null,
      });
      const next = startMs + (Math.floor((now() - startMs) / 100) + 1) * 100;
      await wait(Math.max(1, Math.min(endMs, next) - now()));
    }
  } catch (error) {
    failure = String(error);
  }
  const summary = summarizePhoneGameplaySamples(samples, phases, startMs, baselineHeight);
  return {
    schemaVersion: 'forgeax-phone-gameplay-qualification/1',
    diagnosticOnly: true,
    cleanFpsEvidence: false,
    intervalMs: 100,
    failure,
    ...summary,
    success: !failure && summary.success,
    samples,
    scope:
      'Observed player positions, grounded state, run controls and camera yaw under native input. Sparse reads perturb this diagnostic; no FPS acceptance.',
  };
}
