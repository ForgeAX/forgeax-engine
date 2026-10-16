import type { App } from '@forgeax/engine-app';
import type { GpuPassTimingObservation } from '@forgeax/engine-render';

/** Opt-in pass-boundary GPU measurements; never substitute CPU wall time. */
export async function measureSsao(
  app: App,
  capture: () => Promise<Uint8Array>,
  timing: () => GpuPassTimingObservation | undefined,
) {
  const profile = app.renderer.inspect().profile;
  const rows = [];
  const percentile = (values: number[], fraction: number) =>
    [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
  try {
    for (const quality of ['off', 'low', 'medium', 'high'] as const) {
      const installed = app.renderer.setProfile({
        ...profile,
        ssao: quality === 'off' ? false : { quality, radius: 0.5, intensity: 1 },
      });
      if (!installed.ok) throw installed.error;
      for (let i = 0; i < 15; i++) await capture();
      const calc: number[] = [],
        blur: number[] = [];
      let maxBindGroups = 0;
      for (let i = 0; i < 60; i++) {
        await capture();
        const observation = timing();
        if (observation?.status !== 'complete')
          throw new Error(`GPU timings unavailable: ${JSON.stringify(observation)}`);
        const passes = observation.frame.passes.filter((p) => p.passName.startsWith('ssao-'));
        if (passes.length !== (quality === 'off' ? 0 : 2))
          throw new Error('AO work disagrees with the selected profile');
        for (const pass of passes) {
          if (pass.status !== 'measured') throw new Error(`AO pass unmeasured: ${pass.passName}`);
          (pass.passName === 'ssao-calc' ? calc : blur).push(pass.durationNanoseconds / 1e6);
        }
        maxBindGroups = Math.max(
          maxBindGroups,
          app.renderer.inspect().bindGroupCounts.createBindGroup,
        );
      }
      rows.push({
        quality,
        frames: 60,
        maxBindGroups,
        calcMs: { p50: percentile(calc, 0.5), p95: percentile(calc, 0.95) },
        blurMs: { p50: percentile(blur, 0.5), p95: percentile(blur, 0.95) },
      });
    }
    return {
      rows,
      totalSubmittedFrames: 300,
      measurement: 'GPU pass boundaries; overlapping durations are not additive',
    };
  } finally {
    const restored = app.renderer.setProfile(profile);
    if (!restored.ok) throw restored.error;
    await capture();
  }
}
